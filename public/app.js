/* Fijos y Picas — cliente. Sin build, sin dependencias. */

// El único import del cliente, y es a otro archivo de `public/`. Está aparte
// porque no toca el DOM y así la suite lo prueba sin navegador; el navegador lo
// resuelve solo, porque `app.js` entra como `type="module"`.
import { DIAS_A_LA_VISTA, anotarDia, fechaDeHoy, resumen } from './racha.js';

const $ = (id) => document.getElementById(id);

/**
 * La misma forma que `isValidCode` en src/game.js: cinco caracteres del
 * alfabeto que genera los códigos, sin I, O, 0 ni 1 —se dictan por teléfono—.
 * El cliente no importa nada del servidor, así que la copia se mantiene a mano;
 * si allá cambia el largo o el alfabeto, cambia acá.
 *
 * Vale la pena tenerla: un código imposible rechazado en el navegador no abre
 * un websocket, y cada apertura cuesta un request y come del límite por IP.
 */
const CODIGO_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;
const CODIGO_MAL = 'Los códigos son de 5 caracteres, y no llevan I, O, 0 ni 1.';

/**
 * La clave de prueba, si vino en la URL (`?prueba=...`). No se guarda en
 * `localStorage` a propósito: pegada quedaría marcando partidas de verdad sin
 * que nadie se entere, que es peor que el problema que vino a resolver. Dura lo
 * que dura la pestaña.
 */
const CLAVE_PRUEBA = new URLSearchParams(location.search).get('prueba') ?? '';

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

/**
 * El historial del desafío, que es de donde sale la racha. Todo el cálculo está
 * en `racha.js`; acá está lo único que ese archivo no puede hacer sin navegador,
 * que es leerlo y guardarlo.
 *
 * No se lee una vez y se cachea: dos pestañas abiertas son el mismo jugador y
 * comparten `localStorage`, así que la que quedó abierta desde ayer tiene que
 * ver lo que se anotó en la otra.
 */
const historial = {
  key: 'fp:racha',
  leer() {
    try {
      const data = JSON.parse(localStorage.getItem(this.key) ?? '{}');
      // Un JSON válido puede no ser un historial: si alguien lo tocó a mano, se
      // arranca de cero en vez de romper la portada entera.
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  },
  anotar(fecha, resultado) {
    const antes = this.leer();
    const ya = antes[fecha];
    // El render corre en cada intento y el desafío se termina una sola vez, así
    // que casi siempre no hay nada nuevo que escribir.
    if (ya && ya.n === resultado.n && ya.gano === resultado.gano && ya.encontro === resultado.encontro) {
      return;
    }
    try {
      localStorage.setItem(this.key, JSON.stringify(anotarDia(antes, fecha, resultado)));
    } catch {
      /* sin espacio: la racha de hoy no queda anotada, y el desafío sigue igual */
    }
  },
};

// Para armar el selector de la pantalla de inicio, donde todavía no hay sala
// de la cual sacarlos. Quien manda es el servidor: recorta lo que le mandes.
const CAP_JUGADORES = 12;
const MIN_JUGADORES = 2;

// Cómo se presenta cada nivel de la máquina. Describen cómo juega, no cuán
// buena es: "difícil" no dice nada, "metódica" sí.
const NIVEL_TEXTO = { facil: 'distraída', normal: 'atenta', dificil: 'metódica' };

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
let lastRound = -1; // cuántos intentos tuyos llevabas en el último render
let lastGame = -1;
let lastPhase = null;

/**
 * La pausa de la máquina.
 *
 * El servidor resuelve su jugada en el mismo instante que la tuya, así que las
 * dos llegan en el mismo estado y aparecían en el mismo parpadeo: se sentía un
 * `console.log`, no un rival. Acá se retiene **solo lo suyo** un momento —tu
 * resultado se ve al toque— y después se revela.
 *
 * Es maquillaje del cliente y nada más: el resultado ya está decidido del lado
 * del servidor y esto no lo puede alterar. Si algo falla, lo peor que pasa es
 * que la jugada aparezca antes de tiempo.
 */
const DEMORA_BOT_MS = 1000;

let puedoArriesgar = false; // si además de escribir, ya se puede mandar
let mostrados = new Set(); // entradas del historial ya reveladas
let retenidos = new Set(); // entradas de la máquina esperando su momento
let timerBot = null;

/** El historial como lo tiene que ver la persona en este instante. */
function logVisible() {
  if (!retenidos.size) return state.log;
  return state.log.filter((e) => !retenidos.has(e.n));
}

function soltarRetenidos() {
  clearTimeout(timerBot);
  timerBot = null;
  for (const n of retenidos) mostrados.add(n);
  retenidos.clear();
}

function aplicarEstado(nuevo) {
  const previo = state;
  const idsBot = new Set(nuevo.players.filter((p) => p.bot).map((p) => p.id));

  // No se dosifica al entrar, sin máquina, en otra partida, ni cuando la ronda
  // cerró la fase: retener la jugada ganadora mientras la pantalla ya cambió
  // sería peor que mostrarla.
  const dosificar =
    idsBot.size > 0 &&
    previo &&
    previo.game === nuevo.game &&
    previo.phase === 'playing' &&
    nuevo.phase === 'playing';

  soltarRetenidos();
  state = nuevo;

  if (!dosificar) {
    mostrados = new Set(nuevo.log.map((e) => e.n));
    render();
    return;
  }

  const suyos = nuevo.log.filter((e) => idsBot.has(e.playerId) && !mostrados.has(e.n));
  for (const e of nuevo.log) if (!idsBot.has(e.playerId)) mostrados.add(e.n);

  if (!suyos.length) {
    render();
    return;
  }

  retenidos = new Set(suyos.map((e) => e.n));
  render();
  timerBot = setTimeout(() => {
    soltarRetenidos();
    render();
  }, DEMORA_BOT_MS);
}

/** ¿La máquina está por mostrar una jugada? Para el cartelito de "pensando". */
const maquinaPensando = () => retenidos.size > 0;

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

/**
 * `persistente` es para los avisos que ya están cuando se abre la página: esos
 * no los disparó un gesto de nadie, así que no sabemos cuándo los van a mirar
 * y no pueden vencerse a los 5 segundos. Se van cuando dejan de ser ciertos.
 */
function flash(id, msg, persistente = false) {
  const node = $(id);
  node.textContent = msg;
  node.classList.toggle('hidden', !msg);
  clearTimeout(node._t);
  if (msg && !persistente) {
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

/**
 * Mientras tenga el id de un cartel, todavía no entramos a la sala: es dónde
 * va a caer el "no existe" si el servidor rechaza. Se apaga con el primer
 * estado, que es el único momento en que sabemos que estamos adentro.
 *
 * No hay una consulta previa que pregunte si el código existe: la hubo, y se
 * sacó porque servía para barrer códigos a ver cuáles había (ver src/index.js).
 * El websocket ya trae la respuesta; lo único que hacía falta era esperarla
 * antes de cambiar de pantalla.
 */
let esperandoEntrar = null;

/** El primer estado es la confirmación: recién ahí se cambia de pantalla. */
function entrar(code) {
  if (!esperandoEntrar) return;
  flash(esperandoEntrar, ''); // el rechazo anterior ya no describe nada
  esperandoEntrar = null;
  botonEntrar(true);
  history.pushState({}, '', `/r/${code}`);
  show('screen-home', false);
  show('screen-room', true);
}

function botonEntrar(listo) {
  $('btn-join').disabled = !listo;
  $('btn-join').textContent = listo ? 'Entrar' : 'Entrando…';
}

/**
 * Rechazados antes de entrar: seguimos en la pantalla de inicio, así que el
 * motivo va al cartel del bloque donde se escribió el código y no hay a dónde
 * volver. No se reintenta: un código que no existe no mejora con insistir, y
 * cada intento cuesta un request.
 */
function noSePudoEntrar(motivo) {
  const destino = esperandoEntrar;
  esperandoEntrar = null;
  roomCode = null;
  clearInterval(pingTimer);
  botonEntrar(true);
  flash(destino, motivo);
}

/**
 * Cierra el socket vigente y, sobre todo, lo desarma.
 *
 * Desarmarlo es lo que importa: `close()` no termina en el acto y su `onclose`
 * llega después, cerrado sobre el código de *su* sala. Con solo `leaving` no
 * alcanzaba —salir y entrar a otra sala lo vuelve a poner en falso antes de
 * que el evento viejo llegue—, así que ese `onclose` lo leía como una caída y
 * reconectaba a la sala anterior. Un segundo más tarde, el primer escalón del
 * backoff, la pantalla se llenaba con los jugadores de la que habías dejado.
 */
function cerrarSocket() {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try {
    ws.close();
  } catch {
    /* ya cerrado */
  }
  ws = null;
}

function connect(code, avisarEn = null) {
  cerrarSocket();
  roomCode = code;
  leaving = false;
  esperandoEntrar = avisarEn;
  clearTimeout(reconnectTimer);
  setConn('wait');
  if (avisarEn) {
    flash(avisarEn, '');
    botonEntrar(false);
  } else {
    show('screen-home', false);
    show('screen-room', true);
  }
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
      entrar(code);
      aplicarEstado(msg);
    } else if (msg.t === 'error') {
      flash('room-error', msg.msg);
    } else if (msg.t === 'kicked') {
      leaving = true;
      if (esperandoEntrar) noSePudoEntrar(msg.reason);
      else goHome(msg.reason);
    }
  };

  ws.onclose = (ev) => {
    clearInterval(pingTimer);
    setConn('off');
    if (leaving) return;
    // Se cayó sin haber llegado a entrar: no hay sala de la cual volver, y el
    // motivo no viajó (un 429 en el handshake no deja leer el cuerpo).
    if (esperandoEntrar) {
      noSePudoEntrar('No se pudo entrar a la sala. Probá de nuevo en un momento.');
      return;
    }
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
  esperandoEntrar = null;
  botonEntrar(true);
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  cerrarSocket();
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

/** El aviso de saturación no es un error del jugador: va en su propio cartel. */
function setBusy(msg) {
  const node = $('home-busy');
  node.textContent = msg ?? '';
  node.classList.toggle('hidden', !msg);
}

/**
 * Deja el botón apagado mientras no tenga sentido apretarlo, con la cuenta
 * regresiva a la vista: un botón gris sin explicación se lee como "se rompió".
 */
let bloqueo = null;

// Las dos formas de crear sala pasan por el mismo límite, así que se apagan
// juntas: dejar una prendida es prometer algo que va a fallar igual. La cuenta
// va en las dos porque el cartel que explica el bloqueo está arriba de todo, y
// desde el botón que apretaste puede no verse.
const BOTONES_DE_CREAR = { 'btn-create': 'Crear sala', 'btn-bot': 'Jugar contra la máquina' };

function bloquearCreacion(segundos, msg) {
  setBusy(msg);
  clearInterval(bloqueo);
  let quedan = segundos;
  for (const id of Object.keys(BOTONES_DE_CREAR)) $(id).disabled = true;
  const tick = () => {
    if (quedan <= 0) {
      clearInterval(bloqueo);
      bloqueo = null;
      for (const [id, etiqueta] of Object.entries(BOTONES_DE_CREAR)) {
        $(id).disabled = false;
        $(id).textContent = etiqueta;
      }
      setBusy('');
      return;
    }
    for (const [id, etiqueta] of Object.entries(BOTONES_DE_CREAR)) {
      $(id).textContent = `${etiqueta} (${quedan})`;
    }
    quedan--;
  };
  tick();
  bloqueo = setInterval(tick, 1000);
}

/**
 * A qué hora local se repone el cupo diario del plan. Es medianoche UTC, que
 * cae a distinta hora según dónde esté cada uno, así que se calcula acá en vez
 * de escribir "a las 21" y errarle a la mitad de la gente.
 */
function horaDeReposicion() {
  const hoy = new Date();
  const reset = new Date(Date.UTC(
    hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() + 1, 0, 0, 0,
  ));
  // La hora es la local de cada uno, pero el formato va en el idioma de la
  // interfaz: "21:00" y no "09:00 PM" en el medio de un texto en castellano.
  return reset.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/**
 * Contra la máquina: una sala de dos, por turnos, con la máquina ya adentro.
 * Es el mismo camino que crear una sala normal — el bot es un jugador más del
 * lado del servidor, así que acá no hay nada especial más que el pedido.
 */
function createBotRoom() {
  const nivel = document.querySelector('input[name="nivel"]:checked')?.value ?? 'normal';
  return createRoom({ mode: 'strict', max: 2, bot: nivel, boton: 'btn-bot', error: 'bot-error' });
}

/**
 * El nombre vive en su propio bloque, arriba, pero el aviso va donde apretaste:
 * un cartel al pie de la pantalla puede quedar fuera de la vista y el botón
 * parece roto. El foco es el que lleva hasta el campo.
 */
function faltaElNombre(destino) {
  flash(destino, 'Poné tu nombre primero.');
  $('home-name').focus();
  return null;
}

async function createRoom(opciones = {}) {
  const error = opciones.error ?? 'create-error';
  const name = $('home-name').value.trim();
  if (!name) return faltaElNombre(error);
  store.name = name;
  const boton = opciones.boton ?? 'btn-create';
  const mode = opciones.mode ?? document.querySelector('input[name="mode"]:checked')?.value ?? 'sim';
  const max = opciones.max ?? Number($('home-max').value);
  $(boton).disabled = true;
  try {
    // La marca va también acá: probar un uno contra uno ensucia los datos
    // igual que probar un desafío, y el servidor ya la acepta en esta puerta.
    const res = await fetch(CLAVE_PRUEBA ? `/api/rooms?prueba=${encodeURIComponent(CLAVE_PRUEBA)}` : '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, max, bot: opciones.bot }),
    });

    // Se lee como texto y después se intenta parsear: cuando el que corta es
    // el borde de Cloudflare y no el Worker, lo que llega es una página HTML.
    const texto = await res.text();
    let data = {};
    try {
      data = JSON.parse(texto);
    } catch {
      /* no es una respuesta nuestra */
    }

    // El 1027 es el cupo diario del plan gratis agotado. No se distingue por el
    // código de estado, pero la página de Cloudflare trae el número adentro.
    if (!res.ok && texto.includes('1027')) {
      bloquearCreacion(120, `El juego llegó a su límite de uso por hoy. Vuelve a andar a las ${horaDeReposicion()}. No es nada que hayas hecho vos.`);
      return;
    }
    if (res.status === 429) {
      bloquearCreacion(60, `${data.error ?? 'Ahora mismo no se pueden crear salas nuevas.'} Si te pasaron un código, podés entrar igual.`);
      return;
    }
    setBusy('');
    if (!res.ok) throw new Error(data.error ?? 'No se pudo crear la sala.');
    history.pushState({}, '', `/r/${data.code}`);
    connect(data.code);
  } catch (err) {
    flash(error, String(err.message ?? err));
  } finally {
    // Si quedó bloqueado a propósito, la cuenta regresiva es la que manda.
    if (!bloqueo) $(boton).disabled = false;
  }
}

function joinRoom() {
  const name = $('home-name').value.trim();
  if (!name) return faltaElNombre('join-error');
  const code = $('home-code').value.trim().toUpperCase();
  if (!CODIGO_RE.test(code)) return flash('join-error', CODIGO_MAL);
  store.name = name;
  // Sin pushState: la URL cambia recién cuando el servidor confirma la sala.
  connect(code, 'join-error');
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
  // Se puede escribir antes de tiempo, así que Enter tiene que avisar acá y no
  // dejar que el servidor conteste "no es tu turno" como si fuera un error.
  if (!puedoArriesgar) {
    return flash('guess-error', 'Todavía no es tu turno. Cuando llegue, dale a Arriesgar.');
  }
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
  if (p.bot) tag.appendChild(el('span', 'maquina', NIVEL_TEXTO[p.bot] ?? p.bot));
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

  if (opts.crown && !p.bot && p.id !== state.you.id && p.id !== state.hostId) {
    const btn = el('button', 'ctl crown', '👑');
    btn.title = `Hacer anfitrión a ${p.name}`;
    btn.setAttribute('aria-label', `Hacer anfitrión a ${p.name}`);
    btn.onclick = () => {
      // Nombra lo que se pierde, no solo que se pierde: "dejás de ser el
      // anfitrión" no dice nada si no sabés qué hacía el anfitrión.
      const aviso = `¿Dejarle la sala a ${p.name}?\n\nPasa a ser el anfitrión y vos perdés los controles: acomodar el orden, el cupo, el modo, sumar máquinas y empezar la partida.\n\nSolo ${p.name} te los puede devolver.`;
      if (confirm(aviso)) {
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
    // A la máquina se la nombra por lo que es y no como un nombre propio:
    // "sacar a la máquina", no "sacar a La máquina".
    const quien = p.bot ? p.name.charAt(0).toLowerCase() + p.name.slice(1) : p.name;
    btn.title = enJuego ? `Retirar a ${quien} de la partida` : `Sacar a ${quien} de la sala`;
    btn.onclick = () => {
      const aviso = enJuego
        ? `¿Retirar a ${quien} de la partida? Deja de jugar, pero su número sigue en el círculo.`
        : `¿Sacar a ${quien} de la sala?`;
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
  const visible = logVisible();
  const rounds = [...new Set(visible.map((e) => e.round))].sort((a, b) => b - a);
  if (!rounds.length) {
    container.appendChild(el('p', 'empty hint', 'Sin intentos todavía.'));
    return;
  }
  for (const r of rounds) {
    container.appendChild(el('div', 'round-sep', `Ronda ${r}`));
    for (const e of visible.filter((x) => x.round === r)) {
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

  // El pad se limpia cuando jugaste vos, no cuando cambia la ronda: si se
  // limpiara por ronda, borraría el número que estabas escribiendo mientras
  // esperabas tu turno, que es justo lo que se quiere permitir.
  const mios = state.log.filter((e) => e.playerId === you.id).length;
  if (state.game !== lastGame) {
    if (lastGame !== -1) guessPad.clear();
    lastGame = state.game;
    lastRound = mios;
  } else if (mios > lastRound) {
    guessPad.clear();
    // Al primer dígito: quedaba en el último y había que volver a mano cada vez.
    // En el celular además mantiene el teclado arriba entre intento e intento.
    guessPad.focus();
    lastRound = mios;
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

/**
 * El plegable del anfitrión arranca abierto **la primera vez que a alguien le
 * toca serlo**, y cerrado de ahí en más. Cerrado siempre no lo abre nadie —es
 * justo lo que pasaba con la línea que había antes, que estaba a la vista y aun
 * así no se entendía—; abierto siempre le repite la explicación en cada partida
 * al que ya la sabe.
 *
 * Dos cosas que lo hacen andar. Se decide **una sola vez por carga**, porque
 * `renderLobby` corre en cada estado que llega y volvería a abrirle el plegable
 * al que acaba de cerrarlo. Y se marca en `localStorage` para que la segunda
 * partida no vuelva a empezar con un texto largo desplegado; si no hay lugar
 * para escribirlo, lo peor que pasa es que se abra de nuevo la próxima.
 */
let ayudaDelAnfitrionDecidida = false;

function abrirAyudaLaPrimeraVez(isHost) {
  if (!isHost || ayudaDelAnfitrionDecidida) return;
  ayudaDelAnfitrionDecidida = true;
  $('lobby-ayuda').open = !localStorage.getItem('fp:ayuda-anfitrion');
  try {
    localStorage.setItem('fp:ayuda-anfitrion', '1');
  } catch {
    /* sin espacio: se vuelve a abrir la próxima vez, que no es grave */
  }
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
  show('lobby-ayuda', isHost);
  abrirAyudaLaPrimeraVez(isHost);
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

  // El motivo por el que no se puede sumar una máquina no es el mismo, así que
  // no alcanza con apagar el botón: un botón gris sin explicación se lee como
  // que algo se rompió.
  const maquinas = state.players.filter((p) => p.bot).length;
  const tope = state.maxBots ?? 3;
  $('btn-add-bot').disabled = maquinas >= tope || libres <= 0;
  if (maquinas >= tope) {
    $('lobby-bot-hint').textContent = `Ya hay ${maquinas} y son todas las que entran.`;
  } else if (libres <= 0) {
    $('lobby-bot-hint').textContent = 'No hay lugar: subí el cupo para sumar una máquina.';
  } else {
    $('lobby-bot-hint').textContent = 'Ocupa un lugar de la sala y juega sola. La sacás con la ✕, como a cualquiera.';
  }

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
  const playing = me?.status === 'playing';
  const canSend = playing && (state.mode === 'strict' ? myTurn : true);

  // Escribir se puede siempre que sigas en partida, aunque todavía no te toque:
  // pensar el número es la mitad del juego y no tiene por qué empezar recién
  // cuando llega tu turno. Lo que se bloquea es mandarlo, no tipearlo.
  puedoArriesgar = canSend;
  guessPad.disabled = !playing;
  $('btn-guess').disabled = !canSend;
  $('btn-guess').textContent = you.pending ? 'Cambiar mi intento' : 'Arriesgar';

  // No pisar lo que la persona esté tipeando mientras espera.
  if (you.pending && !guessPad.value) guessPad.value = you.pending;

  // La fila de entrada solo existe mientras te quede algo por arriesgar.
  const mine = logVisible().filter((e) => e.playerId === you.id);
  show('guess-row', playing);
  show('btn-guess', playing);
  $('guess-idx').textContent = `${mine.length + 1}`;
  $('guess-row').classList.toggle('active', canSend);
  $('guess-slot').textContent = you.pending ? 'enviado' : canSend ? '?' : 'esperá';

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
    // Sin esto la pausa de la máquina se lee como que se colgó.
    else if (p.bot && maquinaPensando()) tag = 'pensando…';
    // Que se vea por qué la partida no avanza, antes de que se pase su turno.
    else if (!p.connected) tag = 'sin conexión';
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
  renderBoard($('against-me'), logVisible().filter((e) => e.targetId === you.id), {
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
  show('rematch-hint', isHost);
  show('final-wait', !isHost);
  document.title = 'Fijos y Picas';
}

// ------------------------------------------------------------------ eventos

$('btn-create').onclick = () => createRoom();
$('btn-bot').onclick = createBotRoom;
$('btn-join').onclick = joinRoom;
$('home-code').addEventListener('keydown', (e) => e.key === 'Enter' && joinRoom());
$('home-name').addEventListener('keydown', (e) => e.key === 'Enter' && ($('home-code').value ? joinRoom() : createRoom()));

// Un reproche que sigue en pantalla mientras lo estás corrigiendo es ruido: el
// aviso se va en cuanto la persona empieza a hacer lo que le pedimos.
$('home-name').addEventListener('input', () => flash('name-error', ''));
$('home-code').addEventListener('input', () => flash('join-error', ''));

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
$('btn-add-bot').onclick = () => send({ t: 'addBot', nivel: $('lobby-bot').value });
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

// ------------------------------------------------------- desafío del día

/**
 * El desafío es la única parte del juego que no habla por websocket: se juega
 * solo, así que no hay nada que el servidor tenga que empujar. Cada intento es
 * un POST y la respuesta trae el estado entero, que es todo lo que hace falta
 * para volver a dibujar.
 */
let reto = null;

/**
 * La ruta propia del desafío. Es a donde apunta el texto que se comparte, y es
 * la única del cliente además de `/r/CODIGO`.
 *
 * Se escribe una sola vez porque se pregunta dos: al arrancar, para entrar
 * derecho, y al abrir el desafío desde la portada, para no apilar dos veces la
 * misma entrada en el historial del navegador.
 */
const EN_RETO = /^\/reto\/?$/;

const retoPad = new DigitPad($('reto-pad'), () => arriesgarReto());

/**
 * `fecha` es la del desafío que se está jugando, y se manda para poder
 * terminarlo si el día cambia con la pantalla abierta. El servidor solo la
 * acepta para **continuar** algo ya empezado, nunca para empezar: pedir la de
 * ayer en frío sería pedir un número que ya se sabe.
 */
async function pedirReto(metodo = 'GET', cuerpo = null, fecha = null) {
  const opciones = { method: metodo };
  if (cuerpo) {
    opciones.headers = { 'content-type': 'application/json' };
    opciones.body = JSON.stringify(cuerpo);
  }
  const qs = new URLSearchParams({ pid: store.pid });
  if (fecha) qs.set('fecha', fecha);
  if (CLAVE_PRUEBA) qs.set('prueba', CLAVE_PRUEBA);
  try {
    const res = await fetch(`/api/reto?${qs}`, opciones);
    return { ok: res.ok, cuerpo: await res.json() };
  } catch {
    // Sin conexión no hay nada que reintentar solo: el que aprieta decide.
    return { ok: false, cuerpo: { error: 'No se pudo conectar. Fijate la conexión y probá de nuevo.' } };
  }
}

/**
 * `porLaRuta` distingue las dos formas de llegar, y lo único que cambia es
 * cuánto dura el aviso si no se puede abrir. Al que apretó el botón el error se
 * le vence a los cinco segundos, como todos; al que llegó por `/reto` no lo
 * disparó ningún gesto suyo —apareció con la página— y no sabemos cuándo lo va
 * a mirar, así que se queda. Es la misma regla que el link de una sala.
 */
async function abrirReto(porLaRuta = false) {
  flash('reto-error', '');
  $('btn-reto').disabled = true;
  const { ok, cuerpo } = await pedirReto();
  $('btn-reto').disabled = false;
  // El aviso va en el bloque del botón que se apretó, no en un cartel al pie:
  // si falta la clave en el servidor, el desafío contesta que no está
  // disponible y el resto del juego sigue andando. Al que llegó por `/reto` lo
  // deja en la portada con el motivo escrito, que es a dónde puede volver.
  if (!ok) return flash('reto-error', cuerpo.error ?? 'No se pudo abrir el desafío.', porLaRuta);

  reto = cuerpo;
  // Una sola vez, al abrir: en cada render pelearía con el que las cerró a
  // mano. Sin ningún día anotado es la primera vez que juega el desafío —y por
  // `/reto` puede no haber pasado nunca por la portada, que es donde están las
  // reglas del juego.
  $('reto-reglas').open = Object.keys(historial.leer()).length === 0;
  if (!EN_RETO.test(location.pathname)) history.pushState({}, '', '/reto');
  show('screen-home', false);
  show('screen-reto', true);
  renderReto();
  if (!reto.terminado) retoPad.focus();
}

async function arriesgarReto() {
  if (!reto || reto.terminado) return;
  const valor = retoPad.value;
  if (!validSecret(valor)) {
    return flash('reto-guess-error', 'Tienen que ser 4 dígitos del 1 al 9, sin repetir.');
  }
  flash('reto-guess-error', '');
  $('btn-reto-guess').disabled = true;
  const { ok, cuerpo } = await pedirReto('POST', { guess: valor }, reto.fecha);
  $('btn-reto-guess').disabled = false;
  if (!ok) {
    // Cambió el día y se pasaron las horas de gracia. Se le muestra el de hoy,
    // pero diciéndolo: cambiarle el tablero sin aviso se lee como que perdió
    // todo, y lo que pasó es que su desafío se venció.
    if (cuerpo.vencido) return arrancarDeNuevo();
    return flash('reto-guess-error', cuerpo.error ?? 'No se pudo mandar el intento.');
  }

  reto = cuerpo;
  retoPad.clear();
  renderReto();
  if (!reto.terminado) retoPad.focus();
}

/** Se venció el desafío que estaba jugando: se le trae el de hoy y se le dice. */
async function arrancarDeNuevo() {
  const { ok, cuerpo } = await pedirReto();
  if (!ok) return flash('reto-guess-error', cuerpo.error ?? 'No se pudo abrir el desafío.');
  reto = cuerpo;
  retoPad.clear();
  renderReto();
  flash('reto-guess-error', 'Cambió el día: este es el desafío nuevo, y arranca de cero.', true);
  retoPad.focus();
}

function renderReto() {
  if (!reto) return;
  // Las anotaciones se guardan por día, así que el desafío de mañana arranca
  // limpio sin que haya que borrar nada.
  marks.use('reto', reto.fecha);
  $('reto-fecha').textContent = reto.fecha;
  // El tope lo manda el servidor. Se escribe acá en vez de dejarlo fijo en el
  // HTML porque es justo el número que se va a mover cuando se juegue lo
  // suficiente para saber si 12 está bien puesto.
  $('reto-reglas-tope').textContent = reto.tope;
  // Quién manda es el servidor: si la clave no era la buena, `reto.prueba` es
  // falso y la partida cuenta. Un modo invisible es cómo uno termina creyendo
  // que estaba probando cuando no.
  //
  // El segundo caso es el que confunde de verdad, y ya pasó: se puso la clave,
  // no apareció nada, y el silencio se leyó como que la clave estaba mal. La
  // marca se fija **al crear** el desafío, así que sobre uno ya empezado la
  // clave no hace nada. Que lo diga en vez de callarse.
  $('reto-prueba').textContent = textoDeMarca();
  show('reto-prueba', Boolean(textoDeMarca()));

  const n = reto.intentos.length;
  const quedan = reto.tope - n;
  $('reto-banner').textContent = bannerReto(n, quedan);

  // `n` es el índice de la anotación, que acá es la posición en la lista: los
  // intentos solo se agregan al final, así que no se corre nunca.
  renderBoard($('reto-board'), reto.intentos.map((e, i) => ({ ...e, n: i })), {
    annotate: true,
    empty: '',
  });

  // Jugando se ve el pad; en la decisión, los dos botones; terminado, ninguno.
  // Y mientras seguís después del tope queda el de revelar, solo: seguir ya lo
  // elegiste, pero salir tiene que poder hacerse sin llegar a los treinta.
  const jugando = !reto.terminado && !reto.decidiendo;
  $('reto-idx').textContent = `${n + 1}`;
  show('reto-row', jugando);
  show('btn-reto-guess', jugando);
  show('reto-decidir', !reto.terminado && (reto.decidiendo || reto.siguio));
  show('btn-reto-seguir', !!reto.decidiendo);
  retoPad.disabled = !jugando;

  show('reto-final', reto.terminado);
  if (!reto.terminado) return;

  $('reto-final-titulo').textContent = reto.gano ? 'Lo sacaste' : 'Casi';
  $('reto-final-texto').textContent = textoFinalReto(n);
  // Si lo encontraste ya está en el tablero, arriba y marcado: repetirlo abajo
  // es contarte algo que acabás de hacer.
  $('reto-final-numero').textContent = reto.numero ?? '····';
  show('reto-final-numero', !reto.encontro);

  // Las partidas de prueba no entran, por el mismo motivo por el que no entran
  // en la calibración: son de alguien verificando, y una racha inflada a mano
  // no le sirve ni a quien la infló.
  if (!reto.prueba) {
    historial.anotar(reto.fecha, { n, gano: reto.gano, encontro: reto.encontro });
  }
  renderRacha();
}

/**
 * El cartel del modo prueba, o la explicación de por qué no está activo.
 *
 * No se distingue una clave equivocada de un desafío ya empezado —las dos dan
 * lo mismo del lado del servidor— así que el aviso nombra los dos casos en vez
 * de adivinar. Decir "la clave está mal" cuando el problema es otro manda a
 * buscar donde no hay nada.
 */
function textoDeMarca() {
  if (reto.prueba) return 'Modo prueba: esta partida queda marcada y no entra en el análisis.';
  if (!CLAVE_PRUEBA) return '';
  return 'Pusiste la clave de prueba pero el desafío no quedó marcado, así que'
    + ' cuenta como una partida de verdad. O la clave no es la correcta, o este'
    + ' desafío ya estaba empezado sin ella: la marca se fija al crearlo.';
}

/** El cartel de arriba, que cambia según en cuál de los tres momentos estés. */
function bannerReto(n, quedan) {
  if (reto.decidiendo) return `Se te acabaron los doce. ¿Lo seguís buscando?`;
  if (reto.terminado) {
    if (reto.gano) return '¡Lo encontraste!';
    return reto.encontro ? `Lo encontraste, pero fuera de los doce.` : 'Se te acabaron los intentos.';
  }
  if (reto.siguio) return `Vas ${n} intentos, y el desafío ya lo perdiste. A encontrarlo igual.`;
  return `Te ${quedan === 1 ? 'queda' : 'quedan'} ${quedan} de ${reto.tope}.`;
}

function textoFinalReto(n) {
  const veces = `${n} ${n === 1 ? 'intento' : 'intentos'}`;
  if (reto.gano) return `En ${veces}. Mañana hay otro.`;
  // Perdió el desafío pero lo sacó: el número que importa es cuántos necesitó
  // de verdad, y lo interesante es decírselo.
  if (reto.encontro) return `Te llevó ${veces}. El desafío estaba perdido en el doce, pero lo sacaste.`;
  return 'El número era:';
}

// ------------------------------------------------------------------ racha

/**
 * Dibuja la racha en los dos lugares donde va: la línea de la portada y el
 * bloque de la pantalla final. Los dos salen del mismo `resumen`, así que no
 * pueden discrepar.
 *
 * El día lo pone el reloj de acá y no `reto.fecha`: con las tres horas de
 * gracia, uno del 5 se puede terminar el 6, y en ese caso la tira tiene que
 * llegar hasta hoy —con el 5 lleno y el 6 vacío— y no cortar en el 5.
 */
function renderRacha() {
  const r = resumen(historial.leer(), fechaDeHoy());

  const linea = textoRachaHome(r);
  $('home-racha').textContent = linea;
  show('home-racha', Boolean(linea));

  show('reto-racha', r.jugados > 0);
  if (!r.jugados) return;

  $('reto-racha-texto').textContent = textoRachaFinal(r);
  $('reto-racha-pie').textContent = textoRachaPie(r);
  renderDiasDeRacha($('reto-racha-dias'), r.dias);
}

/**
 * La tira de los últimos días.
 *
 * Cada estado tiene **forma propia además de color** —un tilde, una cruz, un
 * más, o nada—, igual que las marcas por dígito: el color solo no puede ser lo
 * único que distingue dos cosas. Y como los glifos no dicen de qué día son, la
 * fecha y el resultado van en el `aria-label`.
 */
function renderDiasDeRacha(cont, dias) {
  cont.replaceChildren();
  for (const d of dias) {
    let cls = 'dia';
    let glifo = '';
    let que = 'no jugaste';

    if (d.entrada?.gano) {
      cls += ' ok';
      glifo = '✓';
      que = `lo sacaste en ${d.entrada.n}`;
    } else if (d.entrada?.encontro) {
      cls += ' tarde';
      glifo = '+';
      que = `lo sacaste en ${d.entrada.n}, fuera de los 12`;
    } else if (d.entrada) {
      cls += ' no';
      glifo = '✕';
      que = 'no lo sacaste';
    }
    if (d.esHoy) cls += ' hoy';

    const nodo = el('span', cls, glifo);
    const [, mes, dia] = d.fecha.split('-');
    nodo.setAttribute('aria-label', `${d.esHoy ? 'Hoy' : `${Number(dia)}/${Number(mes)}`}: ${que}`);
    cont.append(nodo);
  }
}

/**
 * La línea de la portada. **Sin racha no dice nada**: al que llega por primera
 * vez un "racha de 0 días" le explica una función que todavía no le importa, y
 * le ocupa el lugar donde va lo que sí —de qué se trata el desafío—.
 */
function textoRachaHome(r) {
  if (!r.racha) return '';
  if (r.jugoHoy) {
    return r.racha === 1
      ? 'Arrancaste una racha. Volvé mañana y van dos.'
      : `Racha de ${r.racha} días. El de hoy ya está.`;
  }
  return r.racha === 1
    ? 'Ayer jugaste. Con el de hoy van dos.'
    : `Llevás ${r.racha} días seguidos. Jugá el de hoy para no cortarla.`;
}

function textoRachaFinal(r) {
  if (r.racha === 1) return 'Arrancaste una racha: 1 día.';
  // Empatar la mejor cuenta como igualarla, no como quedarse cerca: son los dos
  // el mismo número y decir "tu mejor fue 5" cuando vas 5 se lee como un reproche.
  if (r.racha === r.mejor) return `Racha de ${r.racha} días, y es tu mejor.`;
  return `Racha de ${r.racha} días seguidos.`;
}

function textoRachaPie(r) {
  const jugados = `${r.jugados} ${r.jugados === 1 ? 'desafío jugado' : 'desafíos jugados'}`;
  const sacados = `${r.ganados} ${r.ganados === 1 ? 'sacado' : 'sacados'} en los 12`;
  const mejor = r.racha < r.mejor ? ` · tu mejor racha fue de ${r.mejor} días` : '';
  return `${jugados} · ${sacados}${mejor}`;
}

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * El resumen que se comparte.
 *
 * Va la **forma** de la partida y nada más: ni el número, ni los intentos. Cada
 * fila son los fijos y las picas, y no puede filtrar dónde estaban aunque
 * quisiera — el servidor nunca manda las posiciones, así que el cliente
 * tampoco las tiene.
 *
 * La fecha se arma a mano con el array de meses en vez de con `Intl`: el
 * `fecha` viene como `2026-08-07` y pasarlo por `new Date` lo interpreta en UTC,
 * que del lado de acá puede caer el día anterior. Doce palabras evitan el bug.
 */
function textoParaCompartir() {
  const [, mes, dia] = reto.fecha.split('-').map(Number);
  const n = reto.intentos.length;
  const veces = `${n} ${n === 1 ? 'intento' : 'intentos'}`;

  let titulo;
  if (reto.gano) titulo = `Lo saqué en ${n} de ${reto.tope}`;
  else if (reto.encontro) titulo = `Lo saqué en ${veces}, fuera de los ${reto.tope}`;
  else titulo = `No lo saqué en ${reto.tope}`;

  const filas = reto.intentos.map((e) => {
    const vacios = 4 - e.fijos - e.picas;
    return '🟩'.repeat(e.fijos) + '🟨'.repeat(e.picas) + '⬜'.repeat(vacios);
  });

  // El link va al desafío y no a la portada. Es el momento de más intención que
  // hay —el que lo recibe acaba de ver un resultado— y desde la portada el
  // desafío es la cuarta tarjeta: hay que buscarlo entre cosas que piden un
  // nombre, un modo y una sala. Un paso de más ahí cuesta caro.
  return `Fijos y Picas · ${dia} de ${MESES[mes - 1]}\n${titulo}\n\n`
    + `${filas.join('\n')}\n\n${location.origin}/reto`;
}

/** Después del tope: seguir buscándolo, o que te lo revelen. */
async function decidirReto(seguir) {
  if (!reto || reto.terminado) return;
  if (seguir && !reto.decidiendo) return;
  $('btn-reto-seguir').disabled = true;
  $('btn-reto-ver').disabled = true;
  const { ok, cuerpo } = await pedirReto('POST', { seguir }, reto.fecha);
  $('btn-reto-seguir').disabled = false;
  $('btn-reto-ver').disabled = false;
  if (!ok) {
    if (cuerpo.vencido) return arrancarDeNuevo();
    return flash('reto-guess-error', cuerpo.error ?? 'No se pudo mandar la decisión.');
  }
  reto = cuerpo;
  renderReto();
  if (!reto.terminado) retoPad.focus();
}

$('btn-reto-compartir').onclick = async () => {
  const texto = textoParaCompartir();
  const boton = $('btn-reto-compartir');
  flash('reto-compartir-aviso', '');

  // En el celular el menú de compartir es el camino natural, y es donde esto
  // sirve de verdad. En escritorio casi nunca existe y el portapapeles alcanza.
  if (navigator.share) {
    try {
      await navigator.share({ text: texto });
      return;
    } catch (err) {
      // Cerrar el menú no es un error: no hay nada que avisarle a nadie.
      if (err?.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(texto);
    boton.textContent = '¡Copiado!';
    setTimeout(() => (boton.textContent = 'Compartir'), 1800);
  } catch {
    // Sin portapapeles —contexto inseguro, o permiso denegado— se muestra el
    // texto para que lo copie a mano. Persistente: no lo disparó un gesto que
    // se pueda repetir sin volver a leerlo.
    flash('reto-compartir-aviso', texto, true);
  }
};

// Envuelto y no `onclick = abrirReto`: el manejador recibe el evento como
// primer argumento, y un MouseEvent es tan verdadero como un `true`.
$('btn-reto').onclick = () => abrirReto();
$('btn-reto-guess').onclick = arriesgarReto;
$('btn-reto-seguir').onclick = () => decidirReto(true);
$('btn-reto-ver').onclick = () => decidirReto(false);
$('btn-reto-salir').onclick = () => {
  // Igual que al salir de una sala: la URL tiene que decir dónde estás, o
  // recargar te devuelve al desafío que acabás de dejar.
  history.pushState({}, '', '/');
  show('screen-reto', false);
  show('screen-home', true);
};

// -------------------------------------------------------------------- arranque

$('home-name').value = store.name;
fillRange($('home-max'), MIN_JUGADORES, CAP_JUGADORES, CAP_JUGADORES);
renderRacha();

// El patrón de la ruta es más ancho que el de un código válido a propósito: un
// link mal copiado tiene que caer acá adentro para poder explicarlo, y no
// pasar de largo hacia una pantalla de inicio que no dice nada.
const match = location.pathname.match(/^\/r\/([A-Za-z0-9]{1,12})\/?$/);

// `/reto` entra derecho al desafío. Es el link que sale de Compartir, así que
// es por donde llega el que nunca jugó: la portada, de por medio, le pide un
// nombre y le ofrece crear una sala antes de dejarlo hacer lo que vino a hacer.
//
// No hace falta nada del lado del Worker: `not_found_handling` es
// `single-page-application`, así que cualquier ruta que no sea `/api/*` ya
// sirve este mismo HTML. Lo mismo que hace andar a `/r/ABC12`.
if (EN_RETO.test(location.pathname)) {
  abrirReto(true);
} else if (match) {
  const code = match[1].toUpperCase();
  if (!CODIGO_RE.test(code)) {
    history.replaceState({}, '', '/');
    $('home-code').value = code.slice(0, 5);
    flash('join-error', CODIGO_MAL, true);
  } else if (store.name) {
    connect(code);
  } else {
    $('home-code').value = code;
    // Acá no apretó ningún botón: llegó por el link. El aviso va pegado al
    // campo que le falta llenar.
    flash('name-error', `Poné tu nombre para entrar a la sala ${code}.`, true);
    $('home-name').focus();
  }
}
