/**
 * Juega partidas enteras contra un servidor y verifica los invariantes del
 * juego. Es la red de seguridad antes de desplegar: el "build" de este
 * proyecto no mira public/, así que sin esto se puede publicar algo roto.
 *
 *   node --experimental-websocket scripts/smoke.mjs
 *   BASE=https://numerordle.lucasm3721.workers.dev node --experimental-websocket scripts/smoke.mjs
 */

import { readFileSync } from 'node:fs';

import { separarPruebas } from './filas-de-prueba.mjs';
import { filasDePartida } from '../src/room.js';
import { TOTAL_SECRETOS, isValidSecret, permutacionSecreta } from '../src/game.js';
import { TOPE_INTENTOS, fechaDeHoy, finDelDia, numeroDelDia } from '../src/reto.js';
// La racha es del cliente y no del servidor, pero su cuenta es pura y se prueba
// sin navegador. Por eso vive en un archivo aparte de `public/app.js`, que no se
// puede importar acá porque busca el DOM apenas se carga.
import {
  DIAS_A_LA_VISTA, TOPE_DIAS, anotarDia, diaAnterior,
  fechaDeHoy as fechaDeHoyDelCliente, resumen,
} from '../public/racha.js';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';

/**
 * El origen de producción, escrito acá porque los `og:` del HTML son absolutos
 * y tienen que serlo: los leen los robots de WhatsApp y Discord, que no tienen
 * de dónde sacar el origen. No es `BASE`: contra el servidor local igual se
 * verifica lo que va a salir publicado.
 */
const PRODUCCION = 'https://numerordle.lucasm3721.workers.dev';

/**
 * Corriendo contra producción, la suite juega partidas enteras y **cada una
 * queda registrada**: doce salas de Ana, Beto y Cami metidas en los datos con
 * los que se calibra al bot. Con `PRUEBA_CLAVE` puesta se marcan y quedan
 * afuera del análisis.
 *
 * Contra el servidor local da lo mismo: ahí no hay dataset.
 */
const PRUEBA = process.env.PRUEBA_CLAVE ?? '';
const marca = (qs) => (PRUEBA ? `${qs}${qs.includes('?') ? '&' : '?'}prueba=${encodeURIComponent(PRUEBA)}` : qs);
const WS_BASE = BASE.replace(/^http/, 'ws');
const TIMEOUT_MS = 10000;

/**
 * Contra producción y sin la clave, no arranca.
 *
 * Antes esto era una advertencia escrita en la guía, y una advertencia escrita
 * no alcanza: ya se ensuciaron los datos dos veces, la última con una
 * verificación post-deploy que había leído la advertencia. Lo que se olvida no
 * se arregla explicándolo mejor, se arregla haciendo que falle temprano.
 *
 * Corta antes de la primera sala, así no deja media docena de partidas sueltas
 * en el dataset y después el error.
 */
const ES_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
if (!ES_LOCAL && !PRUEBA) {
  console.error(`\nEsta suite juega doce partidas de verdad, y contra ${BASE} cada una queda`);
  console.error('registrada en los datos con los que se calibra al bot.\n');
  console.error('Poné la clave para que se marquen y queden afuera del análisis:');
  console.error('  PRUEBA_CLAVE=<la clave> BASE=… npm test\n');
  console.error('La clave es el secreto PRUEBA_CLAVE del Worker. Contra el servidor local');
  console.error('no hace falta: ahí no hay dataset.\n');
  process.exit(1);
}

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

/**
 * El límite de creación es de diez salas por minuto y por IP, y la suite pide
 * más que eso en unos segundos: la que caiga del otro lado de la ventana se
 * come un 429 y antes se llevaba puesta la corrida entera.
 *
 * Se espera y se vuelve a pedir en vez de bajarle el límite al servidor: es una
 * de las protecciones de costo, y una prueba no es motivo para debilitarla.
 * También es lo que hace que la suite se pueda correr contra producción.
 */
async function crearSala(mode, max, bot) {
  const limite = Date.now() + 90000;
  for (;;) {
    const res = await fetch(marca(`${BASE}/api/rooms`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, max, bot }),
    });
    if (res.ok) return (await res.json()).code;
    if (res.status !== 429 || Date.now() >= limite) {
      throw new Error(`no se pudo crear la sala: HTTP ${res.status}`);
    }
    console.log('  ...  esperando a que se libere el cupo de creación de salas');
    await new Promise((r) => setTimeout(r, 5000));
  }
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
const nombreDelTurno = (s) => s.players.find((p) => p.id === s.turnId)?.name ?? null;
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
  // El registro de la partida no puede llevarse nada de nadie por delante.
  chequear(
    'la vista final no filtra ids internos ni el código de la sala',
    !JSON.stringify(final).includes('smoke-ana'),
  );

  // --- La revancha, sobre esta misma sala ---------------------------------
  //
  // Va acá y no en una suite propia porque necesita una partida terminada, y
  // acá ya hay una. Crear otra sala cuesta una del cupo de diez por minuto.

  // Primero, lo que estaba roto: terminada, la sala rechaza al que quiere
  // entrar con un mensaje que le dice que espere a que terminen. Ya terminaron.
  const tarde = await conectar(code, 'smoke-dani', 'Dani');
  const motivo = await esperarRechazo(tarde);
  chequear('con la partida terminada no se puede entrar', motivo.includes('ya empezó'), motivo);
  tarde.close();

  // El cupo tampoco se puede tocar, así que no hay forma de hacerle lugar.
  decir(ana, { t: 'setMax', max: 5 });
  chequear(
    'y el cupo no se puede mover para hacerle lugar',
    (await esperarError(ana, 2)).includes('antes de empezar'),
  );

  decir(ana, { t: 'rematch' });
  const espera = await esperar(ana, (s) => s.phase === 'lobby', 'la vuelta a la sala de espera');

  igual('la revancha vuelve a la sala de espera, no al reparto', espera.phase, 'lobby');
  igual('siguen los tres', nombres(espera).length, 3);
  igual('nadie arranca con número', espera.players.map((p) => p.secret), [null, null, null]);
  igual('y todos vuelven a estar en juego', [...new Set(espera.players.map((p) => p.status))], ['playing']);
  igual('el historial arranca limpio', espera.log.length, 0);
  igual('y es otra partida, así las marcas del cuaderno no se arrastran', espera.game, final.game + 1);
  igual('Ana sigue siendo la anfitriona', espera.you.isHost, true);

  // Lo que la revancha vino a habilitar, que es todo lo que solo pasa acá.
  decir(ana, { t: 'setMax', max: 5 });
  const conCupo = await esperar(ana, (s) => s.maxPlayers === 5, 'el cupo nuevo');
  igual('ahora sí se puede mover el cupo', conCupo.maxPlayers, 5);

  const dani = await conectar(code, 'smoke-dani', 'Dani');
  const cuatro = await esperar(dani, (s) => s.players.length === 4, 'que entre alguien nuevo');
  chequear('y entra alguien que antes quedaba afuera', nombres(cuatro).includes('Dani'));

  // Y desde acá se arranca de nuevo, que es que la espera sea una espera de
  // verdad y no una pantalla de paso.
  decir(ana, { t: 'start' });
  const deNuevo = await esperar(ana, (s) => s.phase === 'secret', 'la partida nueva');
  igual('y se vuelve a empezar con los cuatro', deNuevo.players.length, 4);

  [ana, beto, cami, dani].forEach((w) => w.close());
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

  // La única fuente propia del proyecto. Se prueba porque es el tipo de cosa
  // que se rompe callada: el fallback de página única contesta el index con un
  // 200 alegre, así que un archivo que no se subió no se nota mirando el
  // código de estado. Lo que lo delata es el tipo de contenido.
  const fuente = await fetch(`${BASE}/fuentes/anton-latin.woff2`);
  igual('la fuente del título se sirve', fuente.status, 200);
  igual(
    'y como fuente, no como el index disfrazado',
    fuente.headers.get('content-type'),
    'font/woff2',
  );

  // Una marca de dirección adentro del nombre da vuelta la línea entera.
  decir(ana, { t: 'rename', name: 'Be‮to' });
  await esperar(ana, (s) => s.players[0].name !== 'Ana', 'el cambio de nombre');
  igual('el nombre queda sin marcas de dirección', estado(ana).players[0].name, 'Beto');

  // Una ruta que matchea pero no se puede decodificar tiene que dar 400, no
  // reventar el Worker con un 500.
  const rota = await fetch(`${BASE}/api/rooms/%/ws`);
  igual('un código que no se puede decodificar da 400', rota.status, 400);

  // Formas que el alfabeto no genera nunca: la I y la O no existen (se dictan
  // por teléfono) y todos los códigos miden 5. Se descartan antes del límite
  // por IP y antes de `idFromName`: despertar un Durable Object para no
  // encontrar nada se paga igual que encontrarlo.
  for (const imposible of ['ABCI9', 'ABC2', 'ABC23X', 'ABC01']) {
    const r = await fetch(`${BASE}/api/rooms/${imposible}/ws`);
    igual(`el código imposible ${imposible} da 400`, r.status, 400);
  }

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

  // Uno contra uno no tiene a quién esperar ni orden que acomodar: del botón se
  // sale derecho a elegir el número y la sala de espera no se ve nunca.
  igual('la sala nace en el reparto, sin sala de espera', inicio.phase, 'secret');
  igual('y la máquina ya tiene el suyo', maquina?.ready, true);
  igual('el suyo está tapado desde el minuto cero', maquina?.secret, null);

  // No se le puede dejar la sala: quedaría sin nadie que la maneje.
  decir(ana, { t: 'makeHost', id: maquina.id });
  chequear(
    'no se le puede ceder la sala a la máquina',
    (await esperarError(ana, 1)).includes('máquina'),
  );

  decir(ana, { t: 'start' });
  chequear(
    'y no hay ninguna partida que empezar, porque ya arrancó',
    (await esperarError(ana, 2)).includes('ya arrancó'),
  );

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

// ------------------------------------- quedarse sin rivales en el reparto

/**
 * Del reparto no se sale sin empezar la partida, así que sacar al único rival
 * dejaba a alguien solo mirando el pad para siempre. Se nota sobre todo en el
 * uno contra uno, donde la ✕ de la máquina está en la primera pantalla que ves.
 *
 * Es la única suite que pide una sala propia sin poder reusar otra: necesita
 * una de dos con la máquina adentro y en pleno reparto, que es justo el estado
 * que las demás atraviesan y dejan atrás.
 */
async function sinRivales() {
  console.log('\nSacar al único rival en pleno reparto');
  const code = await crearSala('strict', 2, 'normal');
  const ana = await conectar(code, 'sola-ana', 'Ana');

  const inicio = await esperar(ana, (s) => s.players.length === 2, 'que estén Ana y la máquina');
  igual('la sala arranca en el reparto', inicio.phase, 'secret');

  decir(ana, { t: 'kick', id: inicio.players.find((p) => p.bot).id });
  const sola = await esperar(ana, (s) => s.players.length === 1, 'que se vaya la máquina');
  igual('sin con quién jugar, la sala vuelve a la espera', sola.phase, 'lobby');
  igual('y Ana sigue siendo la anfitriona', sola.you.isHost, true);

  // Y desde la espera se rearma, que es de lo que se trata volver ahí.
  decir(ana, { t: 'addBot', nivel: 'facil' });
  const devuelta = await esperar(ana, (s) => s.players.length === 2, 'que vuelva una máquina');
  igual('y desde ahí se puede volver a armar', devuelta.players.filter((p) => p.bot).length, 1);

  ana.close();
}

// ------------------------------------------ máquinas en una sala normal

/**
 * La máquina dejó de ser exclusiva del uno a uno: el anfitrión puede sumarlas
 * a una sala cualquiera. Como es un jugador más del círculo, lo que se
 * verifica es justamente que no tenga nada especial —ocupa cupo, se saca con
 * el mismo kick— salvo los límites que sí tiene.
 */
async function maquinasEnLaSala() {
  console.log('\nMáquinas en una sala normal');
  // Todo en una sola sala: cada `crearSala` gasta del límite de diez por
  // minuto, y la suite entera ya lo roza.
  const code = await crearSala('strict', 6);
  const ana = await conectar(code, 'bots-ana', 'Ana');
  const beto = await conectar(code, 'bots-beto', 'Beto');
  await esperar(ana, (s) => s.players.length === 2, 'que entren Ana y Beto');

  decir(beto, { t: 'addBot', nivel: 'normal' });
  chequear(
    'sumar máquinas es del anfitrión, no de cualquiera que esté adentro',
    (await esperarError(beto, 1)).includes('anfitrión'),
  );

  decir(ana, { t: 'addBot', nivel: 'facil' });
  decir(ana, { t: 'addBot', nivel: 'dificil' });
  const dos = await esperar(ana, (s) => s.players.length === 4, 'que se sumen dos máquinas');
  igual(
    'se suman con el nivel que se pidió',
    dos.players.filter((p) => p.bot).map((p) => p.bot),
    ['facil', 'dificil'],
  );
  // Dos filas que dicen "La máquina" no se distinguen ni en el círculo ni en
  // el historial, que es donde después se lee quién le adivinó a quién.
  chequear(
    'y con nombres distintos entre sí',
    new Set(nombres(dos)).size === 4,
    JSON.stringify(nombres(dos)),
  );

  decir(ana, { t: 'addBot', nivel: 'poliglota' });
  chequear('un nivel que no existe se rechaza', (await esperarError(ana, 1)).includes('nivel'));

  decir(ana, { t: 'addBot', nivel: 'normal' });
  await esperar(ana, (s) => s.players.length === 5, 'la tercera máquina');
  decir(ana, { t: 'addBot', nivel: 'normal' });
  chequear('hay un tope de máquinas por sala', (await esperarError(ana, 2)).includes('máquinas'));

  const sobrante = estado(ana).players.filter((p) => p.bot).at(-1);
  decir(ana, { t: 'kick', id: sobrante.id });
  const menos = await esperar(ana, (s) => s.players.length === 4, 'que se vaya una máquina');
  igual('se sacan con el mismo kick que a una persona', menos.players.filter((p) => p.bot).length, 2);

  // Con el cupo bajado a los que ya están, la sala queda llena: el que frena no
  // es el tope de máquinas sino el lugar.
  decir(ana, { t: 'setMax', max: 4 });
  await esperar(ana, (s) => s.maxPlayers === 4, 'que baje el cupo');
  decir(ana, { t: 'addBot', nivel: 'normal' });
  chequear('con la sala llena no entra una más', (await esperarError(ana, 3)).includes('lugar'));

  decir(ana, { t: 'start' });
  await esperar(ana, (s) => s.phase === 'secret', 'el reparto de números');
  decir(ana, { t: 'addBot', nivel: 'normal' });
  chequear(
    'empezada la partida ya no se suman: le cambiaría el objetivo a alguien',
    (await esperarError(ana, 4)).includes('antes de empezar'),
  );

  // Y de acá en más juegan. El bucle de `turnoDeBots` está escrito para que una
  // jugada suya destrabe la siguiente, pero nunca había habido dos para
  // probarlo: el círculo es Ana, Beto y las dos máquinas atrás.
  const maquinas = new Set(menos.players.filter((p) => p.bot).map((p) => p.id));
  decir(ana, { t: 'setSecret', secret: '1234' });
  decir(beto, { t: 'setSecret', secret: '5678' });
  const jugando = await esperar(ana, (s) => s.phase === 'playing', 'que arranque la partida');
  igual('las dos eligen su número solas', jugando.players.every((p) => p.ready), true);
  igual('y los suyos siguen tapados', jugando.players.filter((p) => p.bot).map((p) => p.secret), [null, null]);

  decir(ana, { t: 'guess', guess: '9876' });
  await esperar(ana, (s) => s.log.length >= 1, 'la jugada de Ana');
  decir(beto, { t: 'guess', guess: '9876' });
  const vuelta = await esperar(ana, (s) => s.log.length >= 4, 'una vuelta entera del círculo');
  const suyas = vuelta.log.filter((e) => maquinas.has(e.playerId));
  chequear(
    'las dos juegan solas cuando les toca, una atrás de la otra',
    new Set(suyas.map((e) => e.playerId)).size === 2,
    JSON.stringify(suyas.map((e) => `${e.playerName} ${e.guess}`)),
  );
  chequear(
    'y las dos tiran números válidos',
    suyas.every((e) => /^[1-9]{4}$/.test(e.guess) && new Set(e.guess).size === 4),
    JSON.stringify(suyas.map((e) => e.guess)),
  );

  ana.close();
  beto.close();
}

// ------------------------------------------- desconexión en plena partida

/**
 * El caso que más molesta jugando: alguien cierra la pestaña en medio de una
 * ronda. Nadie se puede sacar del círculo sin cambiarle el objetivo a otro,
 * así que su turno se pasa solo pasado el margen.
 *
 * Necesita el servidor levantado con `--var DESTRABE_MS:<pocos ms>`; con los
 * 90 segundos de producción esta prueba tardaría más que todo el resto junto.
 */
async function desconexionEnPartida() {
  console.log('\nDesconexión en plena partida (modo por turnos)');
  const code = await crearSala('strict');
  const ana = await conectar(code, 'smoke-caida-ana', 'Ana');
  const beto = await conectar(code, 'smoke-caida-beto', 'Beto');
  const cami = await conectar(code, 'smoke-caida-cami', 'Cami');
  await esperar(ana, (s) => s.players.length === 3, 'que entren los tres');

  decir(ana, { t: 'start' });
  await esperar(ana, (s) => s.phase === 'secret', 'el reparto');
  decir(ana, { t: 'setSecret', secret: '1234' });
  decir(beto, { t: 'setSecret', secret: '5678' });
  decir(cami, { t: 'setSecret', secret: '9123' });
  await esperar(ana, (s) => s.phase === 'playing', 'que arranque');

  decir(ana, { t: 'guess', guess: '5671' });
  const enBeto = await esperar(ana, (s) => nombreDelTurno(s) === 'Beto', 'el turno de Beto');
  igual('le toca a Beto', nombreDelTurno(enBeto), 'Beto');

  // Beto cierra la pestaña justo cuando le toca.
  beto.close();
  await esperar(ana, (s) => !buscar(s, 'Beto').connected, 'que se note la caída');
  igual('la partida no lo saca del círculo', nombres(estado(ana)), ['Ana', 'Beto', 'Cami']);
  igual('sigue siendo el turno de Beto', nombreDelTurno(estado(ana)), 'Beto');

  // Nadie toca nada: la ronda tiene que destrabarse sola.
  const destrabada = await esperar(
    ana,
    (s) => nombreDelTurno(s) === 'Cami',
    'que se pase el turno del ausente sin que nadie apriete nada',
  );
  chequear(
    'el turno del ausente se pasa solo',
    destrabada.log.some((e) => e.playerName === 'Beto' && e.skipped),
  );
  igual('y la partida sigue con el que viene', nombreDelTurno(destrabada), 'Cami');
  igual('Beto sigue en la partida por si vuelve', buscar(destrabada, 'Beto').status, 'playing');

  ana.close();
  cami.close();
}

/** El anfitrión se cae en plena partida: el rol tiene que pasar solo. */
async function anfitrionSeCae() {
  console.log('\nSe cae el anfitrión');
  const code = await crearSala('sim');
  const ana = await conectar(code, 'smoke-host-ana', 'Ana');
  const beto = await conectar(code, 'smoke-host-beto', 'Beto');
  await esperar(ana, (s) => s.players.length === 2, 'que entren los dos');
  igual('Ana arranca de anfitriona', buscar(estado(ana), 'Ana').id, estado(ana).hostId);

  decir(ana, { t: 'start' });
  await esperar(ana, (s) => s.phase === 'secret', 'el reparto');
  decir(ana, { t: 'setSecret', secret: '1234' });
  decir(beto, { t: 'setSecret', secret: '5678' });
  await esperar(beto, (s) => s.phase === 'playing', 'que arranque');

  ana.close();
  const traspaso = await esperar(beto, (s) => s.you.isHost, 'que Beto herede la sala');
  igual('el anfitrionazgo pasa al que queda', buscar(traspaso, 'Beto').id, traspaso.hostId);
  chequear('y hereda los botones para destrabar', traspaso.you.isHost === true);

  // Y sin nadie que apriete nada, la ronda igual se cierra sola.
  decir(beto, { t: 'guess', guess: '1235' });
  const cerrada = await esperar(beto, (s) => s.round === 2, 'que la ronda cierre sin la ausente');
  chequear(
    'la ronda se cierra sin la que se fue',
    cerrada.log.some((e) => e.playerName === 'Ana' && e.skipped),
  );

  beto.close();
}

// --------------------------------------------- la forma del registro

/**
 * El registro de partidas es lo único que va a decidir si los tres niveles del
 * bot están bien puestos, y es lo que menos se ve: sale del servidor y se lee
 * meses después, cuando ya no hay forma de volver a jugar esas partidas. Por
 * eso se verifica su forma acá, contra un estado armado a mano y sin servidor.
 *
 * Lo que más importa es `quien`. Sin eso las filas quedan sin dueño —una
 * partida de dos no dice si fue contra alguien o contra la máquina— y no hay
 * comparación posible, que es justo el agujero por el que los datos que se
 * venían juntando no sirvieron para calibrar nada.
 */
function formaDelRegistro() {
  console.log('\n— la forma del registro de partidas');

  const estado = {
    mode: 'strict',
    round: 3,
    overtime: false,
    players: [
      { pub: 'p1', status: 'won', wonRound: 3 },
      { pub: 'p2', bot: 'dificil', status: 'playing', wonRound: null },
    ],
    log: [
      { playerId: 'p1', skipped: false },
      { playerId: 'p1', skipped: false },
      { playerId: 'p1', skipped: true },
      { playerId: 'p2', skipped: false },
    ],
  };

  const filas = filasDePartida(estado);
  igual('una fila por jugador', filas.length, 2);
  igual('la persona queda marcada como humano', filas[0].quien, 'humano');
  igual('la máquina queda marcada con su nivel', filas[1].quien, 'dificil');
  igual('los intentos salteados no cuentan', filas[0].n, 2);
  igual('cuenta los intentos de la máquina', filas[1].n, 1);
  igual('el que ganó queda marcado', filas[0].gano, true);
  igual('y en qué ronda ganó', filas[0].ronda, 3);
  igual('el que no ganó no tiene ronda', filas[1].ronda, null);

  // El invariante de privacidad de docs/DECISIONES.md, escrito como prueba:
  // si alguien suma un campo al estado, esto se queja antes de que salga.
  chequear(
    'no sale ningún campo que identifique a nadie',
    filas.every((f) => Object.keys(f).join() === 'quien,n,gano,ronda'),
    JSON.stringify(filas[0]),
  );
}

// ------------------------------------------ el número del día, sin servidor

/**
 * El reparto del número del día es lo que más silenciosamente se puede
 * equivocar: si `permutacionSecreta` repitiera números o dejara agujeros, el
 * desafío seguiría andando y nadie se enteraría — solo que algunos números
 * saldrían más seguido que otros. Por eso se recorren los 3024 enteros.
 */
async function numeroDelDiaAndaBien() {
  console.log('\n— el número del día');

  const vistos = new Set();
  let invalidos = 0;
  for (let i = 0; i < TOTAL_SECRETOS; i++) {
    const n = permutacionSecreta(i);
    if (!isValidSecret(n)) invalidos++;
    vistos.add(n);
  }
  igual('los 3024 índices dan 3024 números distintos', vistos.size, TOTAL_SECRETOS);
  igual('todos son números válidos', invalidos, 0);
  igual('el índice da la vuelta', permutacionSecreta(TOTAL_SECRETOS), permutacionSecreta(0));

  // La fecha corre en UTC−3: a las 02:00 UTC del día 6 acá todavía es el 5.
  igual('el día corre en UTC−3', fechaDeHoy(Date.parse('2026-08-06T02:00:00Z')), '2026-08-05');
  igual('y cambia a la medianoche de acá', fechaDeHoy(Date.parse('2026-08-06T03:00:00Z')), '2026-08-06');

  // El desafío se borra al terminar su día, no un día después: apenas cambia la
  // fecha ya no tiene puerta, porque el Worker enruta siempre a la de hoy. Que
  // las dos funciones estén de acuerdo es lo que hace que no se borre antes.
  const fin = finDelDia('2026-08-05');
  igual('el día termina a la medianoche de acá', fin, Date.parse('2026-08-06T03:00:00Z'));
  igual('un instante antes todavía es el mismo día', fechaDeHoy(fin - 1), '2026-08-05');
  igual('y en ese instante ya es el siguiente', fechaDeHoy(fin), '2026-08-06');
  igual('el fin de cada día es el arranque del otro', finDelDia('2026-08-06') - fin, 86400000);

  const a = await numeroDelDia('2026-08-05', 'una-clave');
  const b = await numeroDelDia('2026-08-05', 'una-clave');
  const c = await numeroDelDia('2026-08-06', 'una-clave');
  const d = await numeroDelDia('2026-08-05', 'otra-clave');
  igual('el mismo día con la misma clave da el mismo número', a, b);
  chequear('es un número válido', isValidSecret(a), a);
  chequear('otro día da otro número', a !== c, `${a} vs ${c}`);
  chequear('otra clave da otro número', a !== d, `${a} vs ${d}`);
}

// -------------------------------------------------------------- la racha

/**
 * La racha del desafío, sin navegador. Es aritmética de fechas, que es de lo
 * que más calladito se equivoca uno: un fin de mes mal contado corta la racha
 * de alguien el 1 y nadie se entera hasta que pasa.
 *
 * `public/racha.js` no toca el DOM ni `localStorage` justamente para poder
 * entrar acá; lo que guarda y lo que dibuja queda en `app.js` y no se prueba.
 */
function laRacha() {
  console.log('\n— la racha del desafío');

  igual('el día anterior cruza el fin de mes', diaAnterior('2026-08-01'), '2026-07-31');
  igual('y el fin de año', diaAnterior('2026-01-01'), '2025-12-31');
  igual('y cae en el 29 de un bisiesto', diaAnterior('2024-03-01'), '2024-02-29');

  // La regla del día está escrita de los dos lados —`src/reto.js` y
  // `public/racha.js`— porque el cliente no importa nada del servidor. Que se
  // corran no rompe el juego, pero desfasa la racha un día, y en silencio.
  const momentos = [
    '2026-08-06T02:00:00Z', '2026-08-06T03:00:00Z',
    '2026-01-01T02:59:00Z', '2024-02-29T23:00:00Z',
  ].map(Date.parse);
  const acuerdan = momentos.every((m) => fechaDeHoy(m) === fechaDeHoyDelCliente(m));
  chequear('el cliente corta el día donde lo corta el servidor', acuerdan,
    momentos.map((m) => `${fechaDeHoy(m)}/${fechaDeHoyDelCliente(m)}`).join(' '));

  const jugados = (...fechas) => Object.fromEntries(
    fechas.map((f) => [f, { n: 6, gano: true, encontro: true }]),
  );

  const seguidos = jugados('2026-08-05', '2026-08-06', '2026-08-07');
  igual('tres días seguidos son una racha de tres', resumen(seguidos, '2026-08-07').racha, 3);

  // Lo que más importa de toda la cuenta: al que entra a jugar el de hoy la
  // racha todavía no se le cortó, y decirle 0 sería mentirle justo ahí.
  igual('sin haber jugado hoy sigue viva', resumen(seguidos, '2026-08-08').racha, 3);
  chequear('y se sabe que hoy falta', !resumen(seguidos, '2026-08-08').jugoHoy);
  igual('se corta al pasar un día entero sin jugar', resumen(seguidos, '2026-08-09').racha, 0);
  igual('un hueco no se saltea', resumen(jugados('2026-08-01', '2026-08-06', '2026-08-07'), '2026-08-07').racha, 2);

  const conPasado = resumen(jugados('2026-07-01', '2026-07-02', '2026-07-03', '2026-08-07'), '2026-08-07');
  igual('la racha de ahora es de un día', conPasado.racha, 1);
  igual('y la mejor se acuerda de la de julio', conPasado.mejor, 3);

  const mixto = resumen({
    '2026-08-06': { n: 12, gano: false, encontro: false },
    '2026-08-07': { n: 6, gano: true, encontro: true },
  }, '2026-08-07');
  igual('cuenta los desafíos jugados', mixto.jugados, 2);
  igual('y los sacados dentro de los doce', mixto.ganados, 1);
  igual('la tira mide lo que se ve', mixto.dias.length, DIAS_A_LA_VISTA);
  igual('termina en hoy', mixto.dias.at(-1).fecha, '2026-08-07');
  chequear('con hoy marcado', mixto.dias.at(-1).esHoy);
  igual('y arranca nueve días antes', mixto.dias[0].fecha, '2026-07-29');
  igual('los días sin jugar quedan vacíos', mixto.dias.filter((d) => d.entrada).length, 2);

  const antes = jugados('2026-08-06');
  const despues = anotarDia(antes, '2026-08-07', { n: 5, gano: true, encontro: true });
  igual('anotar no toca el historial que recibe', Object.keys(antes).length, 1);
  igual('y devuelve uno con el día nuevo', despues['2026-08-07'].n, 5);

  // El historial no crece para siempre: es del navegador y no de una cuenta.
  const fechas = [];
  for (let f = '2026-08-07', i = 0; i < TOPE_DIAS + 5; i++, f = diaAnterior(f)) fechas.push(f);
  let largo = {};
  for (const fecha of fechas) largo = anotarDia(largo, fecha, { n: 6, gano: true, encontro: true });
  igual('el historial se corta en el tope', Object.keys(largo).length, TOPE_DIAS);
  chequear('y lo que se va es lo más viejo',
    Boolean(largo['2026-08-07']) && !largo[fechas.at(-1)], fechas.at(-1));
}

// ------------------------------------------------------ el desafío del día

/**
 * Un desafío entero por HTTP. Se puede probar sin abrir un websocket porque el
 * desafío no tiene nada que empujar, que es justo por lo que se eligió HTTP.
 *
 * No se sabe cuál es el número, así que se tiran candidatos hasta que el
 * servidor diga que terminó. Acertar de casualidad es una entre 3024 por
 * intento: el caso está contemplado en vez de ignorado, así la prueba no
 * falla un día al azar.
 */
async function desafioDelDia() {
  console.log('\n— el desafío del día');

  const pid = `reto${Math.random().toString(36).slice(2, 12)}`;
  const url = marca(`${BASE}/api/reto?pid=${pid}`);

  let estado = await (await fetch(url)).json();
  if (estado.error) {
    chequear('el desafío del día está disponible', false, estado.error);
    return;
  }
  igual('arranca sin intentos', estado.intentos.length, 0);
  igual('el tope es 12', estado.tope, TOPE_INTENTOS);
  igual('no arranca terminado', estado.terminado, false);
  chequear('el número no viaja antes de terminar', estado.numero === null, JSON.stringify(estado.numero));

  const postear = async (cuerpo) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    return { status: res.status, cuerpo: await res.json() };
  };
  const tirar = (guess) => postear({ guess });
  const decidir = (seguir) => postear({ seguir });

  // Antes de gastar el desafío: lo que no es un número válido se rechaza y no
  // cuenta como intento. Va acá y no al final porque una vez terminado el
  // desafío contesta 409 a todo, que es lo correcto pero tapa esta prueba.
  const malo = await tirar('1123');
  igual('un número con repetidos se rechaza', malo.status, 400);
  estado = await (await fetch(url)).json();
  igual('y no gasta un intento', estado.intentos.length, 0);

  const candidatos = [
    '1234', '5678', '1357', '2468', '1235', '1236',
    '1237', '1238', '1239', '1245', '1246', '1247',
  ];
  let filtrado = true;
  for (const guess of candidatos) {
    if (estado.terminado) break;
    const { cuerpo } = await tirar(guess);
    estado = cuerpo;
    if (!estado.terminado && estado.numero !== null) filtrado = false;
  }

  chequear('el número nunca se filtró mientras el desafío seguía', filtrado);

  // Sin acertar, los doce **no terminan** el desafío: preguntan. Es lo que
  // convierte un "necesitaba más de doce" en un número entero.
  if (!estado.gano) {
    igual('a los doce no termina, pregunta', estado.terminado, false);
    igual('y queda esperando la decisión', estado.decidiendo, true);
    chequear('todavía no se revela el número', estado.numero === null, JSON.stringify(estado.numero));

    const suelto = await tirar('9876');
    igual('no se puede tirar sin decidir', suelto.status, 409);

    // Ver el número: se termina y no lo encontró.
    const visto = await decidir(false);
    estado = visto.cuerpo;
    igual('al pedir verlo, termina', estado.terminado, true);
    igual('y queda como que no lo encontró', estado.encontro, false);
    igual('sin acertar, termina justo en el tope', estado.intentos.length, TOPE_INTENTOS);
  }

  chequear('al terminar sí se revela el número', isValidSecret(estado.numero ?? ''), String(estado.numero));

  // Terminado es terminado: no se sigue tirando.
  const extra = await tirar('9876');
  igual('un intento después de terminar se rechaza', extra.status, 409);

  // El mismo pid retoma el mismo desafío, que es lo que hace que recargar la
  // página no regale un desafío nuevo.
  const devuelta = await (await fetch(url)).json();
  igual('el mismo pid retoma el mismo desafío', devuelta.intentos.length, estado.intentos.length);

  const sinPid = await fetch(`${BASE}/api/reto?pid=x`);
  igual('un identificador inválido se rechaza', sinPid.status, 400);

  // Lo que sostiene que se pueda continuar el de ayer: continuar sí, empezar
  // no. Sin esto, pedir la fecha de ayer sería pedir un número que ya se sabe
  // y el tope de doce no protegería nada.
  const ayer = fechaDeHoy(Date.now() - 86400000);
  const nuevo = `reto${Math.random().toString(36).slice(2, 12)}`;
  const deAyer = await fetch(marca(`${BASE}/api/reto?pid=${nuevo}&fecha=${ayer}`));
  igual('no se puede empezar el desafío de ayer', deAyer.status, 410);
  const cuerpoAyer = await deAyer.json();
  chequear('y no viene ningún número', cuerpoAyer.numero == null, JSON.stringify(cuerpoAyer));

  // Cualquier otra fecha ni siquiera despierta a esa sala: cae en la de hoy.
  const otro = `reto${Math.random().toString(36).slice(2, 12)}`;
  const viejo = await (await fetch(marca(`${BASE}/api/reto?pid=${otro}&fecha=2020-01-01`))).json();
  igual('una fecha cualquiera cae en la de hoy', viejo.fecha, fechaDeHoy());
}

// ------------------------------------------ seguir después de los doce

/**
 * El camino que existe por los datos: el que agota los doce puede seguir hasta
 * encontrarlo. Pierde igual, pero su número deja de ser "más de doce" y pasa a
 * ser un número. Sin esto, los jugadores lentos —los que más corren la
 * distribución que hay que medir— son justo los que no se pueden medir.
 */
async function seguirDespuesDelTope() {
  console.log('\n— seguir después de los doce');

  const pid = `sigue${Math.random().toString(36).slice(2, 12)}`;
  const url = marca(`${BASE}/api/reto?pid=${pid}`);
  const postear = async (c) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c),
    });
    return { status: res.status, cuerpo: await res.json() };
  };

  let estado = await (await fetch(url)).json();
  if (estado.error) {
    chequear('el desafío del día está disponible', false, estado.error);
    return;
  }

  const candidatos = [
    '1234', '5678', '1357', '2468', '1235', '1236',
    '1237', '1238', '1239', '1245', '1246', '1247',
  ];
  for (const guess of candidatos) {
    if (estado.terminado || estado.decidiendo) break;
    estado = (await postear({ guess })).cuerpo;
  }
  if (estado.gano) {
    console.log('  ...  lo acertó de casualidad; el tope no se puede probar en esta corrida');
    return;
  }

  igual('a los doce queda esperando la decisión', estado.decidiendo, true);

  estado = (await postear({ seguir: true })).cuerpo;
  igual('al elegir seguir, el desafío no termina', estado.terminado, false);
  igual('y deja de preguntar', estado.decidiendo, false);
  igual('queda anotado que siguió', estado.siguio, true);
  chequear('y todavía no se revela el número', estado.numero === null, JSON.stringify(estado.numero));

  const trece = await postear({ guess: '9876' });
  igual('ahora sí entra el intento trece', trece.status, 200);
  igual('y se cuenta', trece.cuerpo.intentos.length, 13);

  const deNuevo = await postear({ seguir: true });
  igual('seguir se elige una sola vez', deNuevo.status, 409);

  // Revelar sí queda disponible: el que siguió puede cansarse, y no tiene por
  // qué llegar a los treinta para poder salir.
  const rendirse = await postear({ seguir: false });
  igual('pero revelar se puede en cualquier momento', rendirse.status, 200);
  igual('y ahí sí termina', rendirse.cuerpo.terminado, true);
  igual('sin haberlo encontrado', rendirse.cuerpo.encontro, false);
  chequear('con el número a la vista', isValidSecret(rendirse.cuerpo.numero ?? ''), String(rendirse.cuerpo.numero));
}

// ------------------------------------------------- la marca de prueba

/**
 * Probar contra producción ensucia el dato con el que se calibra: una partida
 * de prueba se lee después como alguien que jugó mal. La marca la separa.
 *
 * Lo que más importa verificar es que **falle cerrado**: sin clave, o con una
 * equivocada, la partida cuenta. Si se marcara de más, se estarían tirando
 * datos buenos sin que nadie se entere.
 */
async function laMarcaDePrueba() {
  console.log('\n— la marca de prueba');
  const pid = () => `marca${Math.random().toString(36).slice(2, 12)}`;

  const sin = await (await fetch(`${BASE}/api/reto?pid=${pid()}`)).json();
  if (sin.error) {
    chequear('el desafío del día está disponible', false, sin.error);
    return;
  }
  igual('sin clave, la partida cuenta', sin.prueba, false);

  const mala = await (await fetch(`${BASE}/api/reto?pid=${pid()}&prueba=no-es-la-clave`)).json();
  igual('con la clave equivocada tampoco se marca', mala.prueba, false);

  if (!PRUEBA) {
    console.log('  ...  sin PRUEBA_CLAVE en el entorno, el caso positivo no se puede probar');
    return;
  }
  const bien = await (await fetch(marca(`${BASE}/api/reto?pid=${pid()}`))).json();
  igual('con la clave, queda marcada', bien.prueba, true);
}

// ------------------------------------------ las filas que no cuentan

/**
 * Qué se saca del dataset antes de calibrar. Se prueba acá porque
 * `filas-de-prueba.mjs` es puro: no toca la red ni el entorno, así que no hace
 * falta el token de analytics.
 *
 * Vale la pena tenerlo escrito: esto decide qué números se van a mirar para
 * mover los niveles del bot, y si excluye de más o de menos **el resultado
 * igual se ve razonable**. Ya pasó una vez en silencio: la consulta ni siquiera
 * leía la columna de la marca, así que todo el mecanismo de `PRUEBA_CLAVE`
 * marcaba filas que después se contaban igual.
 */
function lasFilasQueNoCuentan() {
  console.log('\n— las filas que no cuentan');

  const real = { modo: 'reto', quien: 'humano', dia: '2026-08-09', intentos: 7, gano: 1, marca: '' };
  const marcada = { modo: 'sim', quien: 'humano', dia: '', intentos: 3, gano: 1, marca: 'prueba' };
  const treinta = { modo: 'reto', quien: 'humano', dia: '2026-08-06', intentos: 30, gano: 0, marca: '' };
  const postDeploy = { modo: 'strict', quien: 'humano', dia: '', intentos: 0, gano: 0, marca: '' };

  const r = separarPruebas([real, marcada, treinta, postDeploy, { ...postDeploy }]);

  igual('la partida de verdad queda', r.filas, [real]);
  igual('la marcada con PRUEBA_CLAVE se va sola', r.marcadas.length, 1);
  igual('y las de a mano también', r.cuantas, 4);

  // Cada exclusión se nombra, porque una silenciosa es indistinguible de no
  // tener esos datos.
  chequear('cada regla dice por qué', r.aMano.every((x) => x.porque.length > 20));

  // Sin esto, una fila marcada que además encaja con una regla se contaría dos
  // veces y el total diría más exclusiones que filas hay.
  const dobles = separarPruebas([{ ...treinta, marca: 'prueba' }]);
  igual('una fila marcada no se cuenta dos veces', dobles.cuantas, 1);

  // Y la regla del 6 no puede llevarse puesto un desafío normal de otro día.
  const otroDia = { modo: 'reto', quien: 'humano', dia: '2026-08-07', intentos: 30, gano: 0, marca: '' };
  igual('la regla está atada a su fecha', separarPruebas([otroDia]).filas, [otroDia]);

  // Un dataset sin nada raro no pierde ninguna fila.
  igual('sin filas de prueba no se saca nada', separarPruebas([real]).cuantas, 0);
}

// ------------------------------------------- la puerta del desafío

/**
 * El camino que recorre alguien que recibe un resultado compartido: la tarjeta
 * de preview, el link, y la ruta que entra derecho al desafío.
 *
 * Se prueba leyendo los archivos y no abriendo un navegador, que es lo mismo
 * que hace la racha. No verifica que se vea lindo —para eso está mirarlo— sino
 * que las cuatro puntas sigan atadas entre sí, porque cuando se desatan **no se
 * rompe nada**: el link sigue abriendo, la tarjeta sigue saliendo, y lo único
 * que pasa es que llega menos gente. Un fallo silencioso es justo el que
 * conviene tener escrito.
 */
function laPuertaDelDesafio() {
  console.log('\n— la puerta del desafío');

  const raiz = new URL('../', import.meta.url);
  const leer = (p) => readFileSync(new URL(p, raiz), 'utf8');

  const html = leer('public/index.html');
  const app = leer('public/app.js');

  const meta = (prop) =>
    html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1] ?? null;

  chequear('el HTML declara una tarjeta de preview', meta('og:title') !== null);
  igual('y la imagen apunta a og.png', meta('og:image'), `${PRODUCCION}/og.png`);
  igual('la tarjeta va ancha y no de estampilla',
    html.match(/<meta name="twitter:card" content="([^"]*)"/)?.[1], 'summary_large_image');

  // Las tres puntas del link: la que declara el HTML, la que sale de Compartir
  // y la que el cliente sabe abrir. Si una se corre, el que llega cae en la
  // portada y tiene que buscar el desafío entre cuatro tarjetas.
  igual('el og:url apunta al desafío', meta('og:url'), `${PRODUCCION}/reto`);
  chequear('lo que se comparte lleva al desafío', app.includes('${location.origin}/reto'));
  chequear('y el cliente sabe abrir esa ruta', app.includes('EN_RETO = /^\\/reto'));

  // El tamaño lo declaran los meta, así que una imagen de otra medida sale
  // recortada en WhatsApp sin que nadie se entere. En un PNG el ancho y el alto
  // están en los bytes 16 y 20, que es el principio del IHDR.
  const png = readFileSync(new URL('public/og.png', raiz));
  chequear('og.png es un PNG de verdad', png.subarray(1, 4).toString('latin1') === 'PNG');
  igual('y mide lo que dicen los meta',
    [png.readUInt32BE(16), png.readUInt32BE(20)],
    [Number(meta('og:image:width')), Number(meta('og:image:height'))]);
}

// ------------------------------------------------------------------ main

console.log(`Probando contra ${BASE}`);
try {
  formaDelRegistro();
  lasFilasQueNoCuentan();
  laPuertaDelDesafio();
  await numeroDelDiaAndaBien();
  laRacha();
  await desafioDelDia();
  await seguirDespuesDelTope();
  await laMarcaDePrueba();
  await partidaPorTurnos();
  await partidaSimultanea();
  await cupoDeLaSala();
  await identidadPublica();
  await limitesYRuido();
  await topeDeConexiones();
  await contraLaMaquina();
  await sinRivales();
  await maquinasEnLaSala();
  await desconexionEnPartida();
  await anfitrionSeCae();
} catch (err) {
  fallos++;
  console.log(`\nError inesperado: ${err.message}`);
}

console.log(`\n${pruebas - fallos}/${pruebas} verificaciones pasaron`);
process.exit(fallos > 0 ? 1 : 0);
