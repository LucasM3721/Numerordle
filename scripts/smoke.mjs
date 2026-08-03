/**
 * Juega partidas enteras contra un servidor y verifica los invariantes del
 * juego. Es la red de seguridad antes de desplegar: el "build" de este
 * proyecto no mira public/, así que sin esto se puede publicar algo roto.
 *
 *   node --experimental-websocket scripts/smoke.mjs
 *   BASE=https://numerordle.lucasm3721.workers.dev node --experimental-websocket scripts/smoke.mjs
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const TIMEOUT_MS = 10000;

let fallos = 0;
let pruebas = 0;

function chequear(descripcion, ok, detalle) {
  pruebas++;
  if (ok) {
    console.log(`  ok   ${descripcion}`);
  } else {
    fallos++;
    console.log(`  FALLA ${descripcion}${detalle ? ` — ${detalle}` : ''}`);
  }
}

function igual(descripcion, obtenido, esperado) {
  const ok = JSON.stringify(obtenido) === JSON.stringify(esperado);
  chequear(descripcion, ok, ok ? '' : `esperaba ${JSON.stringify(esperado)}, vino ${JSON.stringify(obtenido)}`);
}

// --------------------------------------------------------------- conexión

async function crearSala(mode) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`no se pudo crear la sala: HTTP ${res.status}`);
  return (await res.json()).code;
}

function conectar(code, pid, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws?pid=${pid}&name=${name}`);
    ws.estados = [];
    ws.errores = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') ws.estados.push(m);
      else if (m.t === 'error') ws.errores.push(m.msg);
    });
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error(`no conectó ${name}`)));
  });
}

const decir = (ws, msg) => ws.send(JSON.stringify(msg));
const estado = (ws) => ws.estados.at(-1);

/** Espera a que se cumpla una condición en vez de dormir a ciegas: en CI las
 *  esperas fijas son la principal fuente de pruebas que fallan sin motivo. */
async function esperar(ws, condicion, queEsperaba) {
  const limite = Date.now() + TIMEOUT_MS;
  while (Date.now() < limite) {
    if (estado(ws) && condicion(estado(ws))) return estado(ws);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`se agotó el tiempo esperando: ${queEsperaba}`);
}

const esperarError = async (ws, cuantos) => {
  const limite = Date.now() + TIMEOUT_MS;
  while (Date.now() < limite) {
    if (ws.errores.length >= cuantos) return ws.errores.at(-1);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('se agotó el tiempo esperando un mensaje de error');
};

const nombres = (s) => s.players.map((p) => p.name);
const buscar = (s, nombre) => s.players.find((p) => p.name === nombre);
const objetivos = (s) =>
  s.players.map((p) => `${p.name}->${s.players.find((q) => q.id === p.targetId).name}`);
const resumenLog = (s) =>
  s.log.map((e) => `${e.playerName}->${e.targetName} ${e.guess} ${e.fijos}F${e.picas}P`);

// ------------------------------------------------- partida por turnos

async function partidaPorTurnos() {
  console.log('\nModo por turnos, 3 jugadores');
  const code = await crearSala('strict');
  const ana = await conectar(code, 'sm-a', 'Ana');
  const beto = await conectar(code, 'sm-b', 'Beto');
  const cami = await conectar(code, 'sm-c', 'Cami');

  await esperar(ana, (s) => s.players.length === 3, 'que entren los tres');
  igual('entran los tres en orden', nombres(estado(ana)), ['Ana', 'Beto', 'Cami']);

  decir(ana, { t: 'start' });
  await esperar(ana, (s) => s.phase === 'secret', 'el reparto de números');

  decir(ana, { t: 'setSecret', secret: '1234' });
  decir(beto, { t: 'setSecret', secret: '5678' });
  decir(cami, { t: 'setSecret', secret: '9123' });
  const enJuego = await esperar(ana, (s) => s.phase === 'playing', 'que arranque la partida');

  igual('cada uno le adivina al siguiente', objetivos(enJuego), [
    'Ana->Beto',
    'Beto->Cami',
    'Cami->Ana',
  ]);
  igual('arranca en la ronda 1', enJuego.round, 1);

  // Invariante: los secretos ajenos no salen del servidor.
  const ajenos = enJuego.players.filter((p) => p.name !== 'Ana').map((p) => p.secret);
  igual('Ana no ve el número de nadie más', ajenos, [null, null]);
  igual('Ana sí ve el suyo', enJuego.you.secret, '1234');

  decir(beto, { t: 'guess', guess: '9123' });
  chequear('no se puede jugar fuera de turno', (await esperarError(beto, 1)) === 'No es tu turno.');

  decir(ana, { t: 'guess', guess: '1123' });
  chequear(
    'rechaza un número con dígitos repetidos',
    (await esperarError(ana, 1)).includes('sin repetir'),
  );

  decir(ana, { t: 'guess', guess: '5671' });
  await esperar(ana, (s) => s.log.length === 1, 'el intento de Ana');
  decir(beto, { t: 'guess', guess: '9124' });
  await esperar(ana, (s) => s.log.length === 2, 'el intento de Beto');

  // Cami acierta, pero la ronda tiene que jugarse igual hasta el final.
  const antesDeCami = estado(ana);
  igual('la partida sigue con dos intentos jugados', antesDeCami.phase, 'playing');

  decir(cami, { t: 'guess', guess: '1234' });
  const finRonda = await esperar(ana, (s) => s.phase === 'intermission', 'el cierre de la ronda');

  igual('los fijos y picas dan bien', resumenLog(finRonda), [
    'Ana->Beto 5671 3F0P',
    'Beto->Cami 9124 3F0P',
    'Cami->Ana 1234 4F0P',
  ]);
  igual('Cami ganó en la ronda 1', buscar(finRonda, 'Cami').wonRound, 1);
  igual('el número de Ana quedó revelado', buscar(finRonda, 'Ana').secret, '1234');
  igual('el de Cami sigue tapado', buscar(finRonda, 'Cami').secret, null);

  decir(beto, { t: 'decide', continue: false });
  decir(ana, { t: 'decide', continue: true });
  const descuento = await esperar(ana, (s) => s.phase === 'playing', 'el tiempo de descuento');
  igual('sigue solo Ana, en la ronda 2', [descuento.round, descuento.overtime], [2, true]);

  decir(ana, { t: 'guess', guess: '5678' });
  const final = await esperar(ana, (s) => s.phase === 'finished', 'el final de la partida');
  igual(
    'al terminar se revelan todos los números',
    final.players.map((p) => p.secret),
    ['1234', '5678', '9123'],
  );
  igual(
    'los estados finales son los correctos',
    final.players.map((p) => `${p.name}:${p.status}`),
    ['Ana:won', 'Beto:quit', 'Cami:won'],
  );

  [ana, beto, cami].forEach((w) => w.close());
}

// ---------------------------------------------- partida simultánea

async function partidaSimultanea() {
  console.log('\nModo simultáneo, 2 jugadores');
  const code = await crearSala('sim');
  const ana = await conectar(code, 'sm-d', 'Ana');
  const beto = await conectar(code, 'sm-e', 'Beto');
  await esperar(ana, (s) => s.players.length === 2, 'que entren los dos');

  decir(ana, { t: 'start' });
  await esperar(ana, (s) => s.phase === 'secret', 'el reparto de números');
  decir(ana, { t: 'setSecret', secret: '1234' });
  decir(beto, { t: 'setSecret', secret: '5678' });
  await esperar(ana, (s) => s.phase === 'playing', 'que arranque la partida');

  decir(ana, { t: 'guess', guess: '5671' });
  await esperar(ana, (s) => s.you.pending === '5671', 'que se registre el intento de Ana');

  // Invariante: el intento pendiente no se publica hasta que juegan todos.
  const vistaBeto = estado(beto);
  igual('el intento de Ana no aparece en el historial', vistaBeto.log.length, 0);
  chequear(
    'el intento de Ana no se filtra por ningún lado',
    !JSON.stringify(vistaBeto).includes('5671'),
  );
  igual('Beto sí sabe que Ana ya jugó', vistaBeto.waitingOn.length, 1);

  decir(beto, { t: 'guess', guess: '1235' });
  const resuelta = await esperar(beto, (s) => s.log.length === 2, 'la revelación simultánea');
  igual('se revelan los dos juntos, bien puntuados', resumenLog(resuelta), [
    'Ana->Beto 5671 3F0P',
    'Beto->Ana 1235 3F0P',
  ]);
  igual('pasa a la ronda 2', resuelta.round, 2);

  [ana, beto].forEach((w) => w.close());
}

// ------------------------------------------------------------------ main

console.log(`Probando contra ${BASE}`);
try {
  await partidaPorTurnos();
  await partidaSimultanea();
} catch (err) {
  fallos++;
  console.log(`\nError inesperado: ${err.message}`);
}

console.log(`\n${pruebas - fallos}/${pruebas} verificaciones pasaron`);
process.exit(fallos > 0 ? 1 : 0);
