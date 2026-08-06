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

/**
 * Tope de verdad, para el que eligió seguir después de los doce. No es una
 * regla del juego: es para que el estado no crezca sin freno si alguien tira
 * números a la bartola. Treinta deja terminar hasta al que va muy perdido —el
 * nivel `facil` del bot promedia 15,9— sin dejar la puerta abierta.
 */
export const TOPE_DURO = 30;

// El día corre en UTC−3 y no en UTC como el resto del proyecto. Con UTC el
// número cambiaría a las nueve de la noche de acá, en plena hora de jugar.
const DESFASE_MS = 3 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Margen para borrar el desafío después de que termina su día.
 *
 * En rigor no hace falta ninguno: apenas cambia el día el objeto ya no tiene
 * puerta. Va igual porque la alarma y el Worker no leen el mismo reloj, y
 * borrar un instante *antes* de tiempo sí se notaría.
 */
const MARGEN_MS = 1000 * 60 * 10;

/**
 * Cuánto se le da al que quedó jugando cuando cambió el día. Sin esto, el que
 * arranca 23:50 pierde seguro, y eso se lee como que algo se rompió y no como
 * una regla del juego. Solo alarga lo que quedó **sin terminar**.
 */
const GRACIA_MS = 1000 * 60 * 60 * 3;

/** La fecha de hoy en UTC−3, con la forma `2026-08-05`. */
export function fechaDeHoy(ahora = Date.now()) {
  return new Date(ahora - DESFASE_MS).toISOString().slice(0, 10);
}

/**
 * Cuándo termina el día `fecha`. Es exactamente el instante en que `fechaDeHoy`
 * empieza a devolver el día siguiente.
 *
 * Sirve para no dejar vivo lo que ya nadie puede abrir: el Worker enruta
 * siempre a la fecha de hoy, así que **el desafío de ayer no tiene puerta**.
 * Antes se borraba a las 48 h, y ese día de más era lugar ocupado sin que
 * nadie pudiera entrar.
 */
export function finDelDia(fecha) {
  return Date.parse(`${fecha}T00:00:00Z`) + DESFASE_MS + DIA_MS;
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

// Sin marca de creación: lo único que decide cuánto vive es su fecha, y esa ya
// está. Guardar además cuándo se creó invitaría a usarla para vencerlo, que es
// justo lo que estaba mal.
function nuevoReto(fecha) {
  return { fecha, intentos: [], terminado: false, gano: false, encontro: false, siguio: false };
}

/**
 * Al agotar los doce el desafío no termina: se pregunta. Es la misma decisión
 * que ofrece una sala cuando otro ya ganó —seguir por el gusto de encontrarlo—
 * y estaba en el juego desde el principio.
 *
 * Para los datos es lo que más cambia: un desafío perdido y abandonado solo
 * dice "necesitaba más de doce", que es una medición censurada. El que sigue
 * hasta encontrarlo deja el número entero.
 */
const debeDecidir = (e) => !e.terminado && !e.siguio && e.intentos.length >= TOPE_INTENTOS;

/**
 * Lo que ve el jugador. **El número solo sale cuando el reto terminó**, igual
 * que `revealed` en una sala: hasta entonces la respuesta lleva fijos y picas y
 * nada más. Mientras está decidiendo tampoco sale: todavía puede seguir.
 */
function vista(estado, numero) {
  return {
    fecha: estado.fecha,
    tope: TOPE_INTENTOS,
    topeDuro: TOPE_DURO,
    intentos: estado.intentos,
    terminado: estado.terminado,
    gano: estado.gano,
    encontro: estado.encontro,
    siguio: estado.siguio,
    decidiendo: debeDecidir(estado),
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

    /**
     * Un desafío de otro día se puede **continuar, nunca empezar**.
     *
     * Es toda la seguridad de la idea: si se pudiera empezar uno de ayer,
     * pedir esa fecha sería pedir un número que ya se sabe, y el tope de doce
     * no protegería nada. Como el objeto solo existe si esa persona ya había
     * arrancado, exigir que haya algo empezado alcanza.
     */
    const enCurso = this.estado?.fecha === fecha && !this.estado.terminado;
    if (url.searchParams.get('hoy') !== '1' && !enCurso) {
      return json({ error: 'Ese desafío ya terminó.', vencido: true }, 410);
    }

    const numero = await numeroDelDia(fecha, clave);

    // El objeto es por jugador y por día, así que su fecha no debería cambiar
    // nunca. Si cambió, es un objeto reciclado y lo que había no sirve.
    if (!this.estado || this.estado.fecha !== fecha) this.estado = nuevoReto(fecha);

    if (accion === 'estado') {
      await this.guardar();
      return json(vista(this.estado, numero));
    }

    if (accion === 'intento') {
      // Un solo POST para las dos cosas: el cuerpo dice si es un intento o la
      // decisión de después del tope. Se lee una sola vez porque el stream no
      // se puede volver a abrir.
      let body = null;
      try {
        body = await request.json();
      } catch {
        /* ilegible: cae como intento inválido */
      }
      if (typeof body?.seguir === 'boolean') return this.decidir(body.seguir, numero);
      return this.intento(String(body?.guess ?? ''), numero);
    }

    return json({ error: 'No encontrado.' }, 404);
  }

  async intento(guess, numero) {
    const e = this.estado;
    if (e.terminado) return json({ error: 'El desafío de hoy ya terminó para vos.' }, 409);
    if (debeDecidir(e)) {
      return json({ error: 'Elegí si seguís o ves el número.' }, 409);
    }
    if (!isValidSecret(guess)) {
      return json({ error: 'Tienen que ser 4 dígitos del 1 al 9, sin repetir.' }, 400);
    }

    const { fijos, picas } = scoreGuess(guess, numero);
    e.intentos.push({ guess, fijos, picas });

    if (fijos === 4) {
      e.terminado = true;
      e.encontro = true;
      // Ganar es sacarlo dentro de los doce. El que pidió seguir lo encuentra,
      // pero el desafío ya lo había perdido: son dos cosas distintas y por eso
      // se guardan por separado.
      e.gano = !e.siguio;
    } else if (e.siguio && e.intentos.length >= TOPE_DURO) {
      e.terminado = true;
    }

    if (e.terminado) this.registrar();
    await this.guardar();
    return json(vista(e, numero));
  }

  /** Después del tope: seguir hasta encontrarlo, o que se lo revelen. */
  async decidir(seguir, numero) {
    const e = this.estado;
    if (e.terminado) return json({ error: 'El desafío de hoy ya terminó para vos.' }, 409);
    if (!debeDecidir(e)) return json({ error: 'No hay nada que decidir ahora.' }, 409);

    if (seguir) e.siguio = true;
    else e.terminado = true;

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
   * la censura está en el tope y no en un punto que dependió del rival. Y con
   * `encontro` puede no haber censura en absoluto — ver abajo.
   */
  registrar() {
    const e = this.estado;
    const n = e.intentos.length;
    console.log(JSON.stringify({
      evento: 'partida', modo: 'reto', fecha: e.fecha, jugadores: 1, rondas: n,
      descuento: e.siguio,
      intentos: [{ quien: 'humano', n, gano: e.gano, encontro: e.encontro, ronda: e.encontro ? n : null }],
    }));

    if (!this.env.PARTIDAS) return;
    try {
      this.env.PARTIDAS.writeDataPoint({
        indexes: ['humano'],
        // `blob3` es el día del desafío, no el día en que se terminó. El
        // `timestamp` de la fila dice cuándo se escribió, y con las tres horas
        // de gracia uno del 5 se puede cerrar el 6: contarlo como del 6 movería
        // la partida de día. Va al final del esquema, como manda la regla.
        blobs: ['reto', 'humano', e.fecha],
        // `double7` es lo que separa "necesitaba más de doce" de "necesitaba
        // diecisiete": sin él, el que pierde y sigue hasta encontrarlo queda
        // indistinguible del que pierde y se va, y su número —que es un dato
        // completo, de los pocos— se desperdicia. Va al final, como manda la
        // regla del esquema.
        doubles: [n, e.gano ? 1 : 0, e.encontro ? n : 0, 1, n, e.siguio ? 1 : 0, e.encontro ? 1 : 0],
      });
    } catch (err) {
      // Igual que en una partida: un registro que se rompe no puede voltear el
      // desafío de nadie.
      console.log(`no se pudo registrar el reto: ${err?.message ?? err}`);
    }
  }

  async guardar() {
    await this.ctx.storage.put('reto', this.estado);
    // El terminado se va apenas cierra su día; el que quedó a medias se lleva
    // las tres horas de gracia. Como esto corre en cada pedido, cuando el
    // desafío se cierra la alarma se adelanta sola.
    const margen = this.estado.terminado ? MARGEN_MS : GRACIA_MS;
    await this.ctx.storage.setAlarm(finDelDia(this.estado.fecha) + margen);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.estado = null;
  }
}
