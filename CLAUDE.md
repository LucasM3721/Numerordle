# Fijos y Picas — guía del repo

> **Dónde quedamos** (8 de agosto de 2026)
>
> El juego está terminado, en vivo y **con todo mergeado y desplegado**. El
> deploy automático funciona de punta a punta: cada push a `main` corre
> *Verificar* y *Desplegar*, y `npm test` son 196 verificaciones que pasan. (El
> número se mueve un poco entre corridas: el desafío que juega la suite tiene
> cuatro verificaciones que solo corren si no lo saca en doce.)
>
> Esta guía se lee sola. Lo que no está acá está en
> [docs/DECISIONES.md](docs/DECISIONES.md), que es donde vive el **porqué** de
> cada cosa —incluidas las ideas que se evaluaron y no entraron—. El historial
> de cambios es `git log`, no esta nota: acá va solo lo que sigue siendo cierto.
>
> **Lo que hay hoy, además del juego original:**
>
> - **El desafío del día**: un jugador solo contra el número de hoy, tope de 12,
>   en `src/reto.js` y la pantalla `screen-reto`. El número se deriva de la fecha
>   con HMAC y no se guarda en ningún lado. Va por HTTP y no por websocket, así
>   que se prueba entero sin abrir un socket. **Al agotar los doce pregunta** si
>   querés seguir buscándolo; se pierde igual, pero el número queda entero, y eso
>   convierte un "necesitaba más de doce" en un dato usable. Se puede revelar en
>   cualquier momento después del tope, y el que quedó jugando cuando cambia el
>   día tiene tres horas de gracia para terminar.
> - **Compartir el resultado**: emoji por intento, sin el número ni lo que se
>   tiró. Es lo único del juego que se pasa sin coordinar con nadie, y por eso es
>   la mejor herramienta que hay para el cuello de botella real (ver abajo).
> - **La puerta de ese link**: el texto compartido apunta a **`/reto`**, que
>   entra derecho al desafío sin pasar por la portada, y el HTML declara una
>   **tarjeta de preview** (`og:`) con `public/og.png` para que en WhatsApp y en
>   Discord no salga una URL pelada. Las reglas del juego están además **adentro
>   del desafío**, porque por ese camino la portada no se ve nunca. Las tres
>   cosas van juntas: sueltas no sirve ninguna.
> - **La racha del desafío**: cuántos días seguidos jugaste y cómo te fue en cada
>   uno, en la portada y en la pantalla final. Compartir trae gente nueva; esto
>   es la otra mitad, que es que vuelvan. **Vive entera en `localStorage` y no
>   viaja nada**: no hay tabla de posiciones ni nadie identificado. La cuenta
>   está en `public/racha.js`, aparte de `app.js` porque es pura y la suite la
>   prueba sin navegador.
> - **El registro anota qué era cada jugador** —persona o máquina, y de qué
>   nivel— y se guarda noventa días en Analytics Engine. Los logs solos duran
>   tres.
> - **`npm run datos`** lee ese dataset, **saca las filas de prueba** y aplica
>   las reglas de censura. No es un `SELECT` con formato lindo: sin separar lo
>   completo de lo truncado, el promedio sale más bajo que la verdad. Y **nombra
>   lo que saca**, que no es cosmético: la primera corrida contra los datos de
>   verdad delató una regla de exclusión demasiado ancha, que se estaba llevando
>   puesta una fila de alguien. Con un total ya limpio no se habría notado.
> - **La marca de prueba** (`?prueba=<clave>`), para que probar en producción no
>   ensucie la calibración.
> - **La revancha vuelve a la sala de espera**, no al reparto. Es lo único que
>   deja entrar a alguien nuevo: una sala terminada rechazaba con "esperá a que
>   terminen" para siempre. Ahí también se cambia el cupo, el modo y el orden.
>
> **Si el deploy automático no sale, se publica a mano.** El 6 de agosto de 2026
> GitHub Actions estuvo en interrupción mayor media tarde: las corridas quedaban
> encoladas o se cancelaban solas, y dos cambios se desplegaron con
> `npx wrangler deploy` desde la máquina de Lucas. Publica el mismo commit que
> ya está en `main`, así que no saltea ninguna verificación —solo al mensajero—.
> Para comprobar que llegó, `/api/reto` tiene que contestar con los campos de la
> versión nueva, o el `styles.css` servido traer la regla que se tocó.
>
> **Cuatro cosas de operación que no se deducen del código:**
>
> - **`RETO_CLAVE` está cargada** (como secreto del Worker, desde el panel) y es
>   con lo que se deriva el número del día. **No se cambia**: cambiarla cambia
>   todos los números futuros, y en medio de un día deja a alguien adivinando
>   otro número sin enterarse. Si falta, el desafío contesta 503 y el resto del
>   juego sigue andando. En local y en CI va como `--var` con un valor de
>   juguete; la de producción no está en el repo.
> - **`PRUEBA_CLAVE` marca las partidas de prueba** para que no ensucien la
>   calibración. La partida queda con `blob4 = 'prueba'` y `npm run datos` la
>   excluye. **Hasta el 8 de agosto no la excluía**: la consulta ni siquiera
>   leía esa columna, así que el mecanismo entero marcaba filas que después se
>   contaban igual. Cualquier número de calibración sacado antes de esa fecha
>   está inflado con partidas de prueba. Ver "Cualquier cosa contra producción
>   va marcada", más abajo.
> - **Los tres secretos opcionales están cargados y probados**
>   (`DISCORD_WEBHOOK_URL`, `CF_ACCOUNT_ID`, `CF_ANALYTICS_TOKEN`). De acá en
>   más **el silencio es la señal buena**: solo escribe a Discord si se pasa el
>   50 % del cupo diario, si alguien pide más de 10 salas por minuto, o si la
>   consulta falla.
> - **Hay dos tokens de analytics vivos, y no tienen el mismo valor.** El
>   secreto del Worker `CF_ANALYTICS_TOKEN` tiene el **viejo**, que es el que usa
>   el aviso de cupo; la variable de entorno de la máquina de Lucas, que se llama
>   igual, tiene uno **nuevo** —el panel lo lista como `CF_ANALYTICS_TOKEN_NEW`—
>   que es el que usa `npm run datos`. Pasó porque el valor viejo se perdió: ni
>   el panel ni `wrangler secret list` devuelven un secreto ya cargado. Los dos
>   solo pueden leer un contador de requests, así que no urge. **Si algún día se
>   consolida**, el orden es cargar el nuevo en el Worker —redirigiendo desde un
>   archivo, nunca por tubería—, comprobar que el cron sigue andando, y **recién
>   ahí** revocar el viejo. Al revés deja el aviso de cupo mudo.
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
> 1. **Calibrar los tres niveles de la máquina** (16 / 12 / 8 intentos) contra
>    partidas reales. **No queda nada que programar: falta que juegue gente.**
>
>    El lado del bot ya está medido y no depende de producción: `npm run bot` da
>    15,9 / 12,0 / 8,0 de media.
>
>    **Del lado humano, medido el 8 de agosto con el filtro ya arreglado** (46
>    filas crudas, 5 afuera: 2 marcadas y 3 a mano):
>
>    ```
>    personas, solo observaciones completas: n=26  mediana 6  media 6.8  rango 5–17
>      de partidas de sala: n=15  mediana 6  media 6.7  rango 5–17
>      de desafíos:         n=11  mediana 6  media 7.1  rango 5–10
>    ```
>
>    **Las dos fuentes coinciden en mediana 6**, y el desafío da la media más
>    alta. Eso es exactamente lo que predecía "El desafío del día" en DECISIONES:
>    una partida de sala solo deja observación completa si ganaste, y ganarle al
>    bot pide ser rápido; el desafío no tiene ese filtro. Que la predicción se
>    cumpla es la señal de que el marco está bien puesto — y de que **no hay que
>    ponderarlas a ojo**: si difirieran, el desacuerdo diría dónde mirar.
>
>    Siguen siendo pocas: `npm run datos` avisa solo por debajo de 30. Pero la
>    forma ya se ve, y confirma la hipótesis que había: **la gente está más
>    repartida que Lucas**, que anda por 6 siempre. El rango va de 5 a 17.
>
>    **Las filas que hay que sacar a mano ya no se sacan a mano**: están en
>    `scripts/filas-de-prueba.mjs` con su fecha y qué las delata, y la suite las
>    prueba. Si esa lista crece, el problema no es la lista: es que se está
>    probando sin marca.
>
>    Dos cosas para que lo que se junte sirva. **El desafío del día es la fuente
>    limpia**: sin rival no hay partida que corte antes de tiempo, así que el
>    número llega entero solo. En el uno contra uno hay que pedirles que **si
>    pierden sigan jugando**, o su fila queda truncada y no entra. El porqué
>    está en "La trampa al leer los intentos", en DECISIONES, y conviene leerlo
>    antes de sacar cualquier cuenta.
>
>    Para leer los datos, `npm run datos` saca las de prueba, aplica las reglas
>    de censura y compara contra el bot; el mapa de columnas está en "Qué es cada
>    columna". Ojo con una: se agrupa por `blob3` y no por `timestamp`, porque un
>    desafío del 5 se puede cerrar el 6.
>
>    **Antes de tocar los niveles, leé "Los niveles, cuando haya datos"** en
>    DECISIONES. Están medidos el techo del bot (5,17, igual que un resolvedor
>    perfecto), qué se puede hacer con las colas y qué no, y la pregunta que va
>    primero: si con una mediana humana de 6 no habrá que **bajar** las tres
>    medias para que perder vuelva a ser posible.
> 2. **Jugarlo y ver qué molesta**: la pausa de un segundo, los 90 s de
>    tolerancia, si el modo simultáneo sirve para jugar a lo largo del día, y si
>    el tope de 12 del desafío está bien puesto.
>
> **Cómo se verifica desde acá.** `wrangler dev` **va y viene** en la máquina de
> Lucas: anduvo el 5 de agosto de 2026, después estuvo días sin arrancar
> —"access violation in the runtime", un Visual C++ Redistributable viejo— y el
> 8 volvió a arrancar sin que se tocara nada, y aguantó toda la sesión. Probalo,
> pero tratalo como que puede no estar: **la verificación real es la del pull
> request** y no hay que perder la tarde persiguiéndolo. Lo que sí anda siempre,
> sin Worker, es `npm run check`, `npm run bot`, `npm run estatico` y las
> pruebas puras de la suite.
>
> Y algo que quedó demostrado el mismo día: **un CI en verde sobre una carrera
> no prueba que no haya bug.** El desafío mataba al Worker al contestar 409 sin
> leer el cuerpo del pedido, y la primera corrida pasó igual porque la ventana
> entre que el Worker muere y llega el pedido siguiente es una carrera. Si algo
> falla de a ratos, relanzalo antes de teorizar: dos corridas iguales dicen
> mucho más que una.
>
> - Para mirar la interfaz sin Worker: `npm run estatico`. De la sala en
>   adelante no sirve, porque no tiene websocket. **Para el desafío sí sirve**:
>   como habla por HTTP, alcanza con pisar `window.fetch` y contestarle lo mismo
>   que `src/reto.js`. Así se probaron el desafío ganado, el perdido en el tope
>   y el cambio de día, sin levantar el Worker.
> - Para probar lógica del cliente que depende del websocket, se pisa
>   `window.WebSocket` con un doble desde la consola (`app.js` resuelve el
>   global recién al hacer `new`). Dos cosas hacen que el doble sirva para
>   carreras: que su `close()` **no** dispare `onclose` —el evento lo soltás
>   vos, tarde, que es de donde salen los bugs— y pisar también `fetch` para
>   que cada sala nueva devuelva un código distinto. Después se maneja a
>   botonazos y se cuentan los sockets abiertos.
> - **Encadená con `&&`, no con `;`.** Dos veces se dio por bueno un
>   `npm run check` que estaba fallando, porque el `echo OK` iba después de un
>   punto y coma. Y ojo con meter `grep` en una cadena `&&`: sale con estado 1
>   cuando no encuentra nada, así que corta todo lo que venga después — una vez
>   se comió el `git commit` y la rama se empujó vacía.
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
npm run datos    # resumen del dataset, con las reglas de censura aplicadas
```

**`npm run datos` necesita dos variables** que no están en el repo:
`CF_ANALYTICS_TOKEN` (se crea en el panel: API Tokens → Custom Token → *Account ·
Account Analytics · Read*, un solo permiso, solo lectura) y `CF_ACCOUNT_ID` (sale
de `npx wrangler whoami`). En Windows se dejan puestas con `setx NOMBRE "valor"`,
que aplica recién en la próxima terminal. No vuelca filas: separa lo completo de
lo censurado, que es lo único que hace que el número sirva.

**`npm test` necesita `npm run dev:test` en otra terminal, no `npm run dev`.** La
diferencia es una variable que baja a 2,5 s el margen con el que se pasa el turno
de un ausente; con los 90 s de verdad, dos casos tardarían más que toda la suite
y fallan por tiempo agotado. Para jugar a mano usá `npm run dev`, que respeta el
margen real.

## Cualquier cosa contra producción va marcada

**Regla, sin excepciones: todo lo que juegue contra producción —la suite, un
script suelto, una verificación post-deploy, una prueba a mano— lleva la marca
de prueba.** Cada partida terminada escribe filas en el dataset con el que se
calibra al bot, y una partida de prueba sin marcar parece alguien que jugó mal.
Después no hay forma de distinguirla: el dataset no guarda ningún id.

Ya ensució dos veces. La segunda fue una verificación post-deploy escrita por
alguien que había leído la advertencia, así que la advertencia ahora es un
mecanismo:

- **`npm test` contra un `BASE` que no sea local se niega a arrancar sin
  `PRUEBA_CLAVE`**, y corta antes de crear la primera sala.
- Un script suelto tiene que mandar `?prueba=<clave>` **al crear la sala**
  (`POST /api/rooms`) o en cada pedido del desafío (`/api/reto`). Para las salas
  la marca se fija al crearla: ponerla después no hace nada.
- Si la clave está mal, no se marca nada y **no se avisa** en las salas —el
  desafío sí lo dice en pantalla—. Ante la duda, mirá el `blob4` con
  `npm run datos`, que ahora nombra cuántas filas sacó y por qué.

Lo cómodo es dejar la clave puesta de una vez en la máquina, así ningún comando
depende de acordarse:

```bash
setx PRUEBA_CLAVE "el-valor-del-secreto-del-worker"
```

Aplica recién en la próxima terminal. El valor es el secreto `PRUEBA_CLAVE` del
Worker; no está en el repo.

Con eso, probar contra producción es
`BASE=https://numerordle.lucasm3721.workers.dev npm test`. Tarda un minuto de
más: la suite pide doce salas y el límite es de diez por minuto, así que las que
sobran esperan a que se libere la ventana.

Las filas que ya se ensuciaron antes de todo esto se sacan a mano, y están
listadas con su fecha en `scripts/filas-de-prueba.mjs`. Si esa lista crece, el
problema no es la lista.

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
| `src/reto.js` | el desafío del día: el número derivado de la fecha y su Durable Object |
| `public/` | cliente completo: un HTML, un CSS, dos JS, una fuente y la tarjeta de preview. Sin build ni dependencias |
| `public/racha.js` | la cuenta de la racha del desafío. Puro: no toca el DOM ni `localStorage`, y por eso la suite lo prueba sin navegador |
| `scripts/filas-de-prueba.mjs` | qué filas del dataset no cuentan para calibrar. Puro por el mismo motivo: la suite lo prueba sin token ni red |
| `public/og.png` | la tarjeta que se ve al pegar el link. 1200×630, y las medidas están declaradas en el HTML: la suite compara las dos |

## Invariantes que no hay que romper

1. **El orden de `state.players` es el círculo.** El objetivo de cada uno es
   `players[(i + 1) % n]`. Cambiar el orden o sacar a alguien del array le cambia
   el objetivo a otro jugador y ensucia el historial. Por eso el orden se congela
   al empezar y en partida se retira (`status: 'quit'`) en vez de borrar. Es
   además lo único que hay que entender para usar ▲▼, así que la interfaz lo
   dice con todas las letras: "Quién le adivina a quién".
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
  probablemente no haga falta. Los dos binarios del repo son
  `public/fuentes/anton-latin.woff2`, que se baja de Google Fonts y se commitea
  tal cual —no se recorta ni se genera acá—, con su `anton-OFL.txt` al lado
  porque la licencia lo pide; y `public/og.png`, la tarjeta de preview, que es
  PNG porque WhatsApp no muestra SVG. Cómo se generó está en DECISIONES, en "El
  segundo binario del repo": se rasterizó **a mano y una sola vez**, y nada de
  eso corre en el deploy.
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
