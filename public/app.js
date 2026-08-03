/* Fijos y Picas — cliente. Sin build, sin dependencias. */

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------- guardado

const store = {
  get pid() {
    let v = localStorage.getItem('fp:pid');
    if (!v) {
      v = (crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now());
      localStorage.setItem('fp:pid', v);
    }
    return v;
  },
  get name() {
    return localStorage.getItem('fp:name') ?? '';
  },
  set name(v) {
    localStorage.setItem('fp:name', v);
  },
};

/**
 * Anotaciones del jugador sobre sus propios intentos. Son un cuaderno personal:
 * no se validan, no viajan al servidor, nadie más las ve. Se guardan por sala y
 * por partida, así sobreviven a un refresh y se limpian solas en la revancha.
 */
const marks = {
  key: null,
  data: {},
  use(code, game) {
    const key = `fp:marks:${code}:${game}`;
    if (key === this.key) return;
    this.key = key;
    try {
      this.data = JSON.parse(localStorage.getItem(key) ?? '{}');
    } catch {
      this.data = {};
    }
  },
  get(n) {
    return this.data[n] ?? [0, 0, 0, 0];
  },
  set(n, pos, value) {
    const row = [...this.get(n)];
    row[pos] = value;
    this.data[n] = row;
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch {
      /* sin espacio: las marcas siguen en memoria */
    }
  },
};

// Para armar el selector de la pantalla de inicio, donde todavía no hay sala
// de la cual sacarlos. Quien manda es el servidor: recorta lo que le mandes.
const CAP_JUGADORES = 12;
const MIN_JUGADORES = 2;

const MARK_CLASS = ['', 'no', 'pica', 'fijo'];
const MARK_LABEL = ['sin marcar', 'no está', 'pica: está, pero en otro lugar', 'fijo: está justo acá'];

// ----------------------------------------------------------------- estado

let ws = null;
let state = null;
let roomCode = null;
let leaving = false;
let retries = 0;
let reconnectTimer = null;
let pingTimer = null;
let lastRound = -1;
let lastGame = -1;
let lastPhase = null;

// -------------------------------------------------------------- utilidades

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function show(id, visible) {
  $(id).classList.toggle('hidden', !visible);
}

function flash(id, msg) {
  const node = $(id);
  node.textContent = msg;
  node.classList.toggle('hidden', !msg);
  if (msg) {
    clearTimeout(node._t);
    node._t = setTimeout(() => node.classList.add('hidden'), 5000);
  }
}

/**
 * Llena un <select> con un rango de números. Solo lo reconstruye si el rango
 * cambió: rehacer las opciones en cada render cerraría la lista desplegada
 * justo cuando alguien la está usando.
 */
function fillRange(select, min, max, value) {
  if (select.dataset.min !== String(min) || select.dataset.max !== String(max)) {
    select.dataset.min = min;
    select.dataset.max = max;
    select.replaceChildren();
    for (let n = min; n <= max; n++) {
      const opt = el('option', null, `${n} jugadores`);
      opt.value = String(n);
      select.appendChild(opt);
    }
  }
  select.value = String(Math.min(max, Math.max(min, value)));
}

function randomSecret() {
  const pool = '123456789'.split('');
  let out = '';
  for (let i = 0; i < 4; i++) {
    const j = Math.floor(Math.random() * pool.length);
    out += pool.splice(j, 1)[0];
  }
  return out;
}

function validSecret(v) {
  return /^[1-9]{4}$/.test(v) && new Set(v).size === 4;
}

// -------------------------------------------------------- pad de 4 dígitos

class DigitPad {
  constructor(container, onEnter) {
    this.el = container;
    this.onEnter = onEnter;
    this.inputs = [];
    for (let i = 0; i < 4; i++) {
      const inp = el('input');
      inp.type = 'text';
      inp.inputMode = 'numeric';
      inp.maxLength = 1;
      inp.autocomplete = 'off';
      inp.setAttribute('aria-label', `Dígito ${i + 1}`);
      inp.addEventListener('input', () => this.onInput(i));
      inp.addEventListener('keydown', (e) => this.onKey(e, i));
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('paste', (e) => this.onPaste(e));
      container.appendChild(inp);
      this.inputs.push(inp);
    }
  }

  onInput(i) {
    const inp = this.inputs[i];
    const clean = inp.value.replace(/[^1-9]/g, '');
    // Si entró más de un dígito de golpe (tecleo veloz, teclado predictivo,
    // autocompletado) lo repartimos en vez de tirarlo.
    if (clean.length > 1) {
      const chars = clean.split('');
      for (let k = 0; k < chars.length && i + k < 4; k++) this.inputs[i + k].value = chars[k];
      this.inputs[Math.min(i + chars.length, 3)].focus();
      return;
    }
    inp.value = clean;
    if (clean && i < 3) this.inputs[i + 1].focus();
  }

  onKey(e, i) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.onEnter?.();
    } else if (e.key === 'Backspace' && !this.inputs[i].value && i > 0) {
      e.preventDefault();
      this.inputs[i - 1].value = '';
      this.inputs[i - 1].focus();
    } else if (e.key === 'ArrowLeft' && i > 0) {
      this.inputs[i - 1].focus();
    } else if (e.key === 'ArrowRight' && i < 3) {
      this.inputs[i + 1].focus();
    }
  }

  onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData?.getData('text') ?? '').replace(/[^1-9]/g, '').slice(0, 4);
    this.value = text.padEnd(4, ' ').slice(0, 4).trimEnd();
    this.inputs[Math.min(text.length, 3)].focus();
  }

  get value() {
    return this.inputs.map((i) => i.value).join('');
  }

  set value(v) {
    const chars = String(v ?? '').split('');
    this.inputs.forEach((inp, i) => (inp.value = chars[i] ?? ''));
  }

  clear() {
    this.value = '';
  }

  focus() {
    const first = this.inputs.find((i) => !i.value) ?? this.inputs[0];
    first.focus();
  }

  set disabled(v) {
    this.inputs.forEach((i) => (i.disabled = !!v));
  }

  set locked(v) {
    this.el.classList.toggle('locked', !!v);
  }
}

const secretPad = new DigitPad($('secret-pad'), () => submitSecret());
const guessPad = new DigitPad($('guess-pad'), () => submitGuess());

// --------------------------------------------------------------- conexión

/**
 * No encolamos: reenviar un intento viejo después de reconectar podría caer
 * en otra ronda. Mejor avisar y que la persona lo repita.
 */
function send(msg) {
  if (ws?.readyState !== WebSocket.OPEN) {
    flash('room-error', 'Se cortó la conexión con la sala. Reintentando… probá de nuevo en un segundo.');
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}

function setConn(cls) {
  $('conn').className = `conn ${cls}`;
  show('conn-text', cls === 'off' || cls === 'wait');
  $('conn-text').textContent = cls === 'wait' ? 'conectando…' : 'reconectando…';
}

function connect(code) {
  roomCode = code;
  leaving = false;
  clearTimeout(reconnectTimer);
  setConn('wait');
  show('screen-home', false);
  show('screen-room', true);
  $('room-code').textContent = code;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = new URLSearchParams({ pid: store.pid, name: store.name });
  ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?${qs}`);

  ws.onopen = () => {
    retries = 0;
    setConn('');
    clearInterval(pingTimer);
    // Mantiene viva la conexión sin gastar de más: cada mensaje que entra
    // cuenta como request del Durable Object.
    pingTimer = setInterval(() => send({ t: 'ping' }), 50000);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === 'state') {
      state = msg;
      render();
    } else if (msg.t === 'error') {
      flash('room-error', msg.msg);
    } else if (msg.t === 'kicked') {
      leaving = true;
      goHome(msg.reason);
    }
  };

  ws.onclose = (ev) => {
    clearInterval(pingTimer);
    setConn('off');
    if (leaving) return;
    // Los códigos 4xxx los cierra el servidor a propósito. Reintentar es
    // discutir con una decisión ya tomada, y como el socket llegó a abrirse
    // el contador de intentos volvió a cero: reconectaríamos cada segundo,
    // para siempre, y cada intento cuesta un request.
    if (ev.code >= 4000) {
      goHome('Se cerró la conexión con la sala. Volvé a entrar en un momento.');
      return;
    }
    retries++;
    const wait = Math.min(1000 * 2 ** (retries - 1), 15000);
    reconnectTimer = setTimeout(() => connect(code), wait);
  };
}

function goHome(message) {
  leaving = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  try {
    ws?.close();
  } catch {
    /* ya cerrado */
  }
  ws = null;
  state = null;
  roomCode = null;
  lastRound = -1;
  lastGame = -1;
  document.title = 'Fijos y Picas';
  history.pushState({}, '', '/');
  show('screen-room', false);
  show('screen-home', true);
  if (message) flash('home-error', message);
}

// -------------------------------------------------------------- acciones

/**
 * El aviso de saturación no es un error del jugador y no se va solo: mientras
 * esté puesto, la sala no se puede crear. Entrar con un código sigue andando,
 * y eso hay que decirlo o parece que se rompió todo.
 */
function setBusy(msg) {
  const node = $('home-busy');
  node.textContent = msg
    ? `${msg} Si te pasaron un código, podés entrar igual.`
    : '';
  node.classList.toggle('hidden', !msg);
}

async function createRoom() {
  const name = $('home-name').value.trim();
  if (!name) return flash('home-error', 'Poné tu nombre primero.');
  store.name = name;
  const mode = document.querySelector('input[name="mode"]:checked')?.value ?? 'sim';
  $('btn-create').disabled = true;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, max: Number($('home-max').value) }),
    });

    // El cuerpo puede no ser JSON: si algún día frena el borde de Cloudflare en
    // vez del Worker, lo que llega es una página de error.
    const data = await res.json().catch(() => ({}));

    if (res.status === 429) {
      setBusy(data.error ?? 'Ahora mismo no se pueden crear salas nuevas. Probá de nuevo en un minuto.');
      return;
    }
    setBusy('');
    if (!res.ok) throw new Error(data.error ?? 'No se pudo crear la sala.');
    history.pushState({}, '', `/r/${data.code}`);
    connect(data.code);
  } catch (err) {
    flash('home-error', String(err.message ?? err));
  } finally {
    $('btn-create').disabled = false;
  }
}

function joinRoom() {
  const name = $('home-name').value.trim();
  if (!name) return flash('home-error', 'Poné tu nombre primero.');
  const code = $('home-code').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4,8}$/.test(code)) return flash('home-error', 'Ese código no parece válido.');
  store.name = name;
  history.pushState({}, '', `/r/${code}`);
  connect(code);
}

function submitSecret() {
  const value = secretPad.value;
  if (!validSecret(value)) {
    return flash('secret-error', 'Tienen que ser 4 dígitos del 1 al 9, sin repetir.');
  }
  flash('secret-error', '');
  send({ t: 'setSecret', secret: value });
}

function submitGuess() {
  const value = guessPad.value;
  if (!validSecret(value)) {
    return flash('guess-error', 'Tienen que ser 4 dígitos del 1 al 9, sin repetir.');
  }
  flash('guess-error', '');
  send({ t: 'guess', guess: value });
}

// ---------------------------------------------------------------- pintado

function nameOf(id) {
  return state.players.find((p) => p.id === id)?.name ?? '?';
}

function playerEl(p, opts = {}) {
  const row = el('div', 'player');
  if (p.id === state.you.id) row.classList.add('is-you');
  if (opts.turnId && p.id === opts.turnId) row.classList.add('is-turn');
  if (p.status === 'won') row.classList.add('won');

  row.appendChild(el('span', `dot ${p.connected ? '' : 'off'}`));
  const who = el('span', 'who', p.name + (p.id === state.you.id ? ' (vos)' : ''));
  row.appendChild(who);

  const tag = el('span', 'tag');
  if (p.id === state.hostId) tag.appendChild(el('span', null, 'anfitrión'));
  if (opts.tag) tag.appendChild(el('span', null, opts.tag));
  if (p.secret) tag.appendChild(el('span', 'num', p.secret));

  // Reordenar el círculo, un lugar por vez.
  if (opts.move) {
    for (const [dir, glifo, label] of [[-1, '▲', 'Subir'], [1, '▼', 'Bajar']]) {
      const btn = el('button', 'ctl', glifo);
      btn.title = `${label} a ${p.name}`;
      btn.setAttribute('aria-label', `${label} a ${p.name} en el círculo`);
      btn.disabled = dir < 0 ? opts.index === 0 : opts.index === opts.total - 1;
      btn.onclick = () => send({ t: 'move', id: p.id, dir });
      tag.appendChild(btn);
    }
  }

  if (opts.crown && p.id !== state.you.id && p.id !== state.hostId) {
    const btn = el('button', 'ctl crown', '👑');
    btn.title = `Hacer anfitrión a ${p.name}`;
    btn.setAttribute('aria-label', `Hacer anfitrión a ${p.name}`);
    btn.onclick = () => {
      if (confirm(`¿Dejarle la sala a ${p.name}? Vos dejás de ser el anfitrión y no lo podés deshacer solo.`)) {
        send({ t: 'makeHost', id: p.id });
      }
    };
    tag.appendChild(btn);
  }

  if (opts.kickable && p.id !== state.you.id) {
    // Antes de empezar se va de la sala; en partida queda retirado, porque
    // sacarlo del círculo cambiaría a quién le adivina cada uno.
    const enJuego = state.phase === 'playing' || state.phase === 'intermission';
    const btn = el('button', 'kick', '✕');
    btn.title = enJuego ? `Retirar a ${p.name} de la partida` : `Sacar a ${p.name} de la sala`;
    btn.onclick = () => {
      const aviso = enJuego
        ? `¿Retirar a ${p.name} de la partida? Deja de jugar, pero su número sigue en el círculo.`
        : `¿Sacar a ${p.name} de la sala?`;
      if (confirm(aviso)) send({ t: 'kick', id: p.id });
    };
    tag.appendChild(btn);
  }
  row.appendChild(tag);
  return row;
}

function applyMark(btn, digit, value) {
  btn.className = `dg${MARK_CLASS[value] ? ' ' + MARK_CLASS[value] : ''}`;
  btn.title = MARK_LABEL[value];
  btn.setAttribute('aria-label', `${digit}: ${MARK_LABEL[value]}`);
}

/** Cada dígito cicla nada → no está → pica → fijo → nada. */
function digitEl(entry, pos) {
  const digit = entry.guess[pos];
  const btn = el('button', 'dg', digit);
  applyMark(btn, digit, marks.get(entry.n)[pos]);
  btn.onclick = () => {
    const next = (marks.get(entry.n)[pos] + 1) % 4;
    marks.set(entry.n, pos, next);
    applyMark(btn, digit, next);
  };
  return btn;
}

function tryEl(entry, index, annotate) {
  const row = el('div', 'try');
  if (entry.fijos === 4) row.classList.add('hit');
  if (entry.skipped) row.classList.add('skip');
  row.appendChild(el('span', 'idx', `${index}`));

  if (entry.skipped) {
    row.appendChild(el('span', 'digits', 'pasó el turno'));
    return row;
  }

  if (annotate) {
    const digits = el('span', 'digits notes');
    for (let i = 0; i < 4; i++) digits.appendChild(digitEl(entry, i));
    row.appendChild(digits);
  } else {
    row.appendChild(el('span', 'digits', entry.guess));
  }

  const badges = el('span', 'marks');
  badges.appendChild(el('span', 'mark f', `${entry.fijos} ${entry.fijos === 1 ? 'fijo' : 'fijos'}`));
  badges.appendChild(el('span', 'mark p', `${entry.picas} ${entry.picas === 1 ? 'pica' : 'picas'}`));
  row.appendChild(badges);
  return row;
}

function renderBoard(container, entries, { annotate = false, empty = 'Todavía no arriesgaste nada.' } = {}) {
  container.replaceChildren();
  if (!entries.length) {
    // Con `empty` vacío no ponemos nada: es el caso del tablero que ya tiene
    // la fila de entrada justo debajo.
    if (empty) container.appendChild(el('p', 'empty', empty));
    return;
  }
  entries.forEach((e, i) => container.appendChild(tryEl(e, i + 1, annotate)));
}

function renderFeed(container) {
  container.replaceChildren();
  const rounds = [...new Set(state.log.map((e) => e.round))].sort((a, b) => b - a);
  if (!rounds.length) {
    container.appendChild(el('p', 'empty hint', 'Sin intentos todavía.'));
    return;
  }
  for (const r of rounds) {
    container.appendChild(el('div', 'round-sep', `Ronda ${r}`));
    for (const e of state.log.filter((x) => x.round === r)) {
      const line = el('div', 'line');
      if (e.fijos === 4) line.classList.add('hit');
      if (e.playerId === state.you.id) line.classList.add('mine');
      line.appendChild(el('span', 'who', e.playerName));
      line.appendChild(el('span', 'arrow', '→'));
      line.appendChild(el('span', 'who', e.targetName));
      if (e.skipped) {
        line.appendChild(el('span', 'arrow', 'pasó'));
      } else {
        line.appendChild(el('span', 'digits', e.guess));
        const marks = el('span', 'marks');
        marks.appendChild(el('span', 'mark f', `${e.fijos}F`));
        marks.appendChild(el('span', 'mark p', `${e.picas}P`));
        line.appendChild(marks);
      }
      container.appendChild(line);
    }
  }
}

function circleText() {
  if (state.players.length < 2) return 'hacen falta al menos 2 jugadores';
  return state.players.map((p) => p.name).join(' → ') + ' → ' + state.players[0].name;
}

function render() {
  if (!state) return;
  const you = state.you;
  const me = state.players.find((p) => p.id === you.id);
  const isHost = you.isHost;
  marks.use(state.code, state.game);

  // Limpiar el pad cuando cambia la ronda o empieza otra partida.
  if (state.round !== lastRound || state.game !== lastGame) {
    if (lastRound !== -1) guessPad.clear();
    lastRound = state.round;
    lastGame = state.game;
  }

  for (const v of ['lobby', 'secret', 'playing', 'intermission', 'finished']) {
    show(`view-${v}`, state.phase === v);
  }

  if (state.phase === 'lobby') renderLobby(isHost);
  if (state.phase === 'secret') renderSecret(me);
  if (state.phase === 'playing') renderPlaying(me);
  if (state.phase === 'intermission') renderIntermission(me);
  if (state.phase === 'finished') renderFinished(isHost);
  lastPhase = state.phase;

  // Herramientas del anfitrión, para destrabar cuando alguien desaparece
  const canSkip = isHost && state.phase === 'playing';
  const canEnd = isHost && (state.phase === 'playing' || state.phase === 'intermission');
  $('btn-skip').textContent =
    state.mode === 'strict' ? 'Saltear turno' : 'Cerrar ronda sin los que faltan';
  show('btn-skip', canSkip);
  show('btn-end', canEnd);
  show('host-tools', canSkip || canEnd);
}

function renderLobby(isHost) {
  const list = $('lobby-players');
  list.replaceChildren();
  state.players.forEach((p, index) => {
    list.appendChild(
      playerEl(p, {
        kickable: isHost,
        crown: isHost,
        move: isHost && state.players.length > 1,
        index,
        total: state.players.length,
      }),
    );
  });
  $('lobby-circle').textContent = circleText();
  show('lobby-host', isHost);
  show('lobby-order-hint', isHost && state.players.length > 1);
  show('lobby-wait', !isHost);
  const radio = document.querySelector(`input[name="rmode"][value="${state.mode}"]`);
  if (radio) radio.checked = true;

  // El cupo no puede bajar de los que ya están adentro: entraron de buena fe.
  const piso = Math.max(state.minPlayers, state.players.length);
  fillRange($('lobby-max'), piso, state.maxPlayersCap ?? state.maxPlayers, state.maxPlayers);
  const libres = state.maxPlayers - state.players.length;
  $('lobby-max-hint').textContent = libres > 0
    ? `Son ${state.players.length} y todavía entran ${libres}.`
    : 'La sala está llena: no entra nadie más.';

  $('btn-start').disabled = state.players.length < state.minPlayers;
}

function renderSecret(me) {
  const ready = !!me?.ready;
  secretPad.disabled = ready;
  secretPad.locked = ready;
  if (ready && state.you.secret) secretPad.value = state.you.secret;
  show('btn-secret', !ready);
  show('btn-secret-random', !ready);
  show('btn-secret-edit', ready);

  const list = $('secret-players');
  list.replaceChildren();
  for (const p of state.players) {
    list.appendChild(
      playerEl(p, {
        tag: p.ready ? 'listo' : 'eligiendo…',
        kickable: state.you.isHost,
        crown: state.you.isHost,
      }),
    );
  }
  // Solo al entrar a la pantalla: si no, cada vez que llega alguien te roba el cursor.
  if (!ready && lastPhase !== 'secret') secretPad.focus();
}

function renderPlaying(me) {
  const you = state.you;
  const myTurn =
    me?.status === 'playing' &&
    (state.mode === 'strict' ? state.turnId === you.id : state.waitingOn.includes(you.id));

  const banner = $('turn-banner');
  banner.classList.toggle('mine', myTurn);
  if (me?.status !== 'playing') {
    banner.textContent =
      me?.status === 'won'
        ? 'Ya adivinaste. Mirá cómo la sufre el resto.'
        : 'Ya no estás jugando esta partida, pero podés seguir mirando.';
  } else if (state.mode === 'strict') {
    banner.textContent = myTurn ? '¡Es tu turno!' : `Turno de ${nameOf(state.turnId)}`;
  } else {
    banner.textContent = myTurn
      ? `Ronda ${state.round} — mandá tu intento`
      : `Esperando a ${state.waitingOn.map(nameOf).join(', ') || '…'}`;
  }

  $('target-name').textContent = nameOf(you.targetId);
  // En simultáneo podés escribir (y corregir) mientras el resto piensa.
  const canSend = me?.status === 'playing' && (state.mode === 'strict' ? myTurn : true);
  guessPad.disabled = !canSend;
  $('btn-guess').disabled = !canSend;
  $('btn-guess').textContent = you.pending ? 'Cambiar mi intento' : 'Arriesgar';

  if (you.pending && guessPad.value !== you.pending) guessPad.value = you.pending;

  // La fila de entrada solo existe mientras te quede algo por arriesgar.
  const mine = state.log.filter((e) => e.playerId === you.id);
  const playing = me?.status === 'playing';
  show('guess-row', playing);
  show('btn-guess', playing);
  $('guess-idx').textContent = `${mine.length + 1}`;
  $('guess-row').classList.toggle('active', canSend);
  $('guess-slot').textContent = you.pending ? 'enviado' : '?';

  let note = '';
  if (state.mode === 'sim' && you.pending) {
    note = 'Ya mandaste tu intento. Podés cambiarlo hasta que jueguen todos.';
  } else if (state.overtime) {
    note = 'Tiempo de descuento: seguís jugando por el gusto de encontrarlo.';
  }
  $('guess-note').textContent = note;

  const scoreboard = $('scoreboard');
  scoreboard.replaceChildren();
  for (const p of state.players) {
    let tag = '';
    if (p.status === 'won') tag = `ganó en la ronda ${p.wonRound}`;
    else if (p.status === 'quit') tag = 'se retiró';
    else if (state.mode === 'sim') tag = state.waitingOn.includes(p.id) ? 'pensando…' : 'ya mandó';
    else if (state.turnId === p.id) tag = 'juega';
    scoreboard.appendChild(
      playerEl(p, {
        tag,
        turnId: state.turnId,
        kickable: you.isHost && p.status === 'playing',
        crown: you.isHost,
      }),
    );
  }

  renderBoard($('my-board'), mine, { annotate: true, empty: '' });

  // Tu propio número, para seguir de cerca cuánto le falta al que te adivina.
  $('my-secret').textContent = you.secret ?? '····';
  const rival = state.players.find((p) => p.targetId === you.id);
  $('against-hint').textContent = rival ? `Lo que te viene arriesgando ${rival.name}:` : '';
  renderBoard($('against-me'), state.log.filter((e) => e.targetId === you.id), {
    empty: 'Todavía no te tiraron nada.',
  });

  renderFeed($('feed'));

  document.title = myTurn ? '▶ Te toca · Fijos y Picas' : 'Fijos y Picas';
}

function renderIntermission(me) {
  const winners = state.players.filter((p) => p.status === 'won');
  const box = $('inter-winners');
  box.replaceChildren();
  for (const w of winners) {
    const line = el('div', 'winner');
    line.appendChild(el('b', null, w.name));
    line.append(` le sacó el número a ${nameOf(w.targetId)} en la ronda ${w.wonRound}: `);
    line.appendChild(el('span', 'num', state.players.find((p) => p.id === w.targetId)?.secret ?? '····'));
    box.appendChild(line);
  }

  const pending = me?.status === 'playing' && me?.decision === null;
  show('inter-choice', pending);
  show('inter-wait', !pending && me?.status === 'playing');
  renderBoard($('inter-board'), state.log.filter((e) => e.playerId === state.you.id), { annotate: true });
  document.title = pending ? '▶ Te toca decidir · Fijos y Picas' : 'Fijos y Picas';
}

function renderFinished(isHost) {
  const podium = $('final-podium');
  podium.replaceChildren();
  const winners = state.players
    .filter((p) => p.status === 'won')
    .sort((a, b) => a.wonRound - b.wonRound);

  if (!winners.length) {
    podium.appendChild(el('div', 'winner late', 'Nadie llegó a adivinar. Otra vez será.'));
  }
  const best = winners[0]?.wonRound;
  for (const w of winners) {
    const line = el('div', `winner ${w.wonRound === best ? '' : 'late'}`);
    line.appendChild(el('b', null, w.name));
    line.append(` — ronda ${w.wonRound}${w.wonRound === best ? ' 🏆' : ''}`);
    podium.appendChild(line);
  }

  const list = $('final-secrets');
  list.replaceChildren();
  for (const p of state.players) {
    let tag = '';
    if (p.status === 'won') tag = `adivinó en la ronda ${p.wonRound}`;
    else if (p.status === 'quit') tag = 'se retiró';
    else tag = 'no lo encontró';
    list.appendChild(playerEl(p, { tag }));
  }

  // Tu tablero con tus marcas intactas, ahora contra el número verdadero.
  const target = state.players.find((p) => p.id === state.you.targetId);
  $('final-target-line').textContent = target
    ? `El número de ${target.name} era ${target.secret ?? '····'}. Tus marcas quedaron como las dejaste.`
    : '';
  renderBoard($('final-board'), state.log.filter((e) => e.playerId === state.you.id), {
    annotate: true,
    empty: 'No llegaste a arriesgar nada.',
  });

  renderFeed($('final-feed'));
  show('btn-rematch', isHost);
  show('final-wait', !isHost);
  document.title = 'Fijos y Picas';
}

// ------------------------------------------------------------------ eventos

$('btn-create').onclick = createRoom;
$('btn-join').onclick = joinRoom;
$('home-code').addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom());
$('home-name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('home-code').value ? joinRoom() : createRoom()));

$('btn-copy').onclick = async () => {
  const link = `${location.origin}/r/${roomCode}`;
  try {
    await navigator.clipboard.writeText(link);
    $('btn-copy').textContent = '¡Copiado!';
    setTimeout(() => ($('btn-copy').textContent = 'Copiar link'), 1800);
  } catch {
    flash('room-error', link);
  }
};

$('btn-leave').onclick = () => {
  const enJuego = state && (state.phase === 'playing' || state.phase === 'intermission');
  if (enJuego && !confirm('La partida ya empezó: si te vas quedás retirado y no podés volver a entrar. ¿Seguro?')) {
    return;
  }
  send({ t: 'leave' });
  goHome();
};

$('lobby-max').onchange = (e) => send({ t: 'setMax', max: Number(e.target.value) });
$('btn-shuffle').onclick = () => send({ t: 'shuffle' });
$('btn-start').onclick = () => send({ t: 'start' });
document.querySelectorAll('input[name="rmode"]').forEach((r) => {
  r.onchange = () => send({ t: 'setMode', mode: r.value });
});

$('btn-secret').onclick = submitSecret;
$('btn-secret-random').onclick = () => {
  secretPad.value = randomSecret();
};
$('btn-secret-edit').onclick = () => {
  send({ t: 'unsetSecret' });
  secretPad.clear();
};

$('btn-guess').onclick = submitGuess;
$('btn-continue').onclick = () => send({ t: 'decide', continue: true });
$('btn-quit').onclick = () => send({ t: 'decide', continue: false });
$('btn-rematch').onclick = () => send({ t: 'rematch' });
$('btn-skip').onclick = () => send({ t: 'skip' });
$('btn-end').onclick = () => {
  if (confirm('¿Terminar la partida para todos y revelar los números?')) send({ t: 'endGame' });
};

// -------------------------------------------------------------------- arranque

$('home-name').value = store.name;
fillRange($('home-max'), MIN_JUGADORES, CAP_JUGADORES, CAP_JUGADORES);

const match = location.pathname.match(/^\/r\/([A-Za-z2-9]{4,8})\/?$/);
if (match) {
  const code = match[1].toUpperCase();
  if (store.name) {
    connect(code);
  } else {
    $('home-code').value = code;
    flash('home-error', `Poné tu nombre para entrar a la sala ${code}.`);
    $('home-name').focus();
  }
}
