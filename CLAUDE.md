# Fijos y Picas — guía del repo

> **Dónde quedamos** (última sesión: agosto 2026)
>
> El juego está terminado y en vivo, jugado y probado con gente real. El deploy
> automático **ya funciona de punta a punta**: el secreto `CLOUDFLARE_API_TOKEN`
> está cargado en GitHub y el workflow pasó entero, *Verificar* (sintaxis, build
> y la partida de prueba en CI) y *Desplegar*. Se comprobó además que producción
> sirve exactamente los mismos archivos que hay en `main`.
>
> Lo único pendiente:
>
> 1. **Pendiente menor**: las *preview URLs* quedaron activadas por defecto en el
>    deploy. Cada versión publicada queda accesible en una URL pública aparte.
>    Para este juego es inofensivo; se apaga con `"preview_urls": false` en
>    `wrangler.jsonc` y un deploy.
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

`npm test` necesita `npm run dev` corriendo en otra terminal. Para probar contra
producción: `BASE=https://numerordle.lucasm3721.workers.dev npm test`.

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
3. **En modo simultáneo los intentos pendientes no se publican** hasta que juegan
   todos. Solo su dueño ve el suyo (`you.pending`).
4. **La ronda se juega entera aunque alguien ya haya ganado**, para que pueda haber
   empate en la misma vuelta. Los ganadores se resuelven en `endRound()`.
5. **Nada se encola si se corta la conexión.** `send()` avisa y pide repetir.

## Cómo probar

`scripts/smoke.mjs` (o sea `npm test`) juega dos partidas enteras y verifica los
cinco invariantes de arriba. **Si tocás la lógica del juego, agregale un caso.**
Se validó rompiendo el cálculo de picas a propósito: la prueba falla y corta el
deploy, que es lo único que hace que valga la pena tenerla.

Para explorar algo puntual, el patrón manual es abrir varios websockets con
identidades distintas. Con `npm run dev` corriendo:

```bash
node --experimental-websocket -e "const B='http://127.0.0.1:8787', WS='ws://127.0.0.1:8787'; (async()=>{ const {code}=await (await fetch(B+'/api/rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'sim'})})).json(); const open=(pid,name)=>new Promise((ok,no)=>{const w=new WebSocket(WS+'/api/rooms/'+code+'/ws?pid='+pid+'&name='+name); w.states=[];w.errs=[]; w.addEventListener('message',e=>{const m=JSON.parse(e.data); m.t==='state'?w.states.push(m):w.errs.push(m);}); w.addEventListener('open',()=>ok(w)); w.addEventListener('error',no);}); const wait=ms=>new Promise(r=>setTimeout(r,ms)), say=(w,m)=>w.send(JSON.stringify(m)), last=w=>w.states.at(-1); const A=await open('a','Ana'), B2=await open('b','Beto'); await wait(400); say(A,{t:'start'}); await wait(300); say(A,{t:'setSecret',secret:'1234'}); say(B2,{t:'setSecret',secret:'5678'}); await wait(500); say(A,{t:'guess',guess:'5678'}); say(B2,{t:'guess',guess:'1289'}); await wait(600); console.log(JSON.stringify(last(A).log,null,1)); process.exit(0); })()"
```

Cambiando `B`/`WS` a `https://…` y `wss://…` corre lo mismo contra producción.

Detalles que ahorran tiempo:

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
