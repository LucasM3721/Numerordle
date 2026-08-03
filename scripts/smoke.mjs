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

async function crearSala(mode, max, bot) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, max, bot }),
  });
  if (!res.ok) throw new Error(`no se pudo crear la sala: HTTP ${res.status}`);
  return (await res.json()).code;
}

function conectar(code, pid, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws?pid=${pid}&name=${name}`);
    ws.estados = [];
    ws.errores = [];
    ws.rechazo = null;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') ws.estados.push(m);
      else if (m.t === 'error') ws.errores.push(m.msg);
      else if (m.t === 'kicked') ws.rechazo = m.reason;
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

const esperarRechazo = async (ws) => {
  const limite = Date.now() + TIMEOUT_MS;
  while (Date.now() < limite) {
    if (ws.rechazo) return ws.rechazo;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('se agotó el tiempo esperando que la sala rechazara al jugador');
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
  const ana = await conectar(code, 'smoke-ana', 'Ana');
  const beto = await conectar(code, 'smoke-beto', 'Beto');
  const cami = await conectar(code, 'smoke-cami', 'Cami');

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
  const ana = await conectar(code, 'smoke-dana', 'Ana');
  const beto = await conectar(code, 'smoke-elsa', 'Beto');
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

// ------------------------------------------------------- cupo de la sala

async function cupoDeLaSala() {
  console.log('\nCupo de la sala');

  // Pedir un cupo absurdo no abre una sala absurda: el tope es del servidor.
  const grande = await crearSala('sim', 99);
  const ana = await conectar(grande, 'cupo-ana', 'Ana');
  const vista = await esperar(ana, (s) => s.players.length === 1, 'que entre Ana');
  igual('el pedido se recorta al tope duro', vista.maxPlayers, 12);
  igual('el cliente sabe hasta dónde se puede subir', vista.maxPlayersCap, 12);

  // Sala armada para dos: el tercero rebota en la puerta.
  const chica = await crearSala('sim', 2);
  const beto = await conectar(chica, 'cupo-beto', 'Beto');
  const cami = await conectar(chica, 'cupo-cami', 'Cami');
  await esperar(beto, (s) => s.players.length === 2, 'que entren los dos');
  igual('la sala respeta el cupo que se pidió', estado(beto).maxPlayers, 2);

  const dani = await conectar(chica, 'cupo-dani', 'Dani');
  const rebote = await esperarRechazo(dani);
  chequear('el tercero no entra en una sala de dos', rebote.includes('llena'), rebote);
  igual('y adentro siguen siendo dos', estado(beto).players.length, 2);

  // El anfitrión lo cambia en la espera, pero nunca por debajo de los que ya
  // están adentro: entraron de buena fe y no se los puede dejar afuera.
  decir(beto, { t: 'setMax', max: 8 });
  await esperar(beto, (s) => s.maxPlayers === 8, 'que suba el cupo');
  decir(beto, { t: 'setMax', max: 1 });
  await esperar(beto, (s) => s.maxPlayers === 2, 'que el cupo baje hasta el piso');
  igual('no baja de los que ya entraron', estado(beto).maxPlayers, 2);

  decir(cami, { t: 'setMax', max: 12 });
  chequear(
    'solo el anfitrión toca el cupo',
    (await esperarError(cami, 1)).includes('anfitrión'),
  );

  [ana, beto, cami, dani].forEach((w) => w.close());
}

// --------------------------------------------------- identidad de jugador

/**
 * El agujero que esto cubre: si el id que ven los demás fuera el mismo con el
 * que uno se autentica, cualquiera que estuvo en la sala podría reconectarse
 * como otro y el servidor le mandaría el número secreto de esa persona.
 */
async function identidadPublica() {
  console.log('\nIdentidad: el pid no sale del servidor');
  const code = await crearSala('sim');
  const ana = await conectar(code, 'ident-ana', 'Ana');
  const beto = await conectar(code, 'ident-beto', 'Beto');
  await esperar(ana, (s) => s.players.length === 2, 'que entren los dos');

  decir(ana, { t: 'start' });
  await esperar(ana, (s) => s.phase === 'secret', 'el reparto de números');
  decir(ana, { t: 'setSecret', secret: '1234' });
  decir(beto, { t: 'setSecret', secret: '5678' });
  const jugando = await esperar(ana, (s) => s.phase === 'playing', 'que arranque la partida');

  const crudo = JSON.stringify(jugando);
  chequear('el pid de Beto no viaja al cliente', !crudo.includes('ident-beto'));
  chequear('el pid propio tampoco viaja', !crudo.includes('ident-ana'));

  // Con el id público de Beto no se puede ser Beto: para el servidor es
  // alguien nuevo, y la partida ya empezó.
  const pubBeto = buscar(jugando, 'Beto').id;
  const impostor = await conectar(code, pubBeto, 'Impostor');
  const rebote = await esperarRechazo(impostor);
  chequear('el id público no sirve para entrar como otro', rebote.includes('ya empezó'), rebote);
  igual('el impostor no recibió ni un estado', impostor.estados.length, 0);
  igual('y la sala sigue siendo de dos', estado(ana).players.length, 2);

  // Un pid que no parece un identificador ni siquiera se considera. `toString`
  // es el caso peligroso: pasa cualquier patrón razonable, pero como clave de
  // un objeto plano ya viene con valor, así que ese jugador contaría como que
  // ya jugó sin haber mandado nada.
  const rechazados = [];
  for (const pid of ['__proto__', 'toString', 'hasOwnProperty', 'corto']) {
    const raro = await conectar(code, pid, 'Raro');
    rechazados.push(await esperarRechazo(raro));
    raro.close();
  }
  chequear(
    'los pid que son claves de Object.prototype se rechazan',
    rechazados.every((r) => r.includes('Identificador')),
    JSON.stringify(rechazados),
  );

  [ana, beto, impostor].forEach((w) => w.close());
}

// ------------------------------------------------------------ endurecido

async function limitesYRuido() {
  console.log('\nLímites del servidor');
  const code = await crearSala('sim');
  const ana = await conectar(code, 'ritmo-ana', 'Ana');
  await esperar(ana, (s) => s.players.length === 1, 'que entre Ana');

  // El endpoint que decía si una sala existía servía para barrer códigos.
  const res = await fetch(`${BASE}/api/rooms/${code}/exists`);
  chequear('ya no se puede preguntar si una sala existe', res.status === 404, `HTTP ${res.status}`);

  // Una marca de dirección adentro del nombre da vuelta la línea entera.
  decir(ana, { t: 'rename', name: 'Be‮to' });
  await esperar(ana, (s) => s.players[0].name !== 'Ana', 'el cambio de nombre');
  igual('el nombre queda sin marcas de dirección', estado(ana).players[0].name, 'Beto');

  // Una ruta que matchea pero no se puede decodificar tiene que dar 400, no
  // reventar el Worker con un 500.
  const rota = await fetch(`${BASE}/api/rooms/%/ws`);
  igual('un código que no se puede decodificar da 400', rota.status, 400);

  // Y una avalancha corta la conexión en vez de seguir facturando requests.
  const cerro = new Promise((ok) => ana.addEventListener('close', (e) => ok(e.code)));
  for (let i = 0; i < 400; i++) decir(ana, { t: 'ping' });
  const codigo = await Promise.race([
    cerro,
    new Promise((_, no) => setTimeout(() => no(new Error('no cortó la conexión')), TIMEOUT_MS)),
  ]);
  igual('una avalancha de mensajes corta la conexión', codigo, 4004);
  // Sin este aviso el cliente ve un cierre pelado, reintenta, y como el socket
  // llegó a abrirse reconecta cada segundo para siempre.
  chequear('y avisa por qué, así el cliente no reintenta en bucle', !!ana.rechazo, String(ana.rechazo));
}

async function topeDeConexiones() {
  console.log('\nTope de conexiones por jugador');
  const code = await crearSala('sim');
  const abiertos = [];
  for (let i = 0; i < 5; i++) abiertos.push(await conectar(code, 'tope-ana', 'Ana'));
  await esperar(abiertos[0], (s) => s.players.length === 1, 'que entre Ana');
  igual('cinco pestañas del mismo jugador son un solo jugador', estado(abiertos[0]).players.length, 1);

  // La sexta se rechaza antes del upgrade, así que ni llega a abrirse.
  let sexta = 'abrió';
  try {
    await conectar(code, 'tope-ana', 'Ana');
  } catch {
    sexta = 'rechazada';
  }
  igual('la sexta conexión del mismo jugador se rechaza', sexta, 'rechazada');

  // Y no es un tope de la sala: otro jugador entra sin problema.
  const beto = await conectar(code, 'tope-beto', 'Beto');
  await esperar(beto, (s) => s.players.length === 2, 'que entre Beto');
  igual('otro jugador entra igual', estado(beto).players.length, 2);

  [...abiertos, beto].forEach((w) => w.close());
}

// ------------------------------------------------- contra la máquina

async function contraLaMaquina() {
  console.log('\nPartida contra la máquina');
  const code = await crearSala('strict', 2, 'dificil');
  const ana = await conectar(code, 'maquina-ana', 'Ana');

  const inicio = await esperar(ana, (s) => s.players.length === 2, 'que estén Ana y la máquina');
  const maquina = inicio.players.find((p) => p.bot);
  chequear('la máquina ya está en la sala al crearla', !!maquina, JSON.stringify(nombres(inicio)));
  igual('con su nivel a la vista', maquina?.bot, 'dificil');
  igual('la sala es de Ana, no de la máquina', inicio.you.isHost, true);

  // No se le puede dejar la sala: quedaría sin nadie que la maneje.
  decir(ana, { t: 'makeHost', id: maquina.id });
  chequear(
    'no se le puede ceder la sala a la máquina',
    (await esperarError(ana, 1)).includes('máquina'),
  );

  decir(ana, { t: 'start' });
  await esperar(ana, (s) => s.phase === 'secret', 'el reparto de números');
  decir(ana, { t: 'setSecret', secret: '1234' });

  const jugando = await esperar(ana, (s) => s.phase === 'playing', 'que arranque la partida');
  igual('la máquina eligió su número sola', jugando.players.every((p) => p.ready), true);
  igual('y el suyo sigue tapado', jugando.players.find((p) => p.bot).secret, null);

  // Va primera en el círculo, así que juega sin que nadie la empuje.
  igual('tiró su intento sin esperar a nadie', jugando.log.length, 1);
  igual('y ahora le toca a Ana', jugando.turnId, jugando.you.id);
  const suyo = jugando.log[0];
  chequear(
    'su intento es un número válido',
    /^[1-9]{4}$/.test(suyo.guess) && new Set(suyo.guess).size === 4,
    suyo.guess,
  );

  decir(ana, { t: 'guess', guess: '5678' });
  // Con dos jugadas por ronda, la ronda se cierra y la máquina abre la que
  // sigue. Puede acertar de entrada (pasa 1 de cada 3024), así que se verifica
  // que la partida avance, no en qué ronda quedó.
  const avance = await esperar(ana, (s) => s.log.length >= 2, 'que se juegue la ronda');
  const deLaMaquina = avance.log.filter((e) => e.playerId === maquina.id);
  chequear(
    'la máquina sigue jugando sola cada vez que le toca',
    deLaMaquina.length >= 1 && deLaMaquina.every((e) => /^[1-9]{4}$/.test(e.guess)),
    JSON.stringify(deLaMaquina.map((e) => e.guess)),
  );
  igual('y le adivina a Ana, que es la única que tiene al lado', deLaMaquina[0].targetId, avance.you.id);

  ana.close();
}

// ------------------------------------------------------------------ main

console.log(`Probando contra ${BASE}`);
try {
  await partidaPorTurnos();
  await partidaSimultanea();
  await cupoDeLaSala();
  await identidadPublica();
  await limitesYRuido();
  await topeDeConexiones();
  await contraLaMaquina();
} catch (err) {
  fallos++;
  console.log(`\nError inesperado: ${err.message}`);
}

console.log(`\n${pruebas - fallos}/${pruebas} verificaciones pasaron`);
process.exit(fallos > 0 ? 1 : 0);
