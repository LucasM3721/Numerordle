/**
 * Worker de entrada: crea salas y enruta el websocket al Durable Object
 * correspondiente. Todo lo que no sea /api/* lo sirve el binding de assets.
 */

import { GameRoom } from './room.js';
import { RetoDelDia, fechaDeHoy } from './reto.js';
import {
  MAX_PLAYERS,
  clampMaxPlayers,
  isValidCode,
  isValidPid,
  normalizeCode,
  randomCode,
} from './game.js';

export { GameRoom, RetoDelDia };

// Cupo diario de requests del Worker en el plan gratis. Los archivos estáticos
// no cuentan (los sirve el binding de assets sin invocar al Worker), así que
// esto mide solo /api/*. Pasado el cupo, Cloudflare contesta el error 1027
// hasta la medianoche UTC; no genera cobro, corta y ya.
const CUPO_DIARIO = 100000;
const AVISAR_DESDE = 0.5;

// Tiene que coincidir con "name" en wrangler.jsonc: es como lo identifica la
// API de analytics.
const NOMBRE_WORKER = 'numerordle';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (!(await dentroDelLimite(env, env.CREAR_SALA, request))) {
        ctx.waitUntil(avisar(env, 'Se está frenando la creación de salas: alguien viene pidiendo más de 10 por minuto.'));
        return json({
          error: 'Ahora mismo no se pueden crear salas nuevas. Probá de nuevo en un minuto.',
        }, 429);
      }

      let mode = 'sim';
      let max = MAX_PLAYERS;
      let bot = '';
      try {
        const body = await request.json();
        if (body?.mode === 'strict') mode = 'strict';
        // El clamp definitivo lo hace la sala; acá solo se acota lo que viaja.
        max = clampMaxPlayers(body?.max);
        // El nivel lo valida la sala contra los que existen de verdad.
        if (typeof body?.bot === 'string') bot = encodeURIComponent(body.bot.slice(0, 16));
      } catch {
        /* body opcional */
      }
      /**
       * Cinco vueltas, por dos motivos que conviene no confundir.
       *
       * El de siempre: 32^5 combinaciones, la colisión es remotísima pero se
       * chequea igual. Eso es lo que cubre el `if (res.ok)` — la sala
       * **contestó**, diciendo que estaba ocupada.
       *
       * El otro es el 500 al despertar un Durable Object, que está en "El 500
       * al crear el objeto" (docs\DECISIONES.md). Ese no contesta: **tira una
       * excepción**, y hasta acá la atravesaba entera sin que ninguna vuelta la
       * agarrara, porque `roomFetch` no atrapa nada y afuera no hay ningún
       * `catch`. Salía como 500 igual que el desafío antes de su arreglo. Este
       * mismo comentario decía que reintentar cinco veces ya lo cubría, y era
       * al revés: la sala era el camino que quedaba desprotegido.
       *
       * **Acá sí se puede reintentar a ciegas**, y es la diferencia con el
       * desafío: cada vuelta pide un código nuevo, así que no se repite nada de
       * lo que la anterior haya alcanzado a hacer. Si la excepción llegó con la
       * sala ya creada —que es lo que pasa en esta falla—, esa queda huérfana y
       * vacía; `save()` le dejó alarma y el TTL de la que nunca recibió a nadie
       * es corto, así que se demuele sola.
       */
      let ultimo;
      for (let intento = 0; intento < 5; intento++) {
        const code = randomCode();
        try {
          const res = await roomFetch(
            env,
            code,
            `create?code=${code}&mode=${mode}&max=${max}&bot=${bot}&prueba=${esPrueba(env, url) ? '1' : ''}`,
            'POST',
          );
          if (res.ok) return json({ code });
        } catch (err) {
          ultimo = err;
          console.log(`la sala no se creó (intento ${intento + 1}): ${err?.message ?? err}`);
        }
      }
      // Las dos salidas se anotan distinto a propósito: "cinco códigos
      // ocupados" y "cinco excepciones" son problemas que no se parecen en
      // nada, y confundirlos es justo lo que hizo falta desenredar acá.
      console.log(ultimo
        ? `la sala no se creó después de cinco intentos: ${ultimo?.message ?? ultimo}`
        : 'la sala no se creó: cinco códigos seguidos dieron ocupado');
      return json({ error: 'No se pudo crear la sala, probá de nuevo.' }, 503);
    }

    // El desafío del día. No hay sala que crear ni websocket que abrir: es un
    // jugador solo, así que no hay nada que empujarle. Cada intento igual
    // despierta un Durable Object, y por eso tiene su propio limitador.
    if (url.pathname === '/api/reto') {
      if (request.method !== 'GET' && request.method !== 'POST') {
        return json({ error: 'No encontrado.' }, 404);
      }
      const pid = url.searchParams.get('pid') ?? '';
      if (!isValidPid(pid)) return json({ error: 'Identificador inválido.' }, 400);

      if (!(await dentroDelLimite(env, env.RETO, request))) {
        return json({ error: 'Demasiados intentos seguidos. Esperá un momento.' }, 429);
      }

      // El cliente puede pedir seguir el desafío que ya venía jugando cuando
      // cambió el día, y solo ese: se aceptan hoy y ayer, y nada más. Que se
      // pueda continuar de verdad lo decide la sala, que es la única que sabe
      // si hay algo empezado; acá solo se acota a qué objeto se puede despertar.
      const hoy = fechaDeHoy();
      const ayer = fechaDeHoy(Date.now() - 86400000);
      const pedida = url.searchParams.get('fecha');
      const fecha = pedida === ayer ? ayer : hoy;
      const accion = request.method === 'POST' ? 'intento' : 'estado';
      const id = env.RETOS.idFromName(`${fecha}-${pid}`);

      // El cuerpo se lee **acá** y se reenvía ya materializado, en vez de pasar
      // el request original con su stream sin abrir. Si el objeto contesta sin
      // llegar a leerlo —el 409 de un desafío que ya terminó—, ese stream queda
      // colgado y el runtime tira "Can't read from request stream after
      // response has been sent". No es un error que se pueda atrapar: **mata al
      // Worker**, y los pedidos siguientes se cuelgan hasta agotar el tiempo.
      const cuerpo = request.method === 'POST' ? await request.text() : undefined;
      const qs = new URLSearchParams({
        fecha,
        hoy: fecha === hoy ? '1' : '0',
        prueba: esPrueba(env, url) ? '1' : '',
      });
      // El stub se pide de nuevo en cada intento, y no una vez afuera: la guía
      // de Cloudflare dice que muchas excepciones dejan el stub "roto", y que
      // todo lo que se le mande después falla en el acto con la misma
      // excepción. Con un solo stub, los reintentos de abajo podían no
      // reintentar nada. Es gratis: `get` no hace ningún pedido.
      const pedir = () => env.RETOS.get(id).fetch(new Request(`https://reto/${accion}?${qs}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: cuerpo,
      }));

      /**
       * **El primer pedido de cada (jugador, día) falla de a ratos**, y es el
       * que abre el desafío. Medido contra producción el 13 de agosto de 2026:
       * 3 de cada 20 pedidos a un objeto que todavía no existía contestaron
       * 500. Contra uno ya creado, 0 de 14. La excepción que llega es
       * `internal error; reference = …`, o sea de la plataforma y no nuestra:
       * no trae stack ni pasa por ningún `catch` de adentro del objeto.
       *
       * No es de la regla de no repetir: se midió igual sobre la versión
       * anterior, con `wrangler rollback`, y dio 3 de cada 16.
       *
       * Reintentar lo tapa porque el segundo pedido ya encuentra el objeto
       * creado. La creación de salas reintenta parecido pero no igual: allá
       * cada vuelta pide un código nuevo, así que da lo mismo qué alcanzó a
       * dejar hecho la anterior. Acá se vuelve a pedir el mismo objeto, y de
       * esa diferencia sale lo que viene abajo.
       *
       * **Solo el GET.** Un POST no se puede repetir a ciegas: si el primero
       * llegó a aplicar el intento, el segundo lo aplicaría de nuevo. Y no hace
       * falta, porque para llegar a un POST el objeto ya tuvo que existir: el
       * cliente abre el desafío con un GET antes de dejar arriesgar.
       */
      if (request.method === 'POST') return pedir();
      let ultimo;
      for (let intento = 0; intento < 3; intento++) {
        try {
          return await pedir();
        } catch (err) {
          ultimo = err;
          // `retryable` y `overloaded` los pone la plataforma en sus propias
          // excepciones, y son lo único que dice de qué clase es el fallo. Se
          // anotan para que la próxima medición los tenga.
          console.log(`el desafío no abrió (intento ${intento + 1}): ${err?.message ?? err} [retryable=${err?.retryable ?? '?'} overloaded=${err?.overloaded ?? '?'}]`);
          // La guía pide espera creciente entre reintentos; dos son suficientes
          // para no sumar más de medio segundo al que espera.
          await new Promise((r) => setTimeout(r, 150 * 2 ** intento));
        }
      }
      // Tres seguidos ya no es la falla de a ratos: que lo diga en castellano y
      // no como una página de error de Cloudflare.
      console.log(`el desafío no abrió después de tres intentos: ${ultimo?.message ?? ultimo}`);
      return json({ error: 'No se pudo abrir el desafío. Probá de nuevo en un momento.' }, 503);
    }

    // Hubo un /exists que decía si una sala existía y cuántos había adentro.
    // No lo usaba el cliente y servía para barrer códigos a ver qué aparecía.
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
    if (match) {
      // decodeURIComponent tira URIError con cosas como `/api/rooms/%/ws`, que
      // matchean la ruta igual. Sin esto el Worker contesta 500.
      let code;
      try {
        code = normalizeCode(decodeURIComponent(match[1]));
      } catch {
        return json({ error: 'Código inválido.' }, 400);
      }
      if (!isValidCode(code)) return json({ error: 'Código inválido.' }, 400);

      // Entrar a una sala es mucho más barato que crearla, pero abrir sockets
      // en masa igual cuesta: cada apertura es un request del Durable Object.
      if (!(await dentroDelLimite(env, env.ABRIR_SALA, request))) {
        return json({ error: 'Demasiados intentos de conexión. Esperá un momento.' }, 429);
      }

      const qs = new URLSearchParams({
        pid: url.searchParams.get('pid') ?? '',
        name: url.searchParams.get('name') ?? '',
      });
      return roomFetch(env, code, `ws?${qs}`, 'GET', request);
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'No encontrado.' }, 404);

    // Fuera de /api el Worker casi nunca corre (run_worker_first), pero por
    // las dudas delegamos en los archivos estáticos.
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(revisarCupo(env));
  },
};

/**
 * Mira cuánto va consumido del cupo diario y avisa si está alto. Corre por
 * Cron Trigger, no en el camino de nadie: si falla, no lo nota ningún jugador.
 */
async function revisarCupo(env) {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return;

  let usados;
  try {
    usados = await requestsDeHoy(env);
  } catch (err) {
    // Un token vencido o un cambio en la API dejarían esto mudo para siempre,
    // que es peor que un aviso de más: mejor que se entere.
    await avisar(env, `No pude leer el uso del día: ${err.message ?? err}`, 'cupo-error');
    return;
  }
  if (usados == null) return;

  const parte = usados / CUPO_DIARIO;
  if (parte < AVISAR_DESDE) return;
  await avisar(
    env,
    `Van ${usados.toLocaleString('es-AR')} requests de la API hoy: ${Math.round(parte * 100)}% del cupo diario. Se repone a la medianoche UTC.`,
    'cupo',
  );
}

/** Requests del Worker desde la medianoche UTC, según la API de analytics. */
async function requestsDeHoy(env) {
  const desde = new Date();
  desde.setUTCHours(0, 0, 0, 0);

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: `query($cuenta: string!, $desde: string!, $script: string!) {
        viewer {
          accounts(filter: { accountTag: $cuenta }) {
            workersInvocationsAdaptive(
              limit: 1000
              filter: { scriptName: $script, datetime_geq: $desde }
            ) {
              sum { requests }
            }
          }
        }
      }`,
      variables: {
        cuenta: env.CF_ACCOUNT_ID,
        desde: desde.toISOString(),
        script: NOMBRE_WORKER,
      },
    }),
  });

  if (!res.ok) throw new Error(`la API de analytics contestó HTTP ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0]?.message ?? 'error de GraphQL');

  const filas = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(filas)) throw new Error('la respuesta no tiene la forma esperada');
  return filas.reduce((total, f) => total + (f.sum?.requests ?? 0), 0);
}

/**
 * ¿Esta partida es una prueba?
 *
 * Existe porque probar contra producción ensucia justo el dato que se está
 * juntando para calibrar: una partida de prueba parece alguien que jugó mal, y
 * después no hay forma de distinguirla. Ya pasó —un desafío llevado a los
 * treinta a propósito se leyó como un jugador que sufrió.
 *
 * Va con clave y no con un `?prueba=1` a secas por una razón que no es de
 * seguridad: si cualquiera pudiera marcar, una fila marcada podría venir de
 * cualquiera y no se sabría si corresponde excluirla. Con clave, si está
 * marcada es nuestra. Que se filtre no hace daño —lo peor que puede hacer
 * alguien es sacarse a sí mismo del análisis— pero sí arruinaría esa certeza.
 *
 * Sin `PRUEBA_CLAVE` cargada no se puede marcar nada, que es lo correcto: en
 * duda, el dato cuenta.
 */
function esPrueba(env, url) {
  const clave = env.PRUEBA_CLAVE;
  return Boolean(clave) && url.searchParams.get('prueba') === clave;
}

/**
 * Límite por IP. Se cuenta por `CF-Connecting-IP`, que lo pone el borde de
 * Cloudflare y el cliente no puede falsear. No se limita por jugador: el `pid`
 * lo elige el cliente y se cambia borrando el localStorage, así que serviría
 * para frenar un accidente pero no a alguien que no quiere ser frenado.
 *
 * Sin esa cabecera no estamos detrás del borde —o sea, `wrangler dev`— y no hay
 * por dónde limitar: se deja pasar. En producción Cloudflare la pone siempre.
 */
async function dentroDelLimite(env, limitador, request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!limitador || !ip) return true;
  const { success } = await limitador.limit({ key: ip });
  return success;
}

/**
 * Aviso a Discord. Pasa por su propio limitador de uno por minuto: sin eso, el
 * aviso amplificaría el ataque en vez de contarlo. No se manda la IP: es dato
 * personal de un tercero y no cambia lo que hay que hacer al respecto.
 */
async function avisar(env, texto, clave = 'ritmo') {
  if (!env.DISCORD_WEBHOOK_URL || !env.AVISO) return;
  try {
    // Cada tipo de aviso tiene su propia cuenta: una tormenta de avisos por
    // ritmo no puede tapar el del cupo diario, que es el que importa más.
    const { success } = await env.AVISO.limit({ key: clave });
    if (!success) return;
    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: `⚠️ Fijos y Picas — ${texto}` }),
    });
  } catch {
    /* que el aviso falle no puede romper la respuesta al jugador */
  }
}

function roomFetch(env, code, path, method = 'GET', original = null) {
  const id = env.ROOMS.idFromName(code);
  const stub = env.ROOMS.get(id);
  const target = `https://sala/${path}`;
  if (original) return stub.fetch(new Request(target, original));
  return stub.fetch(new Request(target, { method }));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
