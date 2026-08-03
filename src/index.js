/**
 * Worker de entrada: crea salas y enruta el websocket al Durable Object
 * correspondiente. Todo lo que no sea /api/* lo sirve el binding de assets.
 */

import { GameRoom } from './room.js';
import { MAX_PLAYERS, clampMaxPlayers, isValidCode, normalizeCode, randomCode } from './game.js';

export { GameRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
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

    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(ws|exists)$/);
    if (match) {
      const code = normalizeCode(decodeURIComponent(match[1]));
      const action = match[2];
      if (!isValidCode(code)) return json({ error: 'Código inválido.' }, 400);

      if (action === 'exists') return roomFetch(env, code, 'exists');

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
