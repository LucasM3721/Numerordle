# Cómo está armado

Este documento explica **cómo anda** el proyecto, pieza por pieza, para alguien
que lo agarra de cero. Está escrito pensando en un lector que viene del backend:
las partes de Cloudflare se cuentan con analogías de servidor, y las del cliente
se cuentan más despacio, porque son las que no se ven todos los días desde ese
lado. No repite el porqué de las reglas del juego (eso está en
[DECISIONES.md](DECISIONES.md)) ni cómo se trabaja en el repo (eso está en
[AGENTS.md](../AGENTS.md)).

Índice:

1. [La foto de arriba](#1-la-foto-de-arriba)
2. [Las piezas de Cloudflare, para alguien de backend](#2-las-piezas-de-cloudflare-para-alguien-de-backend)
3. [El ciclo de vida de un pedido](#3-el-ciclo-de-vida-de-un-pedido)
4. [El protocolo por websocket](#4-el-protocolo-por-websocket)
5. [La máquina de estados de la sala](#5-la-máquina-de-estados-de-la-sala)
6. [El estado y sus dos fronteras](#6-el-estado-y-sus-dos-fronteras)
7. [La máquina que juega](#7-la-máquina-que-juega)
8. [El desafío del día](#8-el-desafío-del-día)
9. [Seguridad y costo](#9-seguridad-y-costo)
10. [El cliente, para alguien de backend](#10-el-cliente-para-alguien-de-backend)
11. [Datos y calibración](#11-datos-y-calibración)
12. [Pruebas y CI](#12-pruebas-y-ci)
13. [Glosario](#13-glosario)
14. [Si querés cambiar X, tocá Y](#14-si-querés-cambiar-x-tocá-y)

---

## 1. La foto de arriba

```
 navegador (public/)                    Cloudflare
 ┌──────────────────────┐              ┌────────────────────────────────────────────────┐
 │ index.html           │  GET /       │  Assets  ← sirve public/ tal cual; cualquier   │
 │ app.js  (módulo ES)  │◄────────────►│           ruta que no exista devuelve index.html│
 │ racha.js             │              │                                                │
 │ styles.css           │  /api/*      │  Worker (src/index.js)  ← sin estado           │
 │ localStorage         │◄────────────►│    │ POST /api/rooms        → crea una sala     │
 └──────────────────────┘              │    │ GET  /api/rooms/K7Q4Z/ws → websocket       │
        ▲        ▲                     │    │ GET/POST /api/reto     → el desafío        │
        │        │ wss (sala)          │    │ cron 12:00 y 22:00 UTC → revisa el cupo    │
        │        └─────────────────────┼────┼──► Durable Object GameRoom (src/room.js)   │
        │                              │    │      uno por sala, con su storage y sus    │
        │ fetch (desafío)              │    │      websockets                            │
        └──────────────────────────────┼────┴──► Durable Object RetoDelDia (src/reto.js) │
                                       │           uno por (fecha, jugador)              │
                                       │                                                │
                                       │  Analytics Engine  ← una fila por jugador de   │
                                       │                      cada partida terminada    │
                                       │  Rate Limiting     ← por IP, en el borde       │
                                       └────────────────────────────────────────────────┘
```

Tres ideas resumen todo:

- **El servidor es la única verdad.** El cliente no calcula nada del juego: manda
  intenciones (`guess`, `start`, `kick`) y recibe el estado entero cada vez que
  algo cambia. Los números secretos nunca viajan hasta que se revelan.
- **Una sala es un proceso con estado propio.** No hay base de datos compartida:
  cada sala vive en su Durable Object, con su memoria, su storage y sus sockets.
  Dos salas no se ven entre sí y no se pueden pisar.
- **El cliente es HTML y JS pelado.** Sin framework, sin build. Cuando llega un
  estado, `render()` vuelve a dibujar la pantalla desde cero a partir de él.

## 2. Las piezas de Cloudflare, para alguien de backend

Todo lo que sigue está declarado en `wrangler.jsonc`, que es el equivalente al
`docker-compose` o al `serverless.yml` del proyecto: dice qué recursos existen y
con qué nombre los ve el código (`env.ROOMS`, `env.ASSETS`, etc.).

### El Worker

Una función `fetch(request, env, ctx)` que corre en el borde de Cloudflare, en
el centro de datos más cercano al que pide. Pensalo como un **handler serverless
sin estado**: cada request puede caer en una instancia distinta, no hay memoria
compartida entre pedidos y no se puede confiar en nada que quede en una variable
global entre uno y otro. Si el Worker guardara las salas en un `Map`, cada
jugador vería una sala distinta según a qué instancia le tocó.

Por eso `src/index.js` casi no hace nada: valida, aplica límites de ritmo y
**delega en un Durable Object**. También tiene `scheduled()`, que es el handler
del cron.

`env` es el objeto con los bindings (los recursos de `wrangler.jsonc`) y las
variables y secretos. `ctx.waitUntil(promesa)` es "seguí corriendo esto después
de contestar", el equivalente a encolar un trabajo en segundo plano.

### El Durable Object

Es la pieza que hace posible el juego, y es la que menos se parece a lo que hay
en otros lados. Un Durable Object (DO) es **un objeto con identidad única en todo
el mundo, un solo hilo, memoria propia y un storage propio**. La analogía más
cercana es un **actor** (Erlang, Akka, Orleans): le mandás mensajes, los procesa
de a uno, y guarda su estado.

Lo que importa en la práctica:

- **Se lo encuentra por nombre.** `env.ROOMS.idFromName('K7Q4Z')` da siempre el
  mismo id para el mismo nombre, y `env.ROOMS.get(id)` devuelve un *stub*: un
  proxy al que le hacés `stub.fetch(request)` como si fuera un servidor HTTP. La
  primera vez que alguien pide un nombre, Cloudflare crea el objeto en algún
  centro de datos; de ahí en más todos los pedidos con ese nombre van al mismo
  objeto, esté donde esté. No hay que registrarlo ni crearlo: existe en cuanto
  se lo nombra.
- **Un solo hilo por objeto.** Dos mensajes al mismo objeto se procesan en
  serie. Es lo que hace que `room.js` pueda mutar `this.state` sin locks ni
  transacciones: mientras corre `handle()`, nadie más está tocando esa sala. Es
  también por lo que una sala es un objeto y no una fila en una tabla: la
  serialización viene gratis.
- **Storage propio, clave-valor.** `ctx.storage.put('state', obj)` y
  `ctx.storage.get('state')`. Acá se guarda **todo el estado de la sala en una
  sola clave**, y se reescribe entero en cada jugada (`save()`). Es un objeto de
  unos pocos KB, así que sale más barato que partirlo. El backend es SQLite
  (`new_sqlite_classes` en las migraciones), que es lo que habilita el plan
  gratis; el código no escribe SQL, usa la API clave-valor de arriba.
- **Se duerme y se despierta.** Cuando no pasa nada, el objeto se descarga de
  memoria. Al próximo pedido se vuelve a instanciar: corre el `constructor`,
  que carga el estado del storage. Por eso el constructor hace
  `ctx.blockConcurrencyWhile(async () => { this.state = await storage.get(...) })`:
  "no atiendas nada hasta que termine de cargar". Y por eso lo que está solo en
  memoria (`this.ritmo`, el contador de mensajes) se puede perder sin drama: si
  el objeto durmió, es porque nadie mandaba mensajes.
- **Alarmas.** `ctx.storage.setAlarm(timestamp)` programa una única llamada a
  `alarm()` en ese instante, aunque el objeto esté dormido. Es el `cron` propio
  de cada sala. Solo hay **una** alarma por objeto, así que `nextAlarmAt()`
  calcula la más cercana entre las tres cosas que la necesitan: barrer a un
  ausente (90 s), pasar el turno de alguien que no está, y vencer la sala por
  inactividad (24 h, o 10 min si nunca entró nadie).
- **Websockets con hibernación.** `ctx.acceptWebSocket(ws)` le entrega el socket
  al runtime, que lo mantiene abierto **aunque el objeto se descargue de
  memoria**. Cuando llega un mensaje, el runtime instancia el objeto de nuevo y
  llama a `webSocketMessage(ws, data)`. Como en ese momento la memoria está
  vacía, el socket lleva un *attachment* serializado (`serializeAttachment({ pid })`)
  que es la única forma de saber de quién es. `ctx.getWebSockets()` devuelve
  todos los abiertos, y `broadcast()` los recorre para mandarle a cada uno su
  vista.
- **Se paga por request.** Cada `stub.fetch`, cada mensaje de websocket y cada
  alarma es un request facturable del DO (en el plan gratis, descontado del
  cupo). Esto explica varios límites del código: el `ping` cada 50 s y no cada
  5, el tope de 5 sockets por jugador, el contador de mensajes por ventana, y el
  TTL corto de las salas vacías.
- **Una migración por clase.** `migrations` en `wrangler.jsonc` le dice a
  Cloudflare que existe la clase `GameRoom` (tag `v1`) y `RetoDelDia` (`v2`).
  Se agregan al final y no se editan: cada tag ya corrió en producción.

Hay dos clases de DO en el proyecto, y **no son un modo de la misma** a
propósito: en `GameRoom` el orden de los jugadores es el círculo, y el desafío no
tiene círculo. Meter el desafío en la sala dejaría el invariante principal
hablando de un caso que ya no cubre.

### Assets

El binding `ASSETS` sirve `public/` como archivos estáticos, desde la CDN, sin
pasar por el Worker. Dos opciones lo hacen andar:

- `not_found_handling: "single-page-application"`: cualquier ruta que no exista
  como archivo devuelve `index.html`. Así `/r/K7Q4Z` y `/reto` cargan la misma
  página, y el JS lee `location.pathname` para saber a dónde ir.
- `run_worker_first: ["/api/*"]`: solo `/api/*` llega al Worker. Sin esto el
  fallback de arriba se comería la API. Y es también lo que hace que lo estático
  no cuente para el cupo diario.

`public/_headers` es un archivo de configuración que Cloudflare interpreta (no
lo sirve): pone cabeceras a todo lo estático, sobre todo la CSP (sección 9).

### Rate Limiting

Los bindings `CREAR_SALA`, `ABRIR_SALA`, `RETO` y `AVISO` son contadores por
clave con ventana fija (10 o 60 s), que viven en el borde. `limitador.limit({ key: ip })`
devuelve `{ success }`. Se cuenta por `CF-Connecting-IP`, que la pone Cloudflare
y el cliente no puede falsear; sin esa cabecera (o sea, en `wrangler dev`) se deja
pasar. El conteo es **por centro de datos**, no global: alcanza para frenar un
accidente o un script suelto, no es una barrera absoluta.

`AVISO` no limita a nadie: se usa para no mandar más de un aviso por minuto a
Discord por cada tipo de aviso.

### Analytics Engine

Un dataset de escritura barata y consulta por SQL, pensado para métricas.
`env.PARTIDAS.writeDataPoint({ indexes, blobs, doubles })` escribe una fila con
**columnas por posición** (`blob1..blob20`, `double1..double20`), sin nombres. El
mapa de qué es cada columna está en "Qué es cada columna" en DECISIONES, y es el
único lugar donde está. Guarda 90 días; los logs del plan gratis duran 3.

### Cron, variables y secretos

`triggers.crons` dispara `scheduled()` dos veces por día. Las **variables**
(`--var` en los scripts de `package.json`, o `vars` en el jsonc) viajan en texto;
los **secretos** se cargan con `wrangler secret put` y no se pueden volver a
leer, ni desde el panel ni con `wrangler secret list`. Los dos llegan al código
por `env.NOMBRE`.

## 3. El ciclo de vida de un pedido

### Crear una sala

```
cliente                    Worker (index.js)                       GameRoom (room.js)
POST /api/rooms ─────────► ¿dentro del límite CREAR_SALA?
{mode, max, bot}           randomCode() → 'K7Q4Z'
                           stub = ROOMS.get(idFromName('K7Q4Z'))
                           stub.fetch('https://sala/create?...') ──► constructor (carga storage: nada)
                                                                     fetch(): action 'create'
                                                                     this.state = newState(...)
                                                                     si bot: nuevoBot + fase 'secret'
                                                                     save() → storage.put + setAlarm
                           ◄──────────────────────────────────────── 200 {ok, code}
◄──── 200 {code:'K7Q4Z'}
```

La URL `https://sala/create` es inventada: el `fetch` a un stub no sale a la red,
es una llamada a método disfrazada de HTTP. El host no importa; el path es la
"acción". Si el DO ya tenía estado (colisión de código, remotísima), contesta
409 y el Worker prueba otro código. El bucle de cinco vueltas también atrapa la
excepción de plataforma que a veces tira la creación del objeto (issue #46).

### Entrar a una sala

```
cliente                             Worker                              GameRoom
new WebSocket('/api/rooms/K7Q4Z/ws?pid=…&name=Ana')
GET con Upgrade: websocket ───────► valida el código (sin despertar el DO
                                    si es imposible), límite ABRIR_SALA
                                    roomFetch(..., request) ────────────► fetch(): action 'ws'
                                                                          ¿ya tiene 5 sockets este pid? → 429
                                                                          pair = new WebSocketPair()
                                                                          acceptWebSocket(server)
                                                                          server.serializeAttachment({pid})
                                                                          join(pid, name) → null o motivo
                                                                          si motivo: send kicked + close 4001
                                                                          si no: broadcast()
                                    ◄──────────────────────────────────── 101 con webSocket: client
◄──── socket abierto; primer mensaje: {t:'state', …}
```

`join()` decide si el pid ya estaba (reconexión: se lo marca conectado) o es
nuevo (¿hay lugar? ¿la partida no empezó?). El primer `state` que llega es la
confirmación; hasta entonces el cliente no cambia de pantalla.

### Un mensaje en partida

```
cliente                          GameRoom.webSocketMessage(ws, raw)
send({t:'guess', guess:'5678'}) ─► pid = ws.deserializeAttachment().pid
                                   contar(pid): >300 en 10 s → kicked + close 4004; >60 → se ignora
                                   msg = JSON.parse(raw); player = findPlayer(pid)
                                   changed = handle(player, msg)   ← el "command handler"; tira Error si es inválido
                                   si changed:
                                     destrabar(state)              ← pasa turnos de ausentes que ya vencieron
                                     turnoDeBots(state)            ← la máquina juega si le toca
                                     save()                        ← storage.put + setAlarm
                                     broadcast()                   ← a cada socket, viewFor(state, suPid)
                                   si Error: ws.send({t:'error', msg})   ← solo a ese socket
```

Este es **el bucle central del servidor**, y vale la pena tenerlo en la cabeza:
*validar → mutar → destrabar → bots → guardar → difundir*. Todo lo que cambia el
estado pasa por acá o por `alarm()`, que hace lo mismo sin un mensaje que lo
dispare.

### Una alarma

`alarm()` corre cuando venció `nextAlarmAt()`. Hace tres cosas en orden: si la
sala lleva más del TTL sin actividad, la demuele (`storage.deleteAll()` y avisa a
los sockets con `kicked` + 4003); si no, barre a los ausentes que se puedan barrer
y pasa turnos vencidos; y vuelve a programar la próxima alarma. Sin esto, una
partida por turnos con alguien que cerró el navegador quedaría trabada para
siempre, porque no hay ningún mensaje que la destrabe.

### El desafío del día

No usa websocket: es un jugador solo, no hay nada que empujarle. Cada acción es
un `fetch` y la respuesta es el estado entero del desafío (`vista()`), con lo que
el cliente vuelve a dibujar. El detalle está en la sección 8.

## 4. El protocolo por websocket

Todo es JSON con un campo `t` (tipo). Del cliente al servidor:

| `t` | Campos | Quién | Fase | Qué hace |
| --- | --- | --- | --- | --- |
| `ping` | — | cualquiera | cualquiera | mantiene viva la conexión; no cambia nada |
| `rename` | `name` | cualquiera | cualquiera | cambia el nombre (se desambigua: "Juan 2") |
| `setMode` | `mode: 'sim' \| 'strict'` | anfitrión | `lobby` | modo de juego |
| `setMax` | `max` | anfitrión | `lobby` | cupo, nunca por debajo de los que ya están |
| `shuffle` | — | anfitrión | `lobby` | sortea el círculo |
| `move` | `id` (pub), `dir: -1 \| 1` | anfitrión | `lobby` | mueve a alguien un lugar en el círculo |
| `makeHost` | `id` (pub) | anfitrión | cualquiera | cede la sala a otro conectado, no a la máquina |
| `addBot` | `nivel` | anfitrión | `lobby` | suma una máquina (hasta 3) |
| `kick` | `id` (pub) | anfitrión | cualquiera | antes de empezar saca; en partida retira (`quit`) |
| `leave` | — | cualquiera | cualquiera | lo mismo, sobre uno mismo |
| `start` | — | anfitrión | `lobby` | pasa al reparto de números |
| `setSecret` | `secret` | cualquiera | `secret` | fija el número; si están todos, arranca la ronda 1 |
| `unsetSecret` | — | cualquiera | `secret` | lo desarma para cambiarlo |
| `guess` | `guess` | cualquiera en juego | `playing` | el intento; rechaza repetidos sin gastar turno |
| `skip` | — | anfitrión | `playing` | saltea el turno (strict) o cierra la ronda sin los que faltan (sim) |
| `decide` | `continue: bool` | quien no ganó | `intermission` | seguir por el gusto de encontrarlo, o hasta acá |
| `endGame` | — | anfitrión | `secret`..`intermission` | termina y revela todo |
| `rematch` | — | anfitrión | `finished` | vuelve a la espera con el círculo sorteado |

Del servidor al cliente:

| `t` | Campos | Cuándo |
| --- | --- | --- |
| `state` | la vista entera (`viewFor`) | después de cada cambio, a todos; y al entrar |
| `error` | `msg` | el mensaje fue inválido; solo a quien lo mandó; el estado no cambió |
| `kicked` | `reason` | te sacaron, la sala venció o el join fue rechazado; viene seguido de un `close` |

Códigos de cierre que manda el servidor (todos 4xxx, y el cliente **no
reconecta** ante ninguno): 4001 join rechazado, 4002 te echaron, 4003 la sala
venció, 4004 demasiados mensajes. Antes de aceptar el socket puede contestar
HTTP 426 (no era un websocket) o 429 (ya hay 5 sockets de ese pid); en ese caso
el `close` llega antes del `open` y el cliente lo trata como caída normal.

La forma de `state` es la salida de `viewFor()` en `room.js`. Lo que conviene
saber: `players[]` viene en el orden del círculo y cada uno trae su `targetId`;
`you` es lo privado (tu secreto, tu intento pendiente, si sos anfitrión);
`turnId` solo tiene valor en modo por turnos; `waitingOn` solo en simultáneo;
`log` es el historial público con `playerId`/`targetId` como ids públicos.

## 5. La máquina de estados de la sala

```
             start (anfitrión, ≥2)          todos setSecret            alguien acertó en la ronda
  ┌───────┐ ─────────────────────► ┌────────┐ ──────────────► ┌─────────┐ ───────────────────────► ┌──────────────┐
  │ lobby │                        │ secret │                 │ playing │                          │ intermission │
  └───────┘ ◄──────────────────────└────────┘                 └─────────┘ ◄─── alguien sigue ────── └──────────────┘
      ▲       quedan <2 en el reparto    │                       │  ▲                                     │
      │                                  │ endGame               │  │ nadie acertó: ronda++               │ nadie sigue
      │ rematch                          ▼                       ▼  │                                     ▼
      │                            ┌──────────┐ ◄──── endGame ───┘   └─────────── nadie queda ───── ┌──────────┐
      └────────────────────────────│ finished │ ◄───────────────────────────────────────────────────│ finished │
                                   └──────────┘                                                     └──────────┘
```

Las fases están en `state.phase`. Lo que pasa adentro de `playing`:

- **Una ronda** es una pasada por `state.roundQueue`, que se arma en
  `startRound()` con los ids de los que siguen jugando (`status === 'playing'`).
- **Por turnos (`strict`)**: `state.turnPtr` apunta al que juega. Cada `guess`
  se resuelve en el acto (`resolveGuess` calcula fijos y picas contra el secreto
  del objetivo y lo agrega al `log`) y `advanceStrict()` mueve el puntero. Al
  llegar al final, `endRound()`.
- **Simultáneo (`sim`)**: cada `guess` va a `state.pending[pid]` sin resolverse
  (nadie lo ve; el dueño sí, por `you.pending`, y lo puede cambiar). Cuando todos
  los de la cola tienen pendiente, `resolveSimultaneous()` los resuelve en orden
  y llama a `endRound()`.
- **`endRound()`** mira si en el `log` de esta ronda hay algún 4 fijos. Si no,
  `round++` y otra ronda. Si sí: los que acertaron pasan a `won` (puede ser más
  de uno, por eso la ronda se juega entera), sus objetivos se revelan, y si
  queda alguien sin ganar la sala pasa a `intermission` para que cada uno decida
  si sigue. Si todos siguen o se van, `settleIntermission()` vuelve a `playing`
  con `overtime = true` o termina.
- **`finishGame()`** revela todos los secretos y registra la partida en el
  dataset, una sola vez.

Los ausentes no rompen nada de esto: `destrabar()` corre después de cada mensaje
y en la alarma, y si el que tiene que jugar lleva 90 s desconectado le pasa el
turno solo (`pushSkip`, que deja una entrada con `skipped: true` en el log). El
anfitrión tiene `skip` para no esperar.

## 6. El estado y sus dos fronteras

La forma de `state`, con lo que importa anotado:

```js
{
  code: 'K7Q4Z', createdAt, lastActivity,
  phase: 'lobby',            // lobby | secret | playing | intermission | finished
  mode: 'sim',               // sim | strict
  maxPlayers: 12, overtime: false, hostId: '<pid>',
  players: [                 // EL ORDEN ES EL CÍRCULO
    {
      id: '<pid>',           // credencial; no sale nunca del servidor
      pub: '9f3a…',          // id público; es lo que ven los demás
      name: 'Ana', secret: '1234' | null,
      connected: true, disconnectedAt: null,
      status: 'playing',     // playing | won | quit
      wonRound: null, decision: null,   // decision: null | true | false, en intermission
      bot: undefined | 'facil' | 'normal' | 'dificil',
      cuaderno: {…},         // solo la máquina: su memoria, serializada
    },
  ],
  round: 0, roundQueue: [], turnPtr: 0,
  pending: {},               // sim: pid → intento sin publicar
  log: [ { n, round, playerId: pub, playerName, targetId: pub, targetName, guess, fijos, picas, skipped? } ],
  logSeq: 0,                 // numera el log aunque se recorte (MAX_LOG = 600)
  revealed: [ pub, … ],      // de quiénes ya se ve el secreto
  game: 1,                   // sube con cada revancha; el cliente lo usa para las marcas
  prueba: false,             // fijado al crear; no cambia
}
```

**Frontera 1: `viewFor(state, pid)`.** Es el serializador, el DTO. Todo lo que
sale por el socket pasa por acá y por ningún otro lado. Hace dos cosas: filtra
(el secreto de otro solo si está en `revealed`; el `pending` solo el tuyo) y
**traduce ids**: adentro el estado habla en `pid`, afuera todo habla en `pub`.
Si agregás un campo al estado, la pregunta es "¿esto va en la vista? ¿de qué
espacio de ids es?".

**Frontera 2: `findByPub` en `handle()`.** Los mensajes que nombran a otro
(`move`, `kick`, `makeHost`) traen un `pub`, y lo primero que hace el handler es
resolverlo a un jugador. Nunca se acepta un `pid` ajeno desde afuera.

Por qué dos ids y no uno: al principio eran el mismo, y con eso cualquiera que
hubiera pasado por la sala podía reconectarse con el pid de otro y recibir su
secreto. Está contado en "Identidad: el pid no es el id" en DECISIONES.

**Persistencia.** Una sola clave, `state`, reescrita entera en `save()`. Las
salas guardadas por versiones viejas del código se migran al cargar
(`ensurePublicIds`, el `logSeq` faltante): es el equivalente a una migración de
esquema, hecha a mano y en el constructor, porque cada objeto es su propia base.

## 7. La máquina que juega

`src/bot.js` no resuelve el juego: **lo juega como alguien con un papel al
lado**. Anota lo que deduce (`anotarResultado`) y propone el próximo número
(`proponerIntento`), con una probabilidad de olvidarse cosas que es lo que
distingue los tres niveles. El porqué de que no sea un resolvedor perfecto está
en el comentario de cabecera del archivo y en "Los niveles, cuando haya datos".

Para la arquitectura, lo que importa es **cómo se engancha**:

- Es un jugador más en `state.players`, con `bot: 'normal'` y su `cuaderno`. No
  hay una clase aparte ni un proceso: todo lo que sabe está en el estado de la
  sala, serializado como listas planas (`guardarCuaderno`/`cargarCuaderno`),
  porque los `Set` no sobreviven al storage.
- Juega **de forma síncrona, adentro del mismo `handle`**. `turnoDeBots()` corre
  después de cada cambio de estado y hace jugadas mientras le toque a alguna
  máquina. No hay timers ni mensajes diferidos. Por eso la jugada de la máquina
  llega en el **mismo `state`** que la tuya.
- La "pausa de un segundo" es puro cliente (`aplicarEstado` en `app.js` retiene
  las entradas del log de la máquina y las suelta después). El resultado ya está
  decidido; se dosifica solo cómo se muestra.
- Se entera del resultado en `resolveGuess`, no al tirar: en simultáneo su
  intento queda pendiente como el de cualquiera.

## 8. El desafío del día

Un DO `RetoDelDia` por **(fecha, pid)**: `env.RETOS.idFromName('2026-09-13-<pid>')`.
Por eso "abrir el desafío" crea un objeto, y por eso el 500 de plataforma
(#46) pega justo ahí.

- **El número no se guarda: se deriva.** `numeroDelDia(fecha, RETO_CLAVE)` es
  HMAC-SHA256 de la fecha con la clave, seis bytes a entero, módulo 3024, y
  `permutacionSecreta(n)` lo convierte en un número válido. Esa función es una
  biyección entre `0..3023` y los 3024 números posibles (radix decreciente
  9·8·7·6), así un hash uniforme da números uniformes. Tiene que ser con clave:
  con `SHA-256(fecha)` a secas cualquiera lo calcula en su casa.
- **El día corre en UTC−3**, no en UTC: cambiar el número a las 21 hora
  argentina, en plena hora de jugar, se leería como un bug. `fechaDeHoy` está
  escrita en `src/reto.js` y copiada en `public/racha.js`.
- **HTTP y no websocket.** Es un jugador solo. `GET /api/reto?pid=` abre (y
  crea) el desafío; `POST` con `{guess}` es un intento y con `{seguir: bool}` la
  decisión de después del tope. La respuesta es siempre `vista()`: intentos,
  tope, si terminó, si ganó, y el número **solo cuando terminó**.
- **La fecha la pone el Worker**, no el cliente. Se acepta `?fecha=ayer` solo
  para **continuar** un desafío ya empezado (tres horas de gracia para el que
  quedó jugando cuando cambió el día); empezar el de ayer sería pedir un número
  que ya se sabe.
- **Reintentos.** El Worker reintenta el GET hasta tres veces porque abrir es
  idempotente. El POST no se reintenta a ciegas: si el primero llegó a aplicar el
  intento, el segundo lo aplicaría de nuevo. Es la misma pregunta que se hace
  cualquier cliente HTTP con reintentos, y acá tiene respuesta distinta para cada
  verbo.
- **Vence solo.** La alarma borra el objeto al cerrar su día (más 10 min de
  margen) o después de la gracia si quedó a medias.
- **El cuerpo del request se lee en el Worker y se reenvía materializado.** Si
  se pasara el `Request` original con su stream sin abrir y el DO contestara sin
  leerlo (el 409 de un desafío terminado), el runtime tira un error que **mata
  al Worker** y los pedidos siguientes se cuelgan. Es la clase de detalle que no
  se adivina y que está anotado justo arriba del código.

## 9. Seguridad y costo

Lo que protege, y contra qué:

| Mecanismo | Dónde | Contra qué |
| --- | --- | --- |
| `pid` nunca sale; `pub` hacia afuera | `viewFor`, `findByPub` | hacerse pasar por otro para recibir su secreto |
| `isValidPid`, `esNivel`, `isValidCode` | `game.js`, `bot.js` | claves heredadas (`toString`, `__proto__`) que rompen `pending`; despertar un DO con basura |
| Rate limiting por IP | `wrangler.jsonc`, `index.js` | crear salas o abrir sockets en masa (cada uno es un DO) |
| Contador de mensajes por pid | `GameRoom.contar` | una pestaña loca o un script que haga girar la factura |
| Tope de 5 sockets por pid | `fetch` action `ws` | lo mismo, por conexiones |
| TTL 10 min para salas vacías, 24 h para las usadas | `ttl()`, `alarm()` | miles de DOs ocupados por un `for` con fetch |
| `MAX_LOG = 600` | `resolveGuess` | que el estado crezca sin freno (hay límite de tamaño por valor) |
| `TOPE_DURO = 30` en el desafío | `reto.js` | lo mismo |
| HMAC con clave para el número del día | `numeroDelDia` | calcular el número de mañana |
| El desafío de ayer solo se continúa | `RetoDelDia.fetch` | pedir un número ya conocido |
| CSP en `_headers` | Cloudflare | scripts o estilos inyectados; el sitio solo carga lo suyo |
| `cleanName` | `game.js` | marcas bidi y caracteres de control que dan vuelta la interfaz |
| Marca de prueba con clave | `esPrueba` | que una fila marcada no sea nuestra (es certeza al leer, no seguridad) |
| No hay `/exists` | `index.js` | barrer códigos para encontrar salas |

La CSP dice: todo (`default-src`) del propio origen; scripts y estilos solo
propios (por eso un `<style>` inyectado desde la consola no anda); imágenes
propias o `data:` (el favicon es un SVG en `data:`); `connect-src` con los
orígenes del websocket **a mano**, porque no todos los navegadores cumplieron
siempre que `'self'` cubre `ws`/`wss`. Si el juego se muda a un dominio propio,
hay que agregarlo ahí.

Lo que **no** hay, a propósito: base de datos, cuentas de usuario, cookies,
ninguna consulta SQL en el camino de un pedido, y ningún dato personal en el
registro de partidas.

## 10. El cliente, para alguien de backend

Esta sección es la más larga porque es la que más explica cosas que del lado del
servidor no se ven. Si venís de escribir APIs, el cliente de este proyecto es
una buena forma de aprender el frontend "a mano": no hay ninguna capa que
esconda cómo funciona el navegador.

### 10.1 Qué es "sin framework y sin build"

`index.html` carga `styles.css` y `app.js`, y `app.js` importa `racha.js`. Eso es
todo. No hay `node_modules` del lado del cliente, ni Webpack, ni JSX, ni
TypeScript: lo que está en `public/` es exactamente lo que baja el navegador.
Se edita y se recarga.

`<script type="module" src="/app.js">` hace tres cosas: permite `import`
nativo entre archivos, corre el script **después** de que el HTML se parseó
(así `document.getElementById` encuentra todo sin esperar a `DOMContentLoaded`),
y aísla las variables (no ensucian `window`). Es lo que hoy reemplaza al
`(function(){ … })()` de antes.

Lo que se pierde sin framework: hay que escribir a mano el "cuándo vuelvo a
dibujar" y cuidarse de no pisar lo que la persona está escribiendo. Lo que se
gana: cero dependencias, cero build, y un archivo que se lee de arriba abajo.

### 10.2 La idea central: la pantalla es una función del estado

En React se dice `UI = f(state)`. Acá es lo mismo, escrito a mano:

```
llega {t:'state'} ──► aplicarEstado(msg) ──► state = msg ──► render()
                                                               │
                              ┌────────────────────────────────┤
                              ▼                                ▼
                    show('view-lobby', phase==='lobby')   renderLobby() / renderSecret() /
                    show('view-playing', …)               renderPlaying() / … (según la fase)
```

- **`state` es una copia de lo que mandó el servidor.** El cliente no tiene un
  modelo propio del juego. No calcula fijos y picas, no decide de quién es el
  turno, no sabe el secreto de nadie. Solo dibuja lo que recibe.
- **`render()` redibuja todo lo visible desde `state`**, cada vez. Cada
  `renderX()` hace `container.replaceChildren()` y vuelve a crear los nodos con
  el helper `el(tag, clase, texto)`. No hay diff ni virtual DOM: el DOM de una
  sala son unas decenas de nodos y reconstruirlos cuesta nada. Es el enfoque
  más simple que anda, y para este tamaño es el correcto.
- **Todas las pantallas están en el HTML desde el principio** (`screen-home`,
  `screen-room`, `screen-reto`, y adentro de la sala `view-lobby`,
  `view-secret`, `view-playing`, `view-intermission`, `view-finished`). Cambiar
  de pantalla es ponerle o sacarle la clase `hidden` (`display: none`). No se
  crea ni destruye HTML grande, solo se muestra el bloque que corresponde a la
  fase.
- **El flujo es de una sola dirección.** Un botón llama a `send({t:…})`; el
  servidor contesta con un `state`; `render()` dibuja. El cliente **no actualiza
  la pantalla por su cuenta** al apretar un botón (no hay "optimistic update"),
  con una excepción deliberada: la validación local del pad (4 dígitos sin
  repetir, número ya tirado), que evita un viaje al servidor y pone el aviso al
  lado del botón sin esperar.

### 10.3 Lo que se rompe si se redibuja todo, y cómo está resuelto

Redibujar desde cero tiene un costo que los frameworks esconden: **pisar lo que
la persona está haciendo**. El código tiene varios lugares que existen solo por
eso, y son buenos ejemplos de en qué piensa uno del lado del cliente:

- El pad de intentos **no se limpia cuando cambia la ronda**, sino cuando
  *vos* jugaste (`lastRound` compara cuántos intentos tuyos había). Si se
  limpiara por ronda, borraría el número que estabas escribiendo mientras
  esperabas tu turno.
- `fillRange` (el `<select>` de cupo) solo reconstruye las opciones si cambió el
  rango: rehacerlas en cada render cerraría la lista desplegada mientras alguien
  la está usando.
- El pad del secreto pide foco **solo al entrar** a esa pantalla
  (`lastPhase !== 'secret'`), porque cada `state` que llega (alguien entró, se
  desconectó) vuelve a llamar a `render()`, y robar el cursor cada vez es
  insoportable.
- El plegable de ayuda del anfitrión se abre **una vez por carga**
  (`ayudaDelAnfitrionDecidida`); si se decidiera en cada render, se le volvería
  a abrir al que acaba de cerrarlo.
- El pad no se pisa con `you.pending` si ya tiene algo escrito.

La regla general: **lo que es del servidor se redibuja siempre; lo que es de la
persona (texto a medio escribir, un desplegable abierto, el foco) se toca solo
cuando hay un motivo.**

### 10.4 Estado del cliente que no es del servidor

Hay unas pocas variables de módulo que son estado propio del cliente, y conviene
saber cuáles son porque son las únicas que no vienen del `state`:

| Variable | Qué es |
| --- | --- |
| `ws`, `roomCode`, `leaving`, `retries`, `reconnectTimer`, `pingTimer` | la conexión |
| `esperandoEntrar` | "todavía no confirmaron que entré": el id del cartel donde va a caer el rechazo |
| `lastRound`, `lastGame`, `lastPhase` | lo que hacía falta recordar entre renders para no pisar al usuario |
| `mostrados`, `retenidos`, `timerBot`, `puedoArriesgar` | la pausa de la máquina y si ya se puede mandar |
| `reto` | la última `vista()` del desafío |
| `bloqueo` | la cuenta regresiva de los botones apagados por saturación |

Y lo que persiste entre cargas, en `localStorage`:

| Clave | Qué guarda |
| --- | --- |
| `fp:pid` | tu identidad. Un UUID generado la primera vez. Es la credencial: por eso dos pestañas son el mismo jugador |
| `fp:name` | el último nombre que usaste |
| `fp:marks:<sala>:<partida>` y `fp:marks:reto:<fecha>` | tus anotaciones por dígito (0 nada, 1 no está, 2 pica, 3 fijo). Nunca viajan |
| `fp:racha` | el historial del desafío por fecha: `{n, gano, encontro}`. De acá sale la racha; nunca viaja |
| `fp:ayuda-anfitrion` | si ya viste el plegable de ayuda |
| `fp:pincel` | qué marca está elegida en la paleta para pintar dígitos |

`localStorage` es un clave-valor de strings por origen, síncrono, de unos 5 MB.
Todas las lecturas y escrituras van en `try/catch` porque puede no estar (modo
privado, cuota llena) y el juego tiene que seguir igual. La clave de prueba
(`?prueba=`) **no** se guarda a propósito: pegada, marcaría partidas de verdad
sin que nadie se entere.

### 10.5 La conexión: cómo se vive un websocket desde el navegador

`connect(code)` en `app.js` es un buen ejemplo completo. Lo que hace:

1. `cerrarSocket()`: cierra el socket anterior y, sobre todo, **le desengancha
   los handlers** (`onclose = null`). `close()` no termina en el acto y su
   `onclose` llega después, cerrado sobre la sala vieja; sin desarmarlo, ese
   evento tardío disparaba una reconexión a la sala que acababas de dejar.
2. `new WebSocket('wss://host/api/rooms/K7Q4Z/ws?pid=…&name=…')`. El pid va en
   la query porque el handshake de websocket no permite cabeceras propias.
3. `onopen`: resetea los reintentos y arranca un `ping` cada 50 s. Es un
   keepalive: sin tráfico, algunos proxies y redes móviles cierran el socket, y
   cada mensaje cuesta un request del DO, así que no es cada 5 s.
4. `onmessage`: `state` → `entrar()` (la primera vez cambia de pantalla) y
   `aplicarEstado()`; `error` → cartel; `kicked` → vuelve al inicio con el
   motivo.
5. `onclose`: si te fuiste vos, nada. Si el código es 4xxx, el servidor lo cerró
   a propósito: no se reintenta. Si no, **backoff exponencial**
   (1, 2, 4, 8, 15, 15… segundos) y `connect()` de nuevo.

**No se encola nada.** Si `send()` encuentra el socket cerrado, avisa y devuelve
`false`. Reenviar un intento viejo tras reconectar podría caer en otra ronda.

**Entrar con un código** usa `esperandoEntrar`: guarda el id del cartel donde
escribiste el código y no cambia de pantalla hasta el primer `state`. Si en vez
de eso llega `kicked` (sala llena, no existe), el motivo va a ese cartel y nunca
saliste del inicio. No hay un endpoint "¿existe esta sala?" porque servía para
barrer códigos.

### 10.6 Navegación: una sola página con tres rutas

El servidor devuelve `index.html` para cualquier ruta, así que las rutas son
convención del cliente: `/`, `/r/K7Q4Z` y `/reto`.

- Al entrar a una sala, `history.pushState({}, '', '/r/K7Q4Z')` cambia la URL
  **sin recargar**. Es lo que hace que el link se pueda copiar y que recargar te
  deje en la sala.
- `irSegunLaUrl()` lee `location.pathname` y lleva la pantalla a donde dice: si
  es `/reto`, abre el desafío; si es `/r/…`, conecta (o pide el nombre primero);
  si es `/`, cierra lo que estuviera abierto como lo haría el botón "Salir".
  Corre al cargar la página y en cada `popstate`, que es el evento que dispara
  el navegador con "atrás" y "adelante". Así "atrás" en el teléfono no te saca
  del sitio: te saca de la sala, y si la partida ya empezó pregunta primero y,
  si te arrepentís, devuelve la URL a la sala.

### 10.7 Los componentes, sin componentes

No hay clases de componente salvo una, `DigitPad`: cuatro `<input>` de un
carácter con manejo de foco (al escribir salta al siguiente, Backspace vuelve,
flechas, pegar reparte los dígitos). Es un buen ejemplo de qué hace falta para
que un control "se sienta bien" en el teléfono: `inputMode="numeric"` para que
salga el teclado de números, `maxLength=1`, `select()` al enfocar, y repartir el
texto si el teclado predictivo mete varios dígitos de golpe.

El resto son funciones que devuelven nodos: `playerEl(p, opts)` arma la fila de
un jugador con sus botones según quién mira (anfitrión o no) y en qué fase;
`tryEl` arma una fila de intento; `renderBoard`, `renderFeed`. Se componen
llamándose. Es lo que en un framework serían componentes, sin la maquinaria.

Los eventos se enganchan una sola vez, al final del archivo, con
`$('btn-x').onclick = …`. Como los botones fijos están en el HTML, no hace falta
volver a engancharlos en cada render; los que se crean por jugador (▲▼, 👑, ✕)
se enganchan al crearse dentro de `playerEl`.

### 10.8 HTML: lo que hace el navegador solo

Vale la pena mirar `index.html` con estos ojos:

- `<details>/<summary>` es un plegable nativo: abre y cierra sin JS, y `.open`
  se puede leer y escribir desde el script. Se usa para las reglas y la ayuda.
- `<label class="field"><span>…</span><input></label>`: al envolver el input en
  el label, tocar el texto enfoca el campo. En el teléfono importa.
- Los radios con el mismo `name` se excluyen solos; el CSS los estiliza con
  `.mode:has(input:checked)`.
- `role="status"` en los avisos hace que los lectores de pantalla los anuncien
  al cambiar. `aria-label` en los botones de un solo glifo (▲, ✕, 👑) dice qué
  hacen. Cada estado de marca tiene **forma además de color** (tachado,
  subrayado, círculo; ✓ ✕ +) para que el color no sea lo único que distingue.
- Las `<meta property="og:…">` son lo que leen WhatsApp y Discord para armar la
  tarjeta del link. Van con URL absoluta a producción porque esos robots no
  saben de dónde salió el HTML. La imagen es PNG porque WhatsApp no muestra
  SVG.
- `<link rel="preload" as="font" crossorigin>` pide la fuente del título junto
  con el CSS y no cuando el CSS la nombra, para que la portada no cambie de
  fuente un instante después de dibujarse.

### 10.9 CSS: cómo está organizado

- **Variables en `:root`** (`--bg`, `--accent`, `--fijo`, `--pica`, `--fuente-num`…):
  son los "tokens" de diseño. Cambiar un color es cambiarlo en un lugar.
- **Una clase por pieza** (`.card`, `.btn`, `.player`, `.try`, `.pad`, `.banner`)
  y modificadores como clases sueltas (`.btn.primary`, `.player.is-turn`,
  `.try.hit`). El JS solo agrega y saca clases; no escribe estilos.
- `.hidden { display: none !important }` es el único mecanismo de mostrar y
  ocultar, y `show(id, bool)` es su única puerta desde el JS.
- **Una sola columna de 620 px como máximo**, centrada. No hay breakpoints casi:
  el diseño es el del teléfono, y en escritorio queda angosto y centrado. Un
  juego que se pasa por link se juega en el teléfono.
- Las fuentes: una display (Anton) solo en el `h1`, la del sistema para el
  texto, y para los números una **condensada con dígitos del mismo ancho** que
  no se carga (se elige entre las que ya trae cada sistema) para que los
  intentos se alineen en vertical.
- Los comentarios del CSS explican por qué cada decisión (por qué los grises
  son neutros, por qué el borde es apenas visible, por qué un contraste). Vale
  leerlos como se lee el código.

### 10.10 El desafío desde el cliente

Es el camino más fácil de seguir porque no tiene socket: `abrirReto()` hace un
`GET`, guarda la respuesta en `reto`, muestra la pantalla y llama a
`renderReto()`. `arriesgarReto()` hace un `POST`, guarda la respuesta y vuelve a
llamar a `renderReto()`. Mismo patrón que la sala (respuesta entera → redibujar)
con `fetch` en vez de websocket. Al terminar, anota el día en `fp:racha` y arma
el texto para compartir (los cuadrados de colores, sin el número ni los
intentos), que va por `navigator.share` en el teléfono o al portapapeles.

### 10.11 Cómo probar el cliente sin levantar nada

`npm run estatico` sirve `public/` con las cabeceras reales y un `/api/rooms`
falso. Para el desafío, desde la consola del navegador se pisa `window.fetch`
con una función que devuelva lo mismo que `vista()`; para la sala, se pisa
`window.WebSocket` con un doble. Los dos trucos están en AGENTS.md, sección 4.
La suite no abre navegador: lo que del cliente es puro (`racha.js`) se importa
y se prueba en Node.

## 11. Datos y calibración

```
finishGame() / RetoDelDia.registrar()
   │
   ├── console.log({evento:'partida', …})   → wrangler tail / panel de logs (3 días)
   │
   └── PARTIDAS.writeDataPoint({            → Analytics Engine (90 días)
         indexes: [quien],                      │
         blobs:   [modo, quien, dia, marca],    │  SQL por la API
         doubles: [n, gano, ronda, jugadores,   ▼
                   rondas, descuento, encontro] scripts/consultar-datos.mjs
       })                                       │
                                                ├── separarPruebas()  ← filas-de-prueba.mjs: marca + reglas a mano
                                                └── censura: completas vs truncadas, salas vs desafíos
```

Una fila es **un jugador de una partida**, no una partida. `quien` es `humano` o
el nivel de la máquina, y es lo que hace posible comparar cuánto tarda la gente
contra cuánto tarda el bot. No hay nada que identifique a nadie.

La trampa al leer está en DECISIONES ("La trampa al leer los intentos") y es la
razón de que `npm run datos` exista en vez de un `SELECT AVG`: una fila de
alguien que **no** encontró el número no dice "tardó N", dice "necesitaba más
de N". Promediar las dos cosas juntas da un número más chico que la verdad. El
desafío del día, con la opción de seguir después del tope, es la fuente limpia:
el que sigue hasta encontrarlo deja el número entero.

## 12. Pruebas y CI

**No hay framework de tests.** `scripts/smoke.mjs` es un script de Node con dos
helpers (`chequear`, `igual`) y una lista de escenarios que corre en orden.
Primero los puros (forma del registro, filas que no cuentan, número del día,
racha, la máquina no repite), después los que necesitan servidor (desafío,
marca de prueba, partida por turnos, simultánea, cupo, identidad pública,
límites, tope de conexiones, contra la máquina, sin rivales, máquinas en la
sala, desconexión en partida, se cae el anfitrión).

Los de servidor abren varios websockets con identidades distintas y **esperan
condiciones** (`esperar(ws, s => s.phase === 'playing')`) en vez de dormir
tiempos fijos: las esperas fijas son la principal fuente de pruebas que fallan
sin motivo en CI.

`.github/workflows/deploy.yml` tiene dos jobs: **Verificar** (en cada PR y push:
`npm run check`, `wrangler deploy --dry-run`, levanta `wrangler dev` con las
claves de juguete y corre `npm test`) y **Desplegar** (solo en push a `main`,
solo si Verificar pasó, con `cloudflare/wrangler-action`). Los cambios que solo
tocan documentación no disparan el deploy.

Por qué GitHub Actions y no el deploy automático de Cloudflare: el "build" de
este proyecto no valida casi nada (`public/` se sube tal cual), así que lo que
protege es correr una partida de verdad antes de publicar, y eso conviene
tenerlo versionado en el repo. Está en DECISIONES.

## 13. Glosario

| Término | Qué es |
| --- | --- |
| **fijos / picas** | dígitos acertados en su posición / dígitos que están pero en otro lugar. Nunca se dice cuáles |
| **sala** | una partida multijugador; un Durable Object `GameRoom`; se identifica por un código de 5 caracteres |
| **espera** (`lobby`) | la sala antes de empezar: acá se arma el círculo, el modo, el cupo y las máquinas |
| **reparto** (`secret`) | cada uno elige su número |
| **círculo** | el orden de `players`: cada uno le adivina al siguiente, el último al primero |
| **objetivo** (`target`) | a quién le adivinás |
| **anfitrión** (`host`) | quien creó la sala, o quien heredó el rol; el único con controles |
| **ronda** | una pasada por todos los que siguen jugando |
| **simultáneo / por turnos** (`sim` / `strict`) | los dos modos |
| **descuento** (`overtime`) | seguir jugando después de que alguien ganó, por el gusto de encontrarlo |
| **retirado** (`quit`) | dejó de jugar pero su número sigue en el círculo |
| **revancha** (`rematch`) | volver a la espera con el círculo sorteado |
| **la máquina** (`bot`) | el rival automático; niveles `facil` / `normal` / `dificil`, que la interfaz llama distraída / atenta / metódica |
| **cuaderno** | la memoria de la máquina, o las marcas del jugador sobre sus intentos (son dos cosas distintas con el mismo nombre) |
| **desafío del día** (`reto`) | un jugador solo contra el número de hoy, tope de 12 |
| **racha** | días seguidos jugando el desafío; vive en el navegador |
| **marca de prueba** (`prueba`) | la señal de que una partida es nuestra y no cuenta para calibrar |
| **pid / pub** | credencial privada del jugador / id público que ven los demás |
| **destrabar** | pasar el turno de alguien que no está |
| **barrer** | sacar de la sala a quien cerró la página y no volvió |
| **demoler** | borrar una sala del todo |

## 14. Si querés cambiar X, tocá Y

| Querés | Tocás | Y además |
| --- | --- | --- |
| una regla del juego (cómo se gana, qué se acepta) | `src/room.js` (`handle`, `endRound`) o `src/game.js` | un caso en `smoke.mjs`; la sección de DECISIONES |
| un mensaje nuevo del cliente al servidor | `handle()` en `room.js`, `send()` desde `app.js` | la tabla del protocolo acá (sección 4) |
| un campo nuevo en lo que ve el cliente | `viewFor()` en `room.js`, `render*()` en `app.js` | preguntarte de qué espacio de ids es y si filtra un secreto |
| cómo juega la máquina | `src/bot.js` | `npm run bot` antes y después; los números en `NIVELES`, en `index.html` y en `consultar-datos.mjs` |
| el tope o las reglas del desafío | `src/reto.js` | la copia de `fechaDeHoy` en `racha.js` si cambia el día |
| una pantalla o un texto | `public/index.html`, `public/app.js` | el error va al bloque del botón, no al pie |
| colores, tipografía, espaciado | `public/styles.css` (variables en `:root`) | los números siempre con `--fuente-num` |
| un límite de ritmo | `wrangler.jsonc` | `dentroDelLimite` en `index.js` si es uno nuevo |
| un recurso de Cloudflare nuevo | `wrangler.jsonc` | migraciones al final; `env.X` en el código |
| qué se registra de una partida | `filasDePartida()`, `registrarPartida()`, `registrar()` en `reto.js` | al final del esquema; "Qué es cada columna" en DECISIONES; `consultar-datos.mjs` |
| la CSP o una cabecera | `public/_headers` | `npm run estatico` y la consola del navegador: las pruebas no lo ven |
| qué corre en CI | `.github/workflows/deploy.yml` | — |
