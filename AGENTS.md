# Fijos y Picas — guía del repo para cualquier agente

Este archivo es **la puerta de entrada** para quien vaya a seguir el proyecto:
una persona, Codex, Claude Code, Cursor, Gemini CLI o el que venga. No asume que
leíste ninguna conversación anterior. Lo que está acá es lo que sigue siendo
cierto; el historial de cambios es `git log`, no esta nota.

Hay tres documentos y cada uno tiene un trabajo:

| Documento | Para qué |
| --- | --- |
| **`AGENTS.md`** (este) | cómo se trabaja acá: comandos, verificación, reglas, operación, pendiente |
| [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md) | **cómo está armado** y por qué anda: Workers, Durable Objects, el protocolo, el cliente. Leelo entero antes de tocar código si venís de cero |
| [`docs/DECISIONES.md`](docs/DECISIONES.md) | el **porqué** de cada regla del juego y de cada decisión, incluidas las ideas que se evaluaron y no entraron |

`CLAUDE.md` solo importa este archivo, para que Claude Code lo lea solo. Si usás
otro agente, apuntalo a `AGENTS.md`; no hay nada que solo esté en `CLAUDE.md`.

---

## 1. Qué es esto y en qué estado está

Un juego de adivinar números de 4 dígitos (fijos y picas, el de lápiz y papel),
multijugador por link, más un desafío diario para jugar solo. Corre **entero en
Cloudflare Workers**: cada sala es un Durable Object con su estado y sus
websockets; cada desafío del día es otro Durable Object, por jugador y por día.
El cliente es HTML, CSS y JS a mano, sin framework ni build. No hay base de
datos.

Producción: **https://numerordle.lucasm3721.workers.dev**. Repo:
`github.com/LucasM3721/Numerordle`, rama `main`.

**Estado al 13 de septiembre de 2026.** El juego está terminado, en vivo y con
todo mergeado y desplegado. Ese día se verificó el repo de punta a punta:
`npm run check` pasa y `npm test` contra el local da **223 verificaciones en
verde** (el número se mueve un poco entre corridas: el desafío que juega la
suite tiene cuatro verificaciones que solo corren si no lo saca en doce). No hay
nada a medio hacer en el árbol de trabajo.

Ese mismo día se cerraron tres issues del cliente (#50, #51, #52) y se arregló
un bug que ninguna prueba veía: **la alarma de destrabe giraba sin parar** en
cualquier partida con un ausente, porque se programaba en un instante que ya
había pasado. Está contado en "La alarma que giraba sola" en DECISIONES, y dejó
una regla: **después de correr la suite, el log de `wrangler dev` tiene que
estar limpio**, no solo la suite en verde.

**No queda nada por programar del juego en sí.** Lo que falta es que juegue gente
para calibrar los niveles de la máquina, y un issue que no depende de nosotros
(sección 8).

## 2. Arrancar en cinco minutos

Requisitos: Node 20 o más nuevo (CI usa 24; en la máquina de Lucas hay 20), npm,
y `gh` si vas a tocar issues. `wrangler` viene como dependencia de desarrollo.

```bash
npm install
npm run dev        # http://localhost:8787, con claves de juguete
```

Para jugar de a varios en la misma máquina usá ventanas de incógnito distintas:
la identidad vive en `localStorage` y dos pestañas normales son el mismo jugador.

Comandos:

```bash
npm run dev        # servidor local con el margen real de 90 s para ausentes
npm run dev:test   # igual pero con el margen en 2,5 s: es el que necesita npm test
npm run check      # sintaxis de src/, public/ y scripts/ (node --check)
npm test           # juega partidas enteras contra el servidor local y verifica invariantes
npm run bot        # mide cuánto tarda la máquina en cada nivel, sin servidor
npm run estatico   # sirve public/ con las cabeceras reales, sin Worker (para mirar la interfaz)
npm run datos      # resumen del dataset de partidas (necesita dos variables, ver sección 6)
npm run deploy     # publica a producción a mano
npm run tail       # logs de producción en vivo
```

**`npm test` necesita `npm run dev:test` en otra terminal, no `npm run dev`.** La
diferencia es `DESTRABE_MS`, que baja a 2,5 s el margen con el que se pasa el
turno de un ausente; con los 90 s de verdad, dos casos tardarían más que toda la
suite y fallan por tiempo agotado. Para jugar a mano usá `npm run dev`.

Lo que anda **siempre**, sin Worker ni red: `npm run check`, `npm run bot`,
`npm run estatico` y las pruebas puras de la suite. `wrangler dev` en Windows va
y viene (sección 9); si no arranca, la verificación real es la del pull request.

## 3. Dónde está cada cosa

| Archivo | Qué hace |
| --- | --- |
| `src/index.js` | Worker de entrada: crea salas, enruta el websocket, sirve el desafío, avisa por Discord, revisa el cupo por cron |
| `src/room.js` | `GameRoom`, el Durable Object de una sala: máquina de estados, turnos, rondas, ausentes, alarmas |
| `src/game.js` | reglas puras: validar un número, contar fijos y picas, códigos, permutaciones. Sin estado ni red |
| `src/bot.js` | la máquina: su cuaderno y los tres niveles. Puro, se prueba sin servidor |
| `src/reto.js` | `RetoDelDia`, el Durable Object del desafío: el número derivado de la fecha con HMAC, tope de 12 |
| `public/index.html` | la única página: tres pantallas (`screen-home`, `screen-room`, `screen-reto`) y las tarjetas `og:` |
| `public/app.js` | el cliente entero, como módulo ES. Sin dependencias |
| `public/racha.js` | la cuenta de la racha del desafío. Puro: no toca el DOM ni `localStorage`, por eso la suite lo prueba sin navegador |
| `public/styles.css` | todo el CSS. Variables en `:root`, una clase por componente |
| `public/_headers` | cabeceras de lo estático, sobre todo la **CSP**. Un error acá rompe el sitio y las pruebas no lo ven |
| `public/fuentes/` | Anton (`.woff2`, de Google Fonts tal cual) y su licencia OFL |
| `public/og.png` | la tarjeta de preview del link, 1200×630. Se generó a mano una vez |
| `scripts/smoke.mjs` | la suite (`npm test`): juega partidas por websocket y prueba las funciones puras |
| `scripts/bot-medicion.mjs` | `npm run bot` |
| `scripts/consultar-datos.mjs` | `npm run datos`: lee Analytics Engine por SQL y aplica las reglas de censura |
| `scripts/filas-de-prueba.mjs` | qué filas del dataset no cuentan para calibrar. Puro, con fecha y motivo por regla |
| `scripts/servir-estatico.mjs` | `npm run estatico` |
| `wrangler.jsonc` | bindings, migraciones, cron, límites de ritmo, dataset. Cada bloque tiene su comentario |
| `.github/workflows/deploy.yml` | CI: verifica en cada PR y push; despliega solo en push a `main` |
| `docs/DECISIONES.md` | el porqué de todo |
| `.claude/launch.json` | dos configuraciones de servidor para el panel del navegador de Claude Code. Otros agentes lo ignoran |
| `.claude/settings.local.json` | permisos propios de la máquina de Lucas para Claude Code. Está en `.gitignore` |

Los únicos binarios del repo son la fuente y `og.png`, y los dos están marcados
como `binary` en `.gitattributes`.

## 4. Cómo se verifica

`scripts/smoke.mjs` (`npm test`) juega partidas enteras contra un servidor y
verifica los invariantes de la sección 5. Es la única red de seguridad real:
`wrangler deploy` empaqueta `src/` y sube `public/` tal cual, sin mirarlos, así
que sin la suite un error de sintaxis en `app.js` llegaría a producción. Se
validó rompiendo el cálculo de picas a propósito: la prueba falla y corta el
deploy.

**Si tocás la lógica del juego, agregale un caso a la suite.** Las funciones
puras (`game.js`, `bot.js`, `racha.js`, `filas-de-prueba.mjs`, `reto.js` en su
parte sin Durable Object) se importan directo; lo que pasa por la sala se prueba
abriendo varios websockets con identidades distintas.

**La suite crea doce salas** y el límite de producción es diez por minuto por IP,
así que contra producción tarda un minuto más: espera a que se libere la ventana.
Contra el local el límite no aplica (no hay cabecera `CF-Connecting-IP`). Si
agregás una suite, fijate si podés usar una sala que ya exista.

**Cada push a `main` despliega solo**, pero únicamente si pasan `check`, el build
en seco (`wrangler deploy --dry-run`) y `npm test` contra un `wrangler dev`
levantado en el runner. **Trabajá en ramas y abrí un pull request**: ahí corren
las verificaciones sin desplegar nada. Los cambios solo a `docs/`, `README.md`,
`CLAUDE.md` y `AGENTS.md` no disparan el deploy.

Cosas que ahorran tiempo al probar:

- **La suite en verde no alcanza: mirá el log del Worker.** Las alarmas de los
  Durable Objects corren en el fondo y ninguna verificación las mira. El bucle
  de la alarma de destrabe se descubrió leyendo `wrangler-dev.log` después de
  una corrida que había pasado entera (`SQLITE_TOOBIG` en `alarm()`). Después
  de `npm test`, `Select-String -Path wrangler-dev.log -Pattern 'ERROR|Uncaught'`
  no tiene que dar nada.
- **Un CI en verde sobre una carrera no prueba que no haya bug.** Si algo falla
  de a ratos, relanzalo antes de teorizar: dos corridas iguales dicen mucho más
  que una. Pasó con el desafío, que mataba al Worker al contestar 409 sin leer el
  cuerpo del pedido, y la primera corrida pasó igual.
- **Encadená con `&&`, no con `;`.** Dos veces se dio por bueno un `npm run check`
  que fallaba porque el `echo OK` iba después de un punto y coma. Y ojo con
  `grep` en una cadena `&&`: sale con estado 1 cuando no encuentra nada y corta
  lo que viene después; una vez se comió el `git commit` y la rama se empujó
  vacía.
- **Dejá aire entre jugadas** (~500 ms) en un script. Si disparás rondas más
  rápido de lo que se resuelven, los intentos nuevos pisan los pendientes y
  parece un bug que no hay.
- **Editar cualquier archivo reinicia el Worker en `dev`** y corta los websockets
  abiertos. El cliente reconecta solo; un script de prueba a medias no.
- Para probar el barrido de ausentes a mano, bajá `GRACE_MS` en `src/room.js`
  temporalmente en vez de esperar 90 segundos.
- **`npm run estatico`** sirve para mirar la interfaz sin Worker. De la sala en
  adelante no sirve (no hay websocket). **Para el desafío sí**: habla por HTTP,
  así que alcanza con pisar `window.fetch` desde la consola y contestarle lo
  mismo que `src/reto.js`. Con `?caso=ritmo` y `?caso=cupo` fuerza los estados
  de saturación.
- Para probar lógica del cliente que depende del websocket, se pisa
  `window.WebSocket` con un doble desde la consola (`app.js` resuelve el global
  recién al hacer `new`). Que su `close()` **no** dispare `onclose` —el evento lo
  soltás vos, tarde, que es de donde salen los bugs— y pisá también `fetch` para
  que cada sala nueva devuelva un código distinto.
- Para probar CSS desde la consola, un `<style>` inyectado no sirve: lo bloquea
  la CSP. `insertRule` sobre la hoja cargada sí anda.
- **Dos pestañas del navegador son el mismo jugador.** Incógnito para cada uno.
- Patrón manual para explorar algo puntual, con `npm run dev` corriendo:

```bash
node --experimental-websocket -e "const B='http://127.0.0.1:8787', WS='ws://127.0.0.1:8787'; (async()=>{ const {code}=await (await fetch(B+'/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'sim'})})).json(); const open=(pid,name)=>new Promise((ok,no)=>{const w=new WebSocket(WS+'/api/rooms/'+code+'/ws?pid='+pid+'&name='+name); w.states=[];w.errs=[]; w.addEventListener('message',e=>{const m=JSON.parse(e.data); m.t==='state'?w.states.push(m):w.errs.push(m);}); w.addEventListener('open',()=>ok(w)); w.addEventListener('error',no);}); const wait=ms=>new Promise(r=>setTimeout(r,ms)), say=(w,m)=>w.send(JSON.stringify(m)), last=w=>w.states.at(-1); const A=await open('a','Ana'), B2=await open('b','Beto'); await wait(400); say(A,{t:'start'}); await wait(300); say(A,{t:'setSecret',secret:'1234'}); say(B2,{t:'setSecret',secret:'5678'}); await wait(500); say(A,{t:'guess',guess:'5678'}); say(B2,{t:'guess',guess:'1289'}); await wait(600); console.log(JSON.stringify(last(A).log,null,1)); process.exit(0); })()"
```

Cambiando `B`/`WS` a `https://…` y `wss://…` corre lo mismo contra producción
(con la marca de prueba, sección 6).

## 5. Invariantes que no hay que romper

Antes de tocar la lógica del juego, leé `docs/DECISIONES.md`. Estos son los que
la suite verifica:

1. **El orden de `state.players` es el círculo.** El objetivo de cada uno es
   `players[(i + 1) % n]`. Cambiar el orden o sacar a alguien del array le cambia
   el objetivo a otro jugador y ensucia el historial. Por eso el orden se congela
   al empezar y en partida se retira (`status: 'quit'`) en vez de borrar.
2. **Los secretos no salen del servidor.** Todo lo que se manda al cliente pasa
   por `viewFor()`, que arma una vista por jugador. Si agregás campos al estado,
   fijate que no filtren el número de nadie.
3. **El `pid` tampoco sale.** Es la credencial: quien lo tenga es ese jugador.
   Hacia afuera cada uno se identifica con su `pub`, y los mensajes que nombran a
   otro se resuelven con `findByPub`. Si agregás un campo con un id, fijate de qué
   espacio es.
4. **En modo simultáneo los intentos pendientes no se publican** hasta que juegan
   todos. Solo su dueño ve el suyo (`you.pending`).
5. **La ronda se juega entera aunque alguien ya haya ganado**, para que pueda
   haber empate en la misma vuelta. Los ganadores se resuelven en `endRound()`.
6. **Nada se encola si se corta la conexión.** `send()` avisa y pide repetir.
7. **La máquina es un jugador más del círculo.** Tiene su `pub`, su lugar y su
   historial; lo único que la distingue es que no hay un websocket del otro lado.
   Entra al crearse la sala (uno contra uno) o en la espera con `addBot`, hasta
   tres por sala. Se saca con `kick`. Nunca es anfitriona y el barrido de
   ausentes no la toca.
8. **El nivel de la máquina viene de afuera**, así que se pregunta con
   `esNivel()` y no con `NIVELES[x]`: `toString` y `__proto__` contestan que sí
   por herencia.
9. **Un número no se puede tirar dos veces**, ni la persona ni la máquina. Se
   rechaza sin gastar el turno y el aviso dice qué había dado.
10. **El registro de partidas no lleva nada que identifique a nadie**: ni
    nombres, ni secretos, ni ids, ni código de sala. Si hace falta un campo, va
    al final del esquema y pasa por `filasDePartida()` y por "Qué es cada
    columna" en DECISIONES.

## 6. Operación y producción

### Secretos del Worker (se cargan con `npx wrangler secret put`, no están en el repo)

- **`RETO_CLAVE`, obligatoria y cargada.** Es con lo que se deriva el número del
  día (HMAC de la fecha). **No se cambia**: cambiarla cambia todos los números
  futuros, y en medio de un día deja a alguien adivinando otro número sin
  enterarse. Si falta, el desafío contesta 503 y el resto del juego sigue. En
  local y en CI va como `--var` con un valor de juguete.
- **`PRUEBA_CLAVE`, cargada.** Marca las partidas de prueba (`blob4 = 'prueba'`)
  para que `npm run datos` las excluya. Ver "Cualquier cosa contra producción va
  marcada", abajo.
- **`DISCORD_WEBHOOK_URL`, `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`: opcionales,
  cargados y probados.** De acá en más **el silencio es la señal buena**: solo
  escribe a Discord si se pasa el 50 % del cupo diario, si alguien pide más de
  10 salas por minuto, o si la consulta de uso falla.
- **Hay dos tokens de analytics vivos y no tienen el mismo valor.** El secreto
  del Worker `CF_ANALYTICS_TOKEN` tiene el **viejo**, que usa el aviso de cupo;
  la variable de entorno de la máquina de Lucas, que se llama igual, tiene uno
  **nuevo** (el panel lo lista como `CF_ANALYTICS_TOKEN_NEW`), que usa
  `npm run datos`. Pasó porque el valor viejo se perdió: ni el panel ni
  `wrangler secret list` devuelven un secreto ya cargado. Los dos solo pueden
  leer un contador de requests, así que no urge. **Si algún día se consolida**,
  el orden es cargar el nuevo en el Worker (redirigiendo desde un archivo, nunca
  por tubería, sección 9), comprobar que el cron sigue andando, y **recién ahí**
  revocar el viejo. Al revés deja el aviso de cupo mudo.
- `CLOUDFLARE_API_TOKEN` es un secreto del **repo de GitHub**, no del Worker: es
  con lo que despliega el workflow.

### Cualquier cosa contra producción va marcada

**Regla, sin excepciones: todo lo que juegue contra producción —la suite, un
script suelto, una verificación post-deploy, una prueba a mano— lleva la marca
de prueba.** Cada partida terminada escribe filas en el dataset con el que se
calibra al bot, y una partida de prueba sin marcar parece alguien que jugó mal.
Después no hay forma de distinguirla: el dataset no guarda ningún id.

Ya ensució dos veces, la segunda por alguien que había leído la advertencia, así
que la advertencia es un mecanismo:

- **`npm test` contra un `BASE` que no sea local se niega a arrancar sin
  `PRUEBA_CLAVE`** en el entorno, y corta antes de crear la primera sala.
- Un script suelto manda `?prueba=<clave>` **al crear la sala** (`POST
  /api/rooms`) o en cada pedido del desafío (`/api/reto`). Para las salas la marca
  se fija al crearla; ponerla después no hace nada.
- Si la clave está mal, no se marca nada y **no se avisa** en las salas; el
  desafío sí lo dice en pantalla. Ante la duda, `npm run datos` nombra cuántas
  filas sacó y por qué.
- **Abrir un desafío (GET) no escribe ninguna fila**: lo que ensucia es jugar.

Lo cómodo es dejar la clave puesta en la máquina:

```bash
setx PRUEBA_CLAVE "el-valor-del-secreto-del-worker"
```

Aplica recién en la próxima terminal. **Contra un servidor local esa variable no
se usa**: la suite manda la clave de juguete (`marca-local`), que es la que le
ponen `npm run dev`, `npm run dev:test` y el CI.

Con eso, probar contra producción es
`BASE=https://numerordle.lucasm3721.workers.dev npm test`.

Las filas que se ensuciaron antes de esto se sacan a mano y están listadas con
su fecha en `scripts/filas-de-prueba.mjs`. **Si esa lista crece, el problema no
es la lista**: es que se está probando sin marca.

### Deploy, rollback y qué mirar

- Automático: push a `main` con las verificaciones en verde.
- A mano, si GitHub Actions está caído (pasó el 6 de agosto de 2026):
  `npx wrangler deploy` desde una máquina con `npx wrangler login`. Publica el
  mismo commit que ya está en `main`, así que no saltea ninguna verificación,
  solo al mensajero. Para comprobar que llegó, `/api/reto` tiene que contestar
  con los campos de la versión nueva, o el `styles.css` servido traer la regla
  que se tocó.
- Volver atrás: `npx wrangler rollback`.
- Logs en vivo: `npm run tail`. El JSON que se baja del panel de logs **no tiene
  la forma que muestra el panel**: cuando el `console.log` fue un JSON, el objeto
  parseado queda en `source` (`e.source?.evento === 'partida'`), y el export viene
  cortado en las 1000 entradas más recientes.
- **El límite de creación de salas está en el código** (API de Rate Limiting de
  Workers, en `wrangler.jsonc`) y no en el panel, así el cliente puede mostrar un
  aviso decente en vez de una página de error de Cloudflare.
- Plan gratis: 100.000 requests por día al Worker (solo `/api/*`; lo estático no
  cuenta). Pasado el cupo, Cloudflare contesta el error 1027 hasta la medianoche
  UTC; no cobra, corta. El cliente lo detecta y lo explica.

### `npm run datos`

Necesita `CF_ANALYTICS_TOKEN` (token con un solo permiso: *Account · Account
Analytics · Read*) y `CF_ACCOUNT_ID` (`npx wrangler whoami`) en el entorno. No
vuelca filas: separa lo completo de lo censurado, saca las de prueba y nombra lo
que saca. **Leé "La trampa al leer los intentos" en DECISIONES antes de sacar
cualquier cuenta.** Se agrupa por `blob3` y no por `timestamp`, porque un desafío
del 5 se puede cerrar el 6.

## 7. Convenciones

- **La interfaz, los comentarios, los commits y los documentos van en español
  rioplatense.** Los mensajes de error los lee el jugador: que digan qué pasó, no
  un código.
- **Los commits son una oración que dice qué cambió para el juego**, no qué
  archivo se tocó. Mirá `git log --oneline` y seguí el tono. Si cierra un issue,
  va `(#n)` al final y el issue se cierra con `gh issue close <n>` diciendo en
  qué commit quedó.
- **Los comentarios explican decisiones, no mecánica.** Si el código ya lo dice,
  sobra. El porqué largo va a `docs/DECISIONES.md`, con su sección; el código
  la cita por nombre ("ver 'Nadie repite un número' en DECISIONES").
- **La documentación es parte del cambio.** Si un cambio invalida algo de esta
  guía, de DECISIONES o de ARQUITECTURA, se corrige en el mismo pull request.
  Esta guía solo dice lo que sigue siendo cierto; lo que dejó de serlo se borra.
- **El error va en el bloque donde se apretó el botón**, no en un cartel al pie.
  Cada tarjeta de la pantalla de inicio tiene el suyo (`create-error`,
  `bot-error`, `join-error`, `name-error`, `reto-error`); `home-error` y
  `home-busy` van arriba de todo y son solo para lo que no cuelga de ningún botón.
- **Entrar con un código no cambia de pantalla hasta que el servidor confirma.**
  La confirmación es el primer `state`; si llega un `kicked`, el motivo va al
  cartel del código. No hay una consulta previa que diga si una sala existe, y
  no hay que agregarla: la hubo (`/exists`) y se sacó porque servía para barrer
  códigos.
- **Sin dependencias en el cliente y sin paso de build.** Si algo necesita un
  bundler, probablemente no haga falta.
- **La forma del código de sala está escrita dos veces** (`CODE_LEN` y el
  alfabeto en `src/game.js`; `CODIGO_RE` en `public/app.js`) porque el cliente no
  importa nada del servidor. Lo mismo con `fechaDeHoy` (UTC−3) en `src/reto.js` y
  `public/racha.js`, y con `textoMarcador`. Si cambia una copia, cambia la otra.
- **La fuente display va en un solo lugar: el `h1` de la portada.** Los números
  van con `--fuente-num`, una condensada con dígitos del mismo ancho.
- **Las migraciones de `wrangler.jsonc` se agregan al final y no se editan**:
  cada tag ya corrió en producción.
- **El esquema del dataset solo crece por el final.** Reordenar columnas parte el
  histórico en dos.

## 8. Lo que queda por hacer

**Lo primero de cada sesión: `gh issue list`.** Ahí anota Lucas lo que se le
ocurre entre sesión y sesión. Lo que esté abierto es parte del pendiente tanto
como esta lista. Al 13 de septiembre de 2026 queda uno abierto (ese mismo día
se resolvieron #50, #51 y #52: el botón "atrás", las píldoras y la paleta de
marcas):

| Issue | Qué pide | Dónde se toca |
| --- | --- | --- |
| #46 | Abrir el desafío por primera vez devolvía 500 una de cada diez veces (13 de agosto). **El síntoma está tapado** en los dos caminos (reintento del GET en `src/index.js`, #45 y #49) y la causa sigue sin conocerse: es un `internal error; reference = …` de la plataforma al crear el Durable Object. El 13 de septiembre se midió de nuevo desde la misma red: 0 de 20. Faltan dos cosas: medirlo desde otra red (el celular con datos), y preguntar en el foro de Cloudflare con los `reference`. El issue tiene la tabla de mediciones y los scripts para reproducirlo. Si vuelve, los logs ahora traen `retryable` y `overloaded`. No se cierra hasta saber la causa | `src/index.js`, "El 500 al crear el objeto" en DECISIONES |

Y lo grande, que no es código:

1. **Calibrar los tres niveles de la máquina** (16 / 12 / 8 intentos) contra
   partidas reales. **Falta que juegue gente.** El lado del bot ya está medido:
   `npm run bot` da 15,3 / 11,7 / 8,0 de media. Del lado humano, medido el 8 de
   agosto con 26 observaciones completas: mediana 6, media 6,8, rango 5–17. Las
   dos fuentes (salas y desafíos) coinciden en mediana 6. Son pocas
   (`npm run datos` avisa por debajo de 30). **Antes de tocar los niveles, leé
   "Los niveles, cuando haya datos" en DECISIONES**: está medido el techo del bot
   (5,17) y la pregunta que va primero, que es si con una mediana humana de 6 no
   habrá que **bajar** las tres medias.
2. **Jugarlo y ver qué molesta**: la pausa de un segundo de la máquina, los 90 s
   de tolerancia, si el modo simultáneo sirve a lo largo del día, y si el tope de
   12 del desafío está bien puesto.

## 9. Trampas de la máquina de Lucas (Windows 11, PowerShell 5.1)

- **`wrangler dev` va y viene.** Anduvo el 5 de agosto, estuvo días sin arrancar
  ("access violation in the runtime", un Visual C++ Redistributable viejo), el 8
  volvió solo y el 13 de septiembre arrancó a la primera. Probalo, pero tratalo
  como que puede no estar: **la verificación real es la del pull request** y no
  hay que perder la tarde persiguiéndolo.
- **Node 20 necesita `--experimental-websocket`** (ya está en `npm test`).
- **No le pases valores a un comando por tubería.** Le mete un BOM adelante. Ya
  pasó con `$valor | wrangler secret put`: el secreto quedó con tres bytes
  invisibles y Cloudflare contestaba `not authorized for that account`. Redirigí
  desde un archivo escrito con `WriteAllText` y `UTF8Encoding $false`:
  `cmd /c "npx wrangler secret put NOMBRE < archivo.txt"`.
- **Tampoco redirijas binarios con `>`.** Reescribe la salida como texto. Usá
  `cmd /c "... > archivo"`.
- **No edites archivos con `Get-Content`/`Set-Content`.** Lee como ANSI y deja
  `mÃ¡quina` donde decía `máquina`, en todo el archivo. Usá las herramientas de
  edición del agente, o `[System.IO.File]::ReadAllText/WriteAllText` con UTF8
  explícito. Para comprobar que no pasó: `Select-String -Pattern 'Ã|â€'` no tiene
  que dar nada.
- **PowerShell 5.1 no negocia TLS 1.2 por defecto**, así que `Invoke-WebRequest`
  puede fallar contra Cloudflare. Para probar, `node -e "fetch(...)"`.
- `&&` no existe en PowerShell 5.1. En `bash` (CI, Git Bash) sí, y ahí es lo que
  hay que usar (sección 4).

## 10. Cómo trabaja un agente acá

1. `gh issue list`, y leer esta guía entera si es la primera sesión. Si vas a
   tocar código, `docs/ARQUITECTURA.md` primero; si vas a tocar una regla del
   juego, la sección correspondiente de `docs/DECISIONES.md`.
2. Rama nueva, cambios chicos, `npm run check` antes de cada commit y `npm test`
   (con `npm run dev:test` al lado) si se tocó `src/` o `public/`.
3. Pull request; que corra CI; mergear a `main` despliega solo.
4. Si el cambio invalida algo de un documento, corregirlo en el mismo PR. Si
   descubre un porqué nuevo, va a DECISIONES con su sección.
5. Cerrar el issue diciendo en qué commit quedó.
6. Nada contra producción sin la marca de prueba.
