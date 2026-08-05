# Fijos y Picas — guía del repo

> **Dónde quedamos** (5 de agosto de 2026)
>
> El juego está terminado, en vivo y **con todo mergeado y desplegado**. El
> deploy automático funciona de punta a punta: cada push a `main` corre
> *Verificar* y *Desplegar*, y `npm test` son 89 verificaciones que pasan.
>
> Esta guía se lee sola. Lo que no está acá está en
> [docs/DECISIONES.md](docs/DECISIONES.md), que es donde vive el **porqué** de
> cada cosa —incluidas las ideas que se evaluaron y no entraron—. El historial
> de cambios es `git log`, no esta nota: acá va solo lo que sigue siendo cierto.
>
> **Lo último que se hizo** (sesión del 5 de agosto): el cliente dejó de
> reconectarse solo a la sala anterior (era un `onclose` viejo que seguía
> armado); el uno contra uno **ya no pasa por la sala de espera**; el título
> tiene **fuente propia** (Anton, 18 KB, en `public/fuentes/`); las filas del
> tablero dejaron de partirse en dos renglones en el celular; y el registro de
> partidas pasó a anotar **quién era máquina y de qué nivel**, sin lo cual no
> se puede calibrar nada, y a guardarse noventa días en Analytics Engine.
>
> **Tres cosas de operación que no se deducen del código:**
>
> - **Los tres secretos opcionales están cargados y probados**
>   (`DISCORD_WEBHOOK_URL`, `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`). De acá en
>   más **el silencio es la señal buena**: solo escribe a Discord si se pasa el
>   50 % del cupo diario, si alguien pide más de 10 salas por minuto, o si la
>   consulta falla.
> - **El límite de creación de salas está en el código** (API de Rate Limiting
>   de Workers, en `wrangler.jsonc`) y no en el panel, así el cliente puede
>   mostrar un aviso decente en vez de una página de error de Cloudflare.
> - **La suite crea doce salas** y el límite es de diez por minuto, así que una
>   espera a que se libere la ventana: la corrida tarda un minuto más de lo que
>   tardaría sin límite, y por eso mismo se puede correr contra producción. Si
>   agregás una suite, fijate si podés usar una sala que ya exista.
>
> **Lo que queda por hacer**, en este orden:
>
> 1. **Desafío del día**: uno solo adivina, con un tope de intentos. Es el más
>    grande: no hay círculo ni rival. El número del día **no puede viajar al
>    cliente**, se valida en el servidor o el desafío se muere solo. **El diseño
>    ya está decidido y escrito** —clase de Durable Object aparte, número
>    derivado con HMAC, tope de 12, HTTP en vez de websocket—: está en "El
>    desafío del día", en DECISIONES. Lo que falta es construirlo.
> 2. **Calibrar los tres niveles de la máquina** (16 / 12 / 8 intentos) contra
>    partidas reales. El lado del bot ya está medido y es reproducible sin
>    servidor: `npm run bot` da 15,9 / 12,0 / 8,0 de media. Falta el lado
>    humano, y **el reloj arranca de cero**: hasta el 5 de agosto de 2026 el
>    registro no anotaba quién era máquina y quién persona, así que lo juntado
>    hasta entonces no se puede usar (ver "Lo único que se registra" en
>    DECISIONES). Desde ahora se acumula en Analytics Engine, noventa días.
>    Dos cosas antes de juntar: **hace falta que juegue otra gente** —las 23
>    partidas que había eran todas de Lucas, que es rápido y no sirve de
>    muestra— y hay que pedirles que **si pierden sigan jugando**, que es lo que
>    hace que su número se registre entero. El porqué está en "La trampa al leer
>    los intentos", en DECISIONES.
> 3. **Jugarlo y ver qué molesta**: la pausa de un segundo, los 90 s de
>    tolerancia, si el modo simultáneo sirve para jugar a lo largo del día.
>
> **Cómo se verifica desde acá.** `wrangler dev` **va y viene** en la máquina de
> Lucas: el 5 de agosto de 2026 arrancó y corrió la suite entera local, 89 de
> 89, y esa misma tarde volvió a tirar "access violation in the runtime" —un
> Visual C++ Redistributable viejo—. Tratalo como que puede no estar: **la
> verificación real es la del pull request** y no hay que perder la tarde
> persiguiéndolo. Lo que sí anda siempre, sin Worker, es `npm run check`,
> `npm run bot` y las pruebas puras de la suite.
>
> - Para mirar la interfaz sin Worker: `npm run estatico`. De la sala en
>   adelante no sirve, porque no tiene websocket.
> - Para probar lógica del cliente que depende del websocket, se pisa
>   `window.WebSocket` con un doble desde la consola (`app.js` resuelve el
>   global recién al hacer `new`). Dos cosas hacen que el doble sirva para
>   carreras: que su `close()` **no** dispare `onclose` —el evento lo soltás
>   vos, tarde, que es de donde salen los bugs— y pisar también `fetch` para
>   que cada sala nueva devuelva un código distinto. Después se maneja a
>   botonazos y se cuentan los sockets abiertos.
> - Para probar CSS desde la consola, **un `<style>` inyectado no sirve**: lo
>   bloquea la CSP (`style-src 'self'`). `insertRule` sobre la hoja que ya está
>   cargada sí anda, y se borra con `deleteRule`.

Juego de adivinar números de 4 dígitos, multijugador por link. Corre en Cloudflare
Workers: cada sala es un Durable Object con su propio estado y sus websockets.

**Antes de tocar la lógica del juego, leé [docs/DECISIONES.md](docs/DECISIONES.md).**
Ahí está el porqué de las reglas y varios invariantes que no son obvios en el código.

## Comandos

```bash
npm run dev      # servidor local en http://localhost:8787
npm run check    # sintaxis de src/ y public/
npm test         # juega partidas de prueba contra el servidor local
npm run deploy   # publica a Cloudflare (a mano)
npm run tail     # logs de producción en vivo
```

**`npm test` necesita `npm run dev:test` en otra terminal, no `npm run dev`.** La
diferencia es una variable que baja a 2,5 s el margen con el que se pasa el turno
de un ausente; con los 90 s de verdad, dos casos tardarían más que toda la suite
y fallan por tiempo agotado. Para jugar a mano usá `npm run dev`, que respeta el
margen real.

Para probar contra producción: `BASE=https://numerordle.lucasm3721.workers.dev npm test`.
Tarda un minuto de más: la suite pide doce salas y el límite es de diez por
minuto, así que las que sobran esperan a que se libere la ventana.

**Cada push a `main` despliega solo**, pero únicamente si pasan `check`, el build
y `npm test` (ver `.github/workflows/deploy.yml`). Trabajá en ramas y abrí un pull
request: ahí corren las verificaciones sin desplegar nada.

Producción: https://numerordle.lucasm3721.workers.dev
Para volver atrás un deploy: `npx wrangler rollback`.

## Estructura

| Archivo | Qué hace |
| --- | --- |
| `src/game.js` | reglas puras: validar un número, contar fijos y picas |
| `src/room.js` | el Durable Object: máquina de estados de la sala |
| `src/index.js` | Worker de entrada: crea salas, enruta el websocket |
| `src/bot.js` | la cabeza de la máquina: su cuaderno y los tres niveles |
| `public/` | cliente completo: un HTML, un CSS, un JS y una fuente. Sin build ni dependencias |

## Invariantes que no hay que romper

1. **El orden de `state.players` es el círculo.** El objetivo de cada uno es
   `players[(i + 1) % n]`. Cambiar el orden o sacar a alguien del array le cambia
   el objetivo a otro jugador y ensucia el historial. Por eso el orden se congela
   al empezar y en partida se retira (`status: 'quit'`) en vez de borrar.
2. **Los secretos no salen del servidor.** Todo lo que se manda al cliente pasa por
   `viewFor()`, que arma una vista por jugador. Si agregás campos al estado,
   fijate que no filtren el número de nadie.
3. **El `pid` tampoco sale.** Es la credencial: quien lo tenga es ese jugador.
   Hacia afuera cada uno se identifica con su `pub`, y los mensajes que nombran
   a otro se resuelven con `findByPub`. Si agregás un campo con un id, fijate
   de qué espacio es (ver `viewFor` y docs/DECISIONES.md).
4. **En modo simultáneo los intentos pendientes no se publican** hasta que juegan
   todos. Solo su dueño ve el suyo (`you.pending`).
5. **La ronda se juega entera aunque alguien ya haya ganado**, para que pueda haber
   empate en la misma vuelta. Los ganadores se resuelven en `endRound()`.
6. **Nada se encola si se corta la conexión.** `send()` avisa y pide repetir.
7. **La máquina es un jugador más del círculo.** Tiene su `pub`, su lugar en el
   orden y su historial; lo único que la distingue es que no hay un websocket
   del otro lado. Entra en dos momentos y ninguno es con la partida en curso:
   al crearse la sala (el uno contra uno, que por eso ya nace en el reparto) o
   en la espera con `addBot`, del anfitrión, hasta tres por sala. No hay un
   `removeBot`: se saca con el mismo `kick`. Nunca es anfitriona y el barrido
   de ausentes no la toca.
8. **El nivel de la máquina viene de afuera**, así que se pregunta con
   `esNivel()` y no con `NIVELES[x]`: `toString` y `__proto__` contestan que sí
   por herencia y dejarían una máquina con un nivel que no existe.

## Cómo probar

`scripts/smoke.mjs` (o sea `npm test`) juega partidas enteras y verifica los
invariantes de arriba. **Si tocás la lógica del juego, agregale un caso.**
Se validó rompiendo el cálculo de picas a propósito: la prueba falla y corta el
deploy, que es lo único que hace que valga la pena tenerla.

Para explorar algo puntual, el patrón manual es abrir varios websockets con
identidades distintas. Con `npm run dev` corriendo:

```bash
node --experimental-websocket -e "const B='http://127.0.0.1:8787', WS='ws://127.0.0.1:8787'; (async()=>{ const {code}=await (await fetch(B+'/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'sim'})})).json(); const open=(pid,name)=>new Promise((ok,no)=>{const w=new WebSocket(WS+'/api/rooms/'+code+'/ws?pid='+pid+'&name='+name); w.states=[];w.errs=[]; w.addEventListener('message',e=>{const m=JSON.parse(e.data); m.t==='state'?w.states.push(m):w.errs.push(m);}); w.addEventListener('open',()=>ok(w)); w.addEventListener('error',no);}); const wait=ms=>new Promise(r=>setTimeout(r,ms)), say=(w,m)=>w.send(JSON.stringify(m)), last=w=>w.states.at(-1); const A=await open('a','Ana'), B2=await open('b','Beto'); await wait(400); say(A,{t:'start'}); await wait(300); say(A,{t:'setSecret',secret:'1234'}); say(B2,{t:'setSecret',secret:'5678'}); await wait(500); say(A,{t:'guess',guess:'5678'}); say(B2,{t:'guess',guess:'1289'}); await wait(600); console.log(JSON.stringify(last(A).log,null,1)); process.exit(0); })()"
```

Cambiando `B`/`WS` a `https://…` y `wss://…` corre lo mismo contra producción.

Detalles que ahorran tiempo:

- **El JSON que se baja del panel de logs no tiene la forma que muestra el
  panel.** Cada entrada trae `$workers`, `$metadata`, `dataset`, `timestamp` y
  `source`, y cuando el `console.log` fue un JSON **el objeto parseado queda en
  `source`** (`source.evento`, `source.intentos`). `source.message` existe solo
  para los logs que son texto suelto. La interfaz lo muestra todo aplanado al
  nivel de arriba, así que copiar esa forma no encuentra nada. Se filtra con
  `e.source?.evento === 'partida'`. Y **el export viene cortado en 1000
  entradas**, las más recientes: el rango de fechas del archivo no es la ventana
  de retención, aunque lo parezca.
- **No le pases valores a un comando por tubería en PowerShell 5.1.** Le mete un
  BOM adelante. Ya pasó con `$valor | wrangler secret put`: el secreto quedó
  guardado con tres bytes invisibles al principio, y la API de Cloudflare
  contestaba `not authorized for that account` sin decir por qué. Redirigí desde
  un archivo escrito con `WriteAllText` y `UTF8Encoding $false`:
  `cmd /c "npx wrangler secret put NOMBRE < archivo.txt"`.
- **Tampoco redirijas binarios con `>` en PowerShell 5.1.** Reescribe la salida
  como texto: comparar `git show HEAD:public/fuentes/anton-latin.woff2 > x.woff2`
  contra el archivo del disco daba 33.844 bytes contra 18.612 y hashes
  distintos, y la fuente estaba perfecta. Redirigí por `cmd /c "... > archivo"`,
  igual que para cargar secretos.
- **No edites archivos con `Get-Content`/`Set-Content` en PowerShell 5.1.** Lee
  como ANSI y te deja `mÃ¡quina` donde decía `máquina`, en todo el archivo y de
  una sola pasada. Usá las herramientas de edición del agente, o
  `[System.IO.File]::ReadAllText/WriteAllText` con UTF8 explícito. Para
  comprobar que no pasó: `Select-String -Pattern 'Ã|â€'` no tiene que dar nada.
- **Node 20 necesita `--experimental-websocket`.**
- **Dejá aire entre jugadas** (~500 ms). Si disparás rondas más rápido de lo que se
  resuelven, los intentos nuevos pisan los pendientes y parece un bug que no hay.
- **Dos pestañas del navegador son el mismo jugador** (comparten `localStorage`).
  Para probar a mano, usá ventanas de incógnito distintas.
- Para probar el barrido de ausentes, bajá `GRACE_MS` en `src/room.js`
  temporalmente en vez de esperar 90 segundos.
- Editar cualquier archivo reinicia el Worker en `dev` y corta los websockets
  abiertos. El cliente reconecta solo, pero un script de prueba a medias no.

## Convenciones

- La interfaz y los comentarios van en **español rioplatense**. Los mensajes de
  error los lee el jugador: que digan qué pasó, no un código.
- **El error va en el bloque donde se apretó el botón**, no en un cartel al pie.
  Cada tarjeta de la pantalla de inicio tiene el suyo (`create-error`,
  `bot-error`, `join-error`, `name-error`); `home-error` y `home-busy` quedan
  arriba de todo y son solo para lo que no cuelga de ningún botón. Un cartel
  fuera de la vista se lee como que el botón no hizo nada.
- **Entrar con un código no cambia de pantalla hasta que el servidor confirma.**
  La confirmación es el primer `state`; si en vez de eso llega un `kicked`, el
  motivo va al cartel del código y nunca se salió del inicio. No hay una
  consulta previa que diga si una sala existe, y no hay que agregarla: la hubo
  (`/exists`) y se sacó porque servía para barrer códigos a ver cuáles había.
- Sin dependencias en el cliente y sin paso de build. Si algo necesita un bundler,
  probablemente no haga falta. El único binario del repo es
  `public/fuentes/anton-latin.woff2`, que se baja de Google Fonts y se commitea
  tal cual —no se recorta ni se genera acá—, con su `anton-OFL.txt` al lado
  porque la licencia lo pide.
- **La fuente display va en un solo lugar: el `h1` de la portada.** En los `h2` y
  en los resúmenes de los plegables cansa, porque ahí se lee y no se mira. Los
  números —el pad, la fila de intentos, tu número, fijos y picas— van con
  `--fuente-num`, una condensada con dígitos del mismo ancho; si se cambia, que
  la que entre también los tenga o los intentos dejan de alinearse en vertical.
- **La forma del código de sala está escrita dos veces** —`CODE_LEN` y el
  alfabeto en `src/game.js`, `CODIGO_RE` en `public/app.js`— porque el cliente
  no importa nada del servidor. Si cambia una, cambia la otra: el servidor la
  usa para no despertar un Durable Object al pedo, y el cliente para no abrir
  un websocket que va a ser rechazado.
- Los comentarios explican decisiones, no mecánica. Si el código ya lo dice, sobra.
