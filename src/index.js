/**
 * Worker de entrada: crea salas y enruta el websocket al Durable Object
 * correspondiente. Todo lo que no sea /api/* lo sirve el binding de assets.
 */

import { GameRoom } from './room.js';
import { MAX_PLAYERS, clampMaxPlayers, isValidCode, normalizeCode, randomCode } from './game.js';

export { GameRoom };

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
      try {
        const body = await request.json();
        if (body?.mode === 'strict') mode = 'strict';
        // El clamp definitivo lo hace la sala; acá solo se acota lo que viaja.
        max = clampMaxPlayers(body?.max);
      } catch {
        /* body opcional */
      }
      // 32^5 combinaciones: la colisión es remotísima, pero se chequea igual.
      for (let intento = 0; intento < 5; intento++) {
        const code = randomCode(5);
        const res = await roomFetch(env, code, `create?code=${code}&mode=${mode}&max=${max}`, 'POST');
        if (res.ok) return json({ code });
      }
      return json({ error: 'No se pudo crear la sala, probá de nuevo.' }, 503);
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
};

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
async function avisar(env, texto) {
  if (!env.DISCORD_WEBHOOK_URL || !env.AVISO) return;
  try {
    const { success } = await env.AVISO.limit({ key: 'aviso' });
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
