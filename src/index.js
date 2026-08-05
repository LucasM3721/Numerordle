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
      // 32^5 combinaciones: la colisión es remotísima, pero se chequea igual.
      for (let intento = 0; intento < 5; intento++) {
        const code = randomCode();
        const res = await roomFetch(
          env,
          code,
          `create?code=${code}&mode=${mode}&max=${max}&bot=${bot}`,
          'POST',
        );
        if (res.ok) return json({ code });
      }
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

      // La fecha la decide el servidor. Si la eligiera el cliente, pedir la de
      // ayer sería pedir un número que ya se sabe.
      const fecha = fechaDeHoy();
      const accion = request.method === 'POST' ? 'intento' : 'estado';
      const id = env.RETOS.idFromName(`${fecha}-${pid}`);
      const stub = env.RETOS.get(id);

      // El cuerpo se lee **acá** y se reenvía ya materializado, en vez de pasar
      // el request original con su stream sin abrir. Si el objeto contesta sin
      // llegar a leerlo —el 409 de un desafío que ya terminó—, ese stream queda
      // colgado y el runtime tira "Can't read from request stream after
      // response has been sent". No es un error que se pueda atrapar: **mata al
      // Worker**, y los pedidos siguientes se cuelgan hasta agotar el tiempo.
      const cuerpo = request.method === 'POST' ? await request.text() : undefined;
      return stub.fetch(new Request(`https://reto/${accion}?fecha=${fecha}`, {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: cuerpo,
      }));
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
