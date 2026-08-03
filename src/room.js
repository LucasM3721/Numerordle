/**
 * Una sala = un Durable Object. Guarda los secretos del lado del servidor
 * (el cliente nunca los ve hasta que se revelan) y calcula fijos y picas.
 */

import {
  MIN_PLAYERS,
  MAX_PLAYERS,
  clampMaxPlayers,
  cleanName,
  isValidPid,
  isValidSecret,
  randomPublicId,
  scoreGuess,
  shuffled,
} from './game.js';

const IDLE_TTL_MS = 1000 * 60 * 60 * 24; // la sala se borra tras 24 h sin uso
const GRACE_MS = 1000 * 90; // margen para recargar la página o cambiar de red
const MAX_LOG = 2000;

// ---------------------------------------------------------------- helpers

function newState(code, mode, maxPlayers) {
  const now = Date.now();
  return {
    code,
    createdAt: now,
    lastActivity: now,
    phase: 'lobby', // lobby | secret | playing | intermission | finished
    mode: mode === 'strict' ? 'strict' : 'sim',
    maxPlayers: clampMaxPlayers(maxPlayers),
    overtime: false,
    hostId: null,
    players: [], // el orden del array ES el orden del círculo
    round: 0,
    roundQueue: [],
    turnPtr: 0,
    pending: {}, // modo simultáneo: playerId -> intento
    log: [],
    revealed: [], // ids cuyos secretos ya son públicos
    game: 1,
  };
}

/**
 * Dos espacios de identificadores, y no hay que mezclarlos:
 *
 * - `p.id` es el **pid**: la credencial con la que el jugador se autentica.
 *   Vive solo en el servidor. Quien lo tenga, ES ese jugador.
 * - `p.pub` es el **id público**: lo que ven los demás. Va en el historial,
 *   en `revealed` y en todo lo que sale por `viewFor`.
 *
 * Los mensajes que entran nombrando a otro jugador (mover, coronar, echar)
 * traen ids públicos, así que se resuelven con `findByPub`.
 */
function findPlayer(state, id) {
  return state.players.find((p) => p.id === id) ?? null;
}

function findByPub(state, pub) {
  return state.players.find((p) => p.pub === pub) ?? null;
}

function pubOf(state, id) {
  return findPlayer(state, id)?.pub ?? null;
}

/**
 * Salas guardadas antes de que existiera el id público: se les inventa uno y
 * se traduce lo que ya quedó escrito, para que una partida en curso no pierda
 * el historial ni a sus ganadores al desplegar.
 */
function ensurePublicIds(state) {
  if (!state || state.players.every((p) => p.pub)) return;
  const mapa = new Map();
  for (const p of state.players) {
    if (!p.pub) p.pub = randomPublicId();
    mapa.set(p.id, p.pub);
  }
  const tr = (id) => mapa.get(id) ?? id;
  for (const e of state.log) {
    e.playerId = tr(e.playerId);
    e.targetId = tr(e.targetId);
  }
  state.revealed = state.revealed.map(tr);
}

/** Las salas creadas antes de que el cupo fuera configurable no lo tienen. */
function roomLimit(state) {
  return clampMaxPlayers(state.maxPlayers);
}

/** A cada jugador le toca adivinarle al siguiente del círculo. */
function targetIdOf(state, id) {
  const i = state.players.findIndex((p) => p.id === id);
  if (i < 0 || state.players.length < 2) return null;
  return state.players[(i + 1) % state.players.length].id;
}

function activeIds(state) {
  return state.players.filter((p) => p.status === 'playing').map((p) => p.id);
}

function everyoneReady(state) {
  return (
    state.players.length >= MIN_PLAYERS &&
    state.players.every((p) => isValidSecret(p.secret))
  );
}

/** Dos "Juan" en la misma sala es un lío: al segundo le queda "Juan 2". */
function uniqueName(state, raw, selfId) {
  const base = cleanName(raw);
  const taken = new Set(
    state.players.filter((p) => p.id !== selfId).map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

/**
 * ¿Se puede sacar a este jugador desconectado sin romper nada?
 * En partida no: los objetivos y el historial dependen del orden del círculo.
 */
function sweepable(state, p) {
  if (p.connected || !p.disconnectedAt) return false;
  if (state.phase === 'lobby') return true;
  // En el reparto, solo se va el que todavía no eligió número: el que ya se
  // comprometió sigue siendo parte de la partida aunque se le caiga la conexión.
  if (state.phase === 'secret') return !isValidSecret(p.secret);
  return false;
}

/** Saca a un jugador de la ronda en curso sin dejar la partida colgada. */
function dropFromRound(state, id) {
  const pos = state.roundQueue.indexOf(id);
  if (pos < 0) return;
  delete state.pending[id];
  state.roundQueue.splice(pos, 1);

  if (state.roundQueue.length === 0) {
    endRound(state);
    return;
  }
  if (state.mode === 'strict') {
    if (pos < state.turnPtr) state.turnPtr--;
    if (state.turnPtr >= state.roundQueue.length) endRound(state);
  } else if (state.roundQueue.every((x) => state.pending[x])) {
    resolveSimultaneous(state);
  }
}

function settleIntermission(state) {
  const indecisos = state.players.filter((p) => p.status === 'playing' && p.decision === null);
  if (indecisos.length > 0) return;
  if (state.players.some((p) => p.status === 'playing')) {
    state.phase = 'playing';
    state.overtime = true;
    state.round++;
    startRound(state);
  } else {
    finishGame(state);
  }
}

/**
 * Irse de la sala. Antes de empezar (o ya terminada) desaparecés del todo;
 * con la partida en curso quedás retirado, porque borrarte del círculo
 * cambiaría a quién le adivina cada uno y ensuciaría el historial.
 * Devuelve true si el jugador fue eliminado de la lista.
 */
function detach(state, player) {
  const fuera = state.phase === 'lobby' || state.phase === 'secret' || state.phase === 'finished';
  if (fuera) {
    state.players = state.players.filter((p) => p.id !== player.id);
    if (state.hostId === player.id) {
      state.hostId = state.players.find((p) => p.connected)?.id ?? state.players[0]?.id ?? null;
    }
    return true;
  }
  if (player.status === 'playing') {
    player.status = 'quit';
    player.decision = false;
    if (state.phase === 'playing') dropFromRound(state, player.id);
    else if (state.phase === 'intermission') settleIntermission(state);
  }
  return false;
}

function startRound(state) {
  state.roundQueue = activeIds(state);
  state.turnPtr = 0;
  state.pending = {};
  if (state.roundQueue.length === 0) finishGame(state);
}

function finishGame(state) {
  state.phase = 'finished';
  state.roundQueue = [];
  state.pending = {};
  state.revealed = state.players.map((p) => p.pub); // se destapa todo
}

function resolveGuess(state, playerId, guess) {
  const player = findPlayer(state, playerId);
  const target = findPlayer(state, targetIdOf(state, playerId));
  const { fijos, picas } = scoreGuess(guess, target.secret);
  state.log.push({
    n: state.log.length,
    round: state.round,
    playerId: player.pub,
    playerName: player.name,
    targetId: target.pub,
    targetName: target.name,
    guess,
    fijos,
    picas,
  });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  return fijos;
}

/**
 * Cierra la ronda. Regla de la mesa: si alguien acertó gana, pero la ronda
 * se juega entera por si otro acierta en la misma vuelta (puede haber empate).
 */
function endRound(state) {
  const roundHits = state.log.filter((e) => e.round === state.round && e.fijos === 4);

  if (roundHits.length > 0) {
    for (const hit of roundHits) {
      // El historial habla en ids públicos.
      const winner = findByPub(state, hit.playerId);
      if (winner && winner.status === 'playing') {
        winner.status = 'won';
        winner.wonRound = state.round;
      }
      if (!state.revealed.includes(hit.targetId)) state.revealed.push(hit.targetId);
    }
    const remaining = state.players.filter((p) => p.status === 'playing');
    if (remaining.length === 0) {
      finishGame(state);
    } else {
      // Los que no ganaron eligen si siguen jugando por el gusto de terminar.
      state.phase = 'intermission';
      for (const p of remaining) p.decision = null;
      state.roundQueue = [];
      state.pending = {};
    }
    return;
  }

  state.round++;
  startRound(state);
}

function advanceStrict(state) {
  state.turnPtr++;
  if (state.turnPtr >= state.roundQueue.length) endRound(state);
}

function pushSkip(state, playerId) {
  const player = findPlayer(state, playerId);
  const target = findPlayer(state, targetIdOf(state, playerId));
  state.log.push({
    n: state.log.length,
    round: state.round,
    playerId: player?.pub ?? null,
    playerName: player?.name ?? '?',
    targetId: target?.pub ?? null,
    targetName: target?.name ?? '?',
    guess: null,
    fijos: 0,
    picas: 0,
    skipped: true,
  });
}

/** `force` cierra la ronda aunque falten intentos: los ausentes pasan. */
function resolveSimultaneous(state, force = false) {
  for (const id of state.roundQueue) {
    const guess = state.pending[id];
    if (guess) resolveGuess(state, id, guess);
    else if (force) pushSkip(state, id);
  }
  endRound(state);
}

/**
 * Vista personalizada: nadie recibe el secreto de otro hasta que se revela.
 * Es también la frontera donde los pid se traducen a ids públicos: de acá
 * para afuera no sale ni un solo identificador que sirva para autenticarse.
 */
function viewFor(state, pid) {
  const me = findPlayer(state, pid);
  const n = state.players.length;
  return {
    t: 'state',
    code: state.code,
    phase: state.phase,
    mode: state.mode,
    overtime: state.overtime,
    round: state.round,
    game: state.game,
    hostId: pubOf(state, state.hostId),
    minPlayers: MIN_PLAYERS,
    maxPlayers: roomLimit(state), // el cupo de esta sala
    maxPlayersCap: MAX_PLAYERS, // el techo hasta donde el anfitrión lo puede subir
    players: state.players.map((p, i) => ({
      id: p.pub,
      name: p.name,
      connected: p.connected,
      status: p.status,
      ready: isValidSecret(p.secret),
      wonRound: p.wonRound,
      decision: p.decision ?? null,
      targetId: n >= 2 ? state.players[(i + 1) % n].pub : null,
      secret: state.revealed.includes(p.pub) ? p.secret : null,
    })),
    turnId:
      state.mode === 'strict' && state.phase === 'playing'
        ? pubOf(state, state.roundQueue[state.turnPtr])
        : null,
    waitingOn:
      state.mode === 'sim' && state.phase === 'playing'
        ? state.roundQueue.filter((id) => !state.pending[id]).map((id) => pubOf(state, id))
        : [],
    log: state.log,
    you: {
      id: me?.pub ?? null,
      name: me?.name ?? null,
      secret: me?.secret ?? null,
      targetId: me ? pubOf(state, targetIdOf(state, pid)) : null,
      pending: state.pending[pid] ?? null,
      isHost: state.hostId === pid,
      inGame: !!me,
    },
  };
}

// ------------------------------------------------------------------- DO

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) ?? null;
      ensurePublicIds(this.state);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').pop();

    if (action === 'create') {
      if (this.state) return json({ error: 'ocupado' }, 409);
      this.state = newState(
        url.searchParams.get('code'),
        url.searchParams.get('mode'),
        url.searchParams.get('max'),
      );
      await this.save();
      return json({ ok: true, code: this.state.code });
    }

    if (action === 'exists') {
      return json({
        exists: !!this.state,
        phase: this.state?.phase ?? null,
        players: this.state?.players.length ?? 0,
      });
    }

    if (action === 'ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Se esperaba un websocket', { status: 426 });
      }
      const pid = url.searchParams.get('pid') ?? '';
      const name = url.searchParams.get('name') ?? '';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ pid });

      const problem = await this.join(pid, name);
      if (problem) {
        server.send(JSON.stringify({ t: 'kicked', reason: problem }));
        server.close(4001, 'join-rechazado');
      } else {
        await this.broadcast();
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('No encontrado', { status: 404 });
  }

  // ------------------------------------------------------------ conexión

  async join(pid, rawName) {
    if (!this.state) return 'Esta sala no existe (o venció por inactividad).';
    if (!isValidPid(pid)) return 'Identificador inválido.';

    // El pid es la credencial: quien lo tenga es ese jugador. Por eso no sale
    // nunca del servidor (ver `viewFor`); si saliera, alcanzaría con leerlo de
    // la sala para hacerse pasar por otro y que el servidor le mande su número.
    const existing = findPlayer(this.state, pid);
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = null;
      const name = cleanName(rawName);
      if (name && name !== 'Jugador') existing.name = uniqueName(this.state, name, pid);
    } else {
      if (this.state.phase !== 'lobby' && this.state.phase !== 'secret') {
        return 'La partida ya empezó. Esperá a que terminen para entrar.';
      }
      const cupo = roomLimit(this.state);
      if (this.state.players.length >= cupo) {
        return `La sala está llena (máximo ${cupo} jugadores).`;
      }
      this.state.players.push({
        id: pid,
        pub: randomPublicId(),
        name: uniqueName(this.state, rawName, pid),
        secret: null,
        connected: true,
        disconnectedAt: null,
        status: 'playing',
        wonRound: null,
        decision: null,
        joinedAt: Date.now(),
      });
      if (!this.state.hostId) this.state.hostId = pid;
    }
    await this.save();
    return null;
  }

  async webSocketMessage(ws, raw) {
    if (!this.state) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { pid } = ws.deserializeAttachment() ?? {};
    const player = findPlayer(this.state, pid);
    if (!player) return;

    try {
      const changed = this.handle(player, msg);
      if (changed === false) return;
      await this.save();
      await this.broadcast();
    } catch (err) {
      ws.send(JSON.stringify({ t: 'error', msg: String(err.message ?? err) }));
    }
  }

  async webSocketClose(ws) {
    await this.markGone(ws);
  }

  async webSocketError(ws) {
    await this.markGone(ws);
  }

  async markGone(ws) {
    if (!this.state) return;
    const { pid } = ws.deserializeAttachment() ?? {};
    const player = findPlayer(this.state, pid);
    if (!player) return;
    // Puede tener otra pestaña abierta con el mismo jugador.
    const stillHere = this.ctx
      .getWebSockets()
      .some((s) => s !== ws && (s.deserializeAttachment() ?? {}).pid === pid);
    if (stillHere) return;
    player.connected = false;
    player.disconnectedAt = Date.now();
    if (this.state.hostId === pid) {
      const heir = this.state.players.find((p) => p.connected);
      if (heir) this.state.hostId = heir.id;
    }
    await this.save();
    await this.broadcast();
  }

  // -------------------------------------------------------------- acciones

  /** Devuelve false si no hubo cambios que difundir. Tira Error si es inválido. */
  handle(player, msg) {
    const s = this.state;
    const isHost = s.hostId === player.id;
    const requireHost = () => {
      if (!isHost) throw new Error('Solo el anfitrión puede hacer eso.');
    };

    switch (msg.t) {
      case 'ping':
        return false;

      case 'rename': {
        player.name = uniqueName(s, msg.name, player.id);
        return true;
      }

      case 'setMode': {
        requireHost();
        if (s.phase !== 'lobby') throw new Error('El modo se elige antes de empezar.');
        s.mode = msg.mode === 'strict' ? 'strict' : 'sim';
        return true;
      }

      // El cupo se toca solo en la espera: una vez repartidos los números la
      // sala ya está cerrada a los de afuera y cambiarlo no significaría nada.
      case 'setMax': {
        requireHost();
        if (s.phase !== 'lobby') throw new Error('El cupo se elige antes de empezar.');
        const piso = Math.max(MIN_PLAYERS, s.players.length);
        const nuevo = clampMaxPlayers(msg.max, piso);
        if (nuevo === roomLimit(s)) return false;
        s.maxPlayers = nuevo;
        return true;
      }

      case 'shuffle': {
        requireHost();
        if (s.phase !== 'lobby') throw new Error('El orden se arma antes de empezar.');
        s.players = shuffled(s.players);
        return true;
      }

      // Un lugar arriba o abajo en el círculo. De a pasos y no con la lista
      // entera: así no se pisa con alguien que entra o sale justo en el medio.
      case 'move': {
        requireHost();
        if (s.phase !== 'lobby') throw new Error('El orden se arma antes de empezar.');
        const i = s.players.findIndex((p) => p.pub === msg.id);
        if (i < 0) throw new Error('Ese jugador ya no está en la sala.');
        const j = i + (msg.dir < 0 ? -1 : 1);
        if (j < 0 || j >= s.players.length) return false;
        [s.players[i], s.players[j]] = [s.players[j], s.players[i]];
        return true;
      }

      case 'makeHost': {
        requireHost();
        const nuevo = findByPub(s, msg.id);
        if (!nuevo) throw new Error('Ese jugador ya no está en la sala.');
        if (nuevo.id === player.id) throw new Error('Ya sos vos el anfitrión.');
        if (!nuevo.connected) {
          throw new Error('No le podés dejar la sala a alguien sin conexión.');
        }
        s.hostId = nuevo.id;
        return true;
      }

      case 'kick': {
        requireHost();
        const victima = findByPub(s, msg.id);
        if (!victima) throw new Error('Ese jugador ya no está en la sala.');
        if (victima.id === player.id) throw new Error('No podés sacarte a vos mismo.');
        if (detach(s, victima)) {
          for (const sock of this.ctx.getWebSockets()) {
            if ((sock.deserializeAttachment() ?? {}).pid === victima.id) {
              sock.send(JSON.stringify({ t: 'kicked', reason: 'El anfitrión te sacó de la sala.' }));
              sock.close(4002, 'kick');
            }
          }
        }
        return true;
      }

      case 'leave': {
        detach(s, player);
        return true;
      }

      case 'start': {
        requireHost();
        if (s.phase !== 'lobby') throw new Error('La partida ya arrancó.');
        if (s.players.length < MIN_PLAYERS) {
          throw new Error(`Hacen falta al menos ${MIN_PLAYERS} jugadores.`);
        }
        s.phase = 'secret';
        return true;
      }

      case 'setSecret': {
        if (s.phase !== 'secret') throw new Error('No es momento de elegir el número.');
        if (!isValidSecret(msg.secret)) {
          throw new Error('El número debe tener 4 dígitos del 1 al 9, sin repetir.');
        }
        player.secret = msg.secret;
        if (everyoneReady(s)) {
          s.phase = 'playing';
          s.round = 1;
          s.overtime = false;
          startRound(s);
        }
        return true;
      }

      case 'unsetSecret': {
        if (s.phase !== 'secret') throw new Error('Ya no podés cambiar el número.');
        player.secret = null;
        return true;
      }

      case 'guess': {
        if (s.phase !== 'playing') throw new Error('No hay ronda en juego.');
        if (player.status !== 'playing') throw new Error('Ya no estás jugando esta partida.');
        if (!isValidSecret(msg.guess)) {
          throw new Error('El intento debe tener 4 dígitos del 1 al 9, sin repetir.');
        }
        if (!s.roundQueue.includes(player.id)) throw new Error('No entrás en esta ronda.');

        if (s.mode === 'strict') {
          if (s.roundQueue[s.turnPtr] !== player.id) throw new Error('No es tu turno.');
          resolveGuess(s, player.id, msg.guess);
          advanceStrict(s);
        } else {
          s.pending[player.id] = msg.guess;
          if (s.roundQueue.every((id) => s.pending[id])) resolveSimultaneous(s);
        }
        return true;
      }

      // Destraba una ronda cuando alguien se desconectó o se fue a dormir.
      case 'skip': {
        requireHost();
        if (s.phase !== 'playing') throw new Error('No hay ronda en juego.');
        if (s.mode === 'strict') {
          pushSkip(s, s.roundQueue[s.turnPtr]);
          advanceStrict(s);
        } else {
          resolveSimultaneous(s, true);
        }
        return true;
      }

      case 'decide': {
        if (s.phase !== 'intermission') throw new Error('No hay nada que decidir ahora.');
        if (player.status !== 'playing') throw new Error('Vos ya terminaste esta partida.');
        const cont = !!msg.continue;
        player.decision = cont;
        if (!cont) player.status = 'quit';
        settleIntermission(s);
        return true;
      }

      case 'endGame': {
        requireHost();
        if (s.phase === 'lobby' || s.phase === 'finished') {
          throw new Error('No hay partida para cerrar.');
        }
        finishGame(s);
        return true;
      }

      case 'rematch': {
        requireHost();
        if (s.phase !== 'finished') throw new Error('Todavía hay una partida en curso.');
        s.players = shuffled(s.players).map((p) => ({
          ...p,
          secret: null,
          status: 'playing',
          wonRound: null,
          decision: null,
        }));
        s.phase = 'secret';
        s.overtime = false;
        s.round = 0;
        s.roundQueue = [];
        s.turnPtr = 0;
        s.pending = {};
        s.log = [];
        s.revealed = [];
        s.game++;
        return true;
      }

      default:
        return false;
    }
  }

  // -------------------------------------------------------------- plomería

  async save() {
    if (!this.state) return;
    this.state.lastActivity = Date.now();
    await this.ctx.storage.put('state', this.state);
    await this.ctx.storage.setAlarm(this.nextAlarmAt());
  }

  /** La alarma sirve para dos cosas: barrer ausentes y vencer la sala. */
  nextAlarmAt() {
    const s = this.state;
    let soonest = s.lastActivity + IDLE_TTL_MS;
    for (const p of s.players) {
      if (sweepable(s, p)) soonest = Math.min(soonest, p.disconnectedAt + GRACE_MS);
    }
    return soonest;
  }

  async broadcast() {
    if (!this.state) return;
    for (const ws of this.ctx.getWebSockets()) {
      const { pid } = ws.deserializeAttachment() ?? {};
      try {
        ws.send(JSON.stringify(viewFor(this.state, pid)));
      } catch {
        /* socket muerto: se limpia solo */
      }
    }
  }

  async alarm() {
    if (!this.state) return;
    const now = Date.now();

    if (now - this.state.lastActivity >= IDLE_TTL_MS) {
      await this.demolish('La sala venció por inactividad.');
      return;
    }

    // Barrido: el que cerró la página y no volvió deja de ocupar lugar.
    const s = this.state;
    const antes = s.players.length;
    s.players = s.players.filter(
      (p) => !(sweepable(s, p) && now - p.disconnectedAt >= GRACE_MS),
    );

    if (s.players.length !== antes) {
      if (s.players.length === 0) {
        await this.demolish();
        return;
      }
      if (!findPlayer(s, s.hostId)) {
        s.hostId = s.players.find((p) => p.connected)?.id ?? s.players[0].id;
      }
      // Sin tocar lastActivity: barrer no cuenta como actividad de la sala.
      await this.ctx.storage.put('state', s);
      await this.broadcast();
    }

    await this.ctx.storage.setAlarm(this.nextAlarmAt());
  }

  async demolish(reason) {
    this.state = null;
    await this.ctx.storage.deleteAll();
    if (!reason) return;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ t: 'kicked', reason }));
        ws.close(4003, 'vencida');
      } catch {
        /* ya estaba cerrado */
      }
    }
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
