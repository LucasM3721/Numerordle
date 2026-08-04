# Fijos y Picas — guía del repo

> **Dónde quedamos** (última sesión: agosto 2026)
>
> El juego está terminado y en vivo. El deploy automático funciona de punta a
> punta: el secreto está cargado y el workflow pasa entero, *Verificar* y
> *Desplegar*.
>
> Lo último que se hizo fue prepararlo para **abrir el link al público**, en una
> pila de nueve pull requests (cupo configurable → identidad → endurecer →
> cabeceras → límites de creación, y de ahí tres puntas: rival de la máquina,
> registro de partidas y servidor estático de desarrollo). **Están todas
> mergeadas y desplegadas.**
>
> El grande es el de identidad: `viewFor` mandaba a todos el `pid` de cada
> jugador, que es la credencial, así que cualquiera que hubiera pasado por la
> sala podía reconectarse como otro y el servidor le contestaba con su número
> secreto.
>
> Al mergear se resolvió un conflicto en `package.json`: dos puntas habían
> agregado archivos distintos al comando `check`. Quedaron los dos.
>
> **Ojo al probar contra producción**: la suite entera crea más de 10 salas por
> minuto y hace saltar el límite de `CREAR_SALA`, o sea que falla sola. Contra
> producción conviene una prueba corta y a mano.
>
> El límite de creación de salas quedó **en el código** (API de Rate Limiting de
> Workers, en `wrangler.jsonc`) y no en el panel, así el cliente puede mostrar
> un aviso decente en vez de una página de error de Cloudflare.
>
> **Los tres secretos opcionales ya están cargados y probados de punta a punta**
> (`DISCORD_WEBHOOK_URL`, `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`). El aviso de
> cupo llega a Discord con el número real. De acá en más **el silencio es la
> señal buena**: solo escribe si se pasa el 50% del cupo, si alguien pide más de
> 10 salas por minuto, o si la consulta falla.
>
> Después de la pila se agregaron tres cosas de juego, todas desplegadas:
> la **pausa de un segundo** antes de mostrar la jugada de la máquina, poder
> **escribir el número antes de que te toque**, y que **el turno de un ausente se
> pase solo** a los 90 s (antes la partida quedaba detenida hasta que el
> anfitrión apretara el botón). El cursor vuelve al primer dígito al arriesgar.
>
> Ojo con dos ideas descartadas: **una regla de Rate Limiting del WAF no se puede
> usar acá** —son de zona y `workers.dev` no es una zona propia—, y **el cron no
> se puede disparar a mano**: para probar algo que corre por cron, lo que
> funcionó fue una ruta temporal e impredecible en `fetch`, llamarla una vez y
> borrarla. Cambiar el cron a cada minuto es más lento de propagar y menos
> controlable.
>
> **Lo que queda por hacer**, sin urgencia:
>
> 1. **Calibrar los tres niveles de la máquina** (16 / 12 / 8 intentos) contra
>    partidas reales. Hoy son una hipótesis; el registro de partidas ya está
>    juntando datos, se leen con `npm run tail`.
> 2. **Jugarlo y ver qué molesta**: la pausa de un segundo, los 90 s de
>    tolerancia, si el modo simultáneo sirve para jugar a lo largo del día.
>
> Ideas que se evaluaron y se descartaron (con el porqué) están al final de
> [docs/DECISIONES.md](docs/DECISIONES.md).

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
| `public/` | cliente completo: un HTML, un CSS, un JS. Sin build ni dependencias |

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

- **No le pases valores a un comando por tubería en PowerShell 5.1.** Le mete un
  BOM adelante. Ya pasó con `$valor | wrangler secret put`: el secreto quedó
  guardado con tres bytes invisibles al principio, y la API de Cloudflare
  contestaba `not authorized for that account` sin decir por qué. Redirigí desde
  un archivo escrito con `WriteAllText` y `UTF8Encoding $false`:
  `cmd /c "npx wrangler secret put NOMBRE < archivo.txt"`.
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
- Sin dependencias en el cliente y sin paso de build. Si algo necesita un bundler,
  probablemente no haga falta.
- Los comentarios explican decisiones, no mecánica. Si el código ya lo dice, sobra.
