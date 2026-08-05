/**
 * El desafío del día: un jugador solo contra el número de hoy, con un tope de
 * intentos. No hay círculo ni rival, que es justo por lo que no vive adentro de
 * `GameRoom` — ahí el orden de `players` *es* el círculo, y un modo sin círculo
 * dejaría ese invariante hablando de un caso que ya no cubre.
 *
 * El porqué de cada decisión está en "El desafío del día", en docs/DECISIONES.md.
 */

import { TOTAL_SECRETOS, isValidSecret, permutacionSecreta, scoreGuess } from './game.js';

export const TOPE_INTENTOS = 12;

// El reto de ayer no le sirve a nadie, pero se deja pasar un día de más para
// que el que estaba jugando a la medianoche no pierda lo que llevaba.
const TTL_MS = 1000 * 60 * 60 * 48;

// El día corre en UTC−3 y no en UTC como el resto del proyecto. Con UTC el
// número cambiaría a las nueve de la noche de acá, en plena hora de jugar.
const DESFASE_MS = 3 * 60 * 60 * 1000;

/** La fecha de hoy en UTC−3, con la forma `2026-08-05`. */
export function fechaDeHoy(ahora = Date.now()) {
  return new Date(ahora - DESFASE_MS).toISOString().slice(0, 10);
}

/**
 * El número de un día.
 *
 * **Tiene que ser un hash con clave.** Con `SHA-256(fecha)` a secas cualquiera
 * con la fecha lo calcula en su casa: sería público aunque no viajara nunca al
 * cliente. La clave es lo único que hace que de la secuencia observada no se
 * deduzca la que sigue.
 *
 * Seis bytes alcanzan: 2^48 sobre 3024 deja el sesgo del módulo en nada, y
 * entra en un Number sin necesidad de BigInt.
 */
export async function numeroDelDia(fecha, clave) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(clave),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(fecha)));
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + mac[i];
  return permutacionSecreta(n % TOTAL_SECRETOS);
}

function nuevoReto(fecha) {
  const now = Date.now();
  return { fecha, creadoEn: now, intentos: [], terminado: false, gano: false };
}

/**
 * Lo que ve el jugador. **El número solo sale cuando el reto terminó**, igual
 * que `revealed` en una sala: hasta entonces la respuesta lleva fijos y picas y
 * nada más.
 */
function vista(estado, numero) {
  return {
    fecha: estado.fecha,
    tope: TOPE_INTENTOS,
    intentos: estado.intentos,
    terminado: estado.terminado,
    gano: estado.gano,
    numero: estado.terminado ? numero : null,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class RetoDelDia {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.estado = null;
    ctx.blockConcurrencyWhile(async () => {
      this.estado = (await ctx.storage.get('reto')) ?? null;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const accion = url.pathname.split('/').pop();
    const fecha = url.searchParams.get('fecha') ?? '';

    // La fecha la calcula el Worker, no el cliente. Si no viene es un error de
    // programación nuestro, no algo que alguien pueda provocar desde afuera.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return json({ error: 'Fecha inválida.' }, 400);

    const clave = this.env.RETO_CLAVE;
    // Sin clave el reto se apaga. Nunca cae a una derivación sin clave: eso
    // haría público el número del día sin que se note, que es peor que no
    // tener la función.
    if (!clave) return json({ error: 'El desafío del día no está disponible.' }, 503);

    const numero = await numeroDelDia(fecha, clave);

    // El objeto es por jugador y por día, así que su fecha no debería cambiar
    // nunca. Si cambió, es un objeto reciclado y lo que había no sirve.
    if (!this.estado || this.estado.fecha !== fecha) this.estado = nuevoReto(fecha);

    if (accion === 'estado') {
      await this.guardar();
      return json(vista(this.estado, numero));
    }

    if (accion === 'intento') {
      return this.intento(request, numero);
    }

    return json({ error: 'No encontrado.' }, 404);
  }

  async intento(request, numero) {
    const e = this.estado;
    if (e.terminado) return json({ error: 'El desafío de hoy ya terminó para vos.' }, 409);

    let guess = '';
    try {
      const body = await request.json();
      guess = String(body?.guess ?? '');
    } catch {
      /* body ilegible: cae en la validación de abajo */
    }
    if (!isValidSecret(guess)) {
      return json({ error: 'Tienen que ser 4 dígitos del 1 al 9, sin repetir.' }, 400);
    }

    const { fijos, picas } = scoreGuess(guess, numero);
    e.intentos.push({ guess, fijos, picas });

    if (fijos === 4) {
      e.terminado = true;
      e.gano = true;
    } else if (e.intentos.length >= TOPE_INTENTOS) {
      e.terminado = true;
    }

    if (e.terminado) this.registrar();
    await this.guardar();
    return json(vista(e, numero));
  }

  /**
   * Una fila, con `blob1 = 'reto'` para poder correr la calibración con los
   * retos y sin ellos. El esquema es el mismo que el de las partidas, que está
   * en "Qué es cada columna" (docs/DECISIONES.md): acá no se reordena nada.
   *
   * Lo que este registro tiene y el del uno contra uno no: cuando `gano` es 0,
   * la censura está en el tope y no en un punto que dependió del rival.
   */
  registrar() {
    const e = this.estado;
    const n = e.intentos.length;
    console.log(JSON.stringify({
      evento: 'partida', modo: 'reto', jugadores: 1, rondas: n, descuento: false,
      intentos: [{ quien: 'humano', n, gano: e.gano, ronda: e.gano ? n : null }],
    }));

    if (!this.env.PARTIDAS) return;
    try {
      this.env.PARTIDAS.writeDataPoint({
        indexes: ['humano'],
        blobs: ['reto', 'humano'],
        doubles: [n, e.gano ? 1 : 0, e.gano ? n : 0, 1, n, 0],
      });
    } catch (err) {
      // Igual que en una partida: un registro que se rompe no puede voltear el
      // desafío de nadie.
      console.log(`no se pudo registrar el reto: ${err?.message ?? err}`);
    }
  }

  async guardar() {
    await this.ctx.storage.put('reto', this.estado);
    await this.ctx.storage.setAlarm(this.estado.creadoEn + TTL_MS);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.estado = null;
  }
}
