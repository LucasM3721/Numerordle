# Decisiones y contexto

Por qué el proyecto es como es. El código dice *qué* hace; esto dice *por qué*, que
es lo que se pierde cuando pasan seis meses o cambiás de computadora.

## De dónde sale el juego

Un juego de lápiz y papel. Cada jugador anota un número de 4 dígitos (del 1 al 9,
sin repetir). Se arma un círculo y **a cada uno le toca adivinarle el número al
siguiente**; el último le adivina al primero. Con dos jugadores es mutuo.

En tu turno arriesgás un número y te contestan dos cifras: **fijos** (dígitos
acertados en su posición) y **picas** (dígitos que están, pero en otro lugar).
Nunca se dice *cuáles*: solo cuántos. Cuatro fijos y ganaste, pero **la ronda se
juega entera** por si alguien más acierta en la misma vuelta — puede haber empate.
Después, el que quiera sigue jugando por el gusto de encontrarlo.

Todo lo demás del proyecto existe para respetar eso.

## La decisión de la que cuelgan todas las demás

**El orden del array `state.players` ES el círculo**, y el objetivo de cada jugador
se calcula como `players[(i + 1) % n]`. No se guarda una tabla de objetivos.

Es simple y no se puede desincronizar, pero tiene una consecuencia que hay que
tener siempre presente: **cualquier cosa que cambie el orden o saque a alguien del
array le cambia el objetivo a otro jugador.** De ahí salen tres reglas:

- El orden se puede reacomodar solo en la sala de espera. Al empezar el reparto de
  números se congela: cambiarle el objetivo a alguien que ya está pensando su
  número es desagradable y le invalida lo que venía deduciendo.
- Sacar a alguien en plena partida **no lo borra del array**: lo marca `quit`. Deja
  de jugar, pero su número sigue siendo el objetivo de quien lo tenía y el
  historial sigue teniendo sentido.
- El barrido de ausentes tampoco toca a nadie con la partida empezada.

Si alguna vez hace falta sacar gente del círculo en caliente, hay que rehacer los
objetivos *y* reinterpretar el historial. No vale la pena.

## Reparto de responsabilidades

| Dónde | Qué vive ahí | Por qué |
| --- | --- | --- |
| `src/game.js` | validar un número, contar fijos y picas | funciones puras, se razonan de un vistazo |
| `src/room.js` | máquina de estados de la sala | un Durable Object por sala: estado aislado, sin base de datos |
| `src/index.js` | crear salas, enrutar el websocket | el Worker casi no hace nada |
| `public/` | el cliente entero | sin framework ni build: se edita y se ve |

## Por qué el servidor sabe todo

Los números secretos **nunca salen del servidor**. Cada websocket recibe una vista
personalizada (`viewFor`): ves tu número y los que ya se revelaron, nada más. Abrir
las herramientas de desarrollo no sirve de nada.

Corolario: **el servidor calcula fijos y picas**. En papel esto lo hace la persona,
y se equivoca o filtra información sin querer. Acá no puede pasar.

El historial de intentos, en cambio, **es público a propósito**: en la mesa
escuchás lo que arriesgan todos.

## Los dos modos

- **Ronda simultánea** (por defecto): cada uno manda su intento cuando puede y se
  revelan todos juntos. Los pendientes se guardan **sin publicarse**, así nadie
  copia la jugada del otro. Podés cambiar el tuyo hasta que jueguen todos. Sirve
  igual en vivo y para jugar a lo largo del día.
- **Por turnos**: uno a la vez, con el resultado a la vista al toque. Fiel al
  original, pero necesita a todos conectados.

En ambos, si alguien desaparece a mitad de ronda el anfitrión puede destrabarla
(saltear el turno, o cerrar la ronda sin los que faltan). Sin eso, un solo ausente
congela la partida para siempre — pasó y por eso existe.

## Reconexión: no se encola nada

Si el socket está caído, el cliente **avisa y pide repetir** en vez de guardar el
mensaje para mandarlo después. Un intento reenviado tras reconectar podría caer en
una ronda distinta a la que apuntaba, y eso es peor que perderlo.

La identidad del jugador vive en `localStorage`, así que recargar la página o
cambiar de dispositivo no te saca: el estado está en el servidor.

## El cuaderno del jugador

Las marcas sobre los dígitos (tachado / subrayado / círculo) son **puramente del
cliente**: `localStorage`, sin validación, sin viajar al servidor. Es un cuaderno,
no una verdad: podés marcar cualquier cosa aunque esté mal, y de eso se trata —
al terminar la partida ves al lado del número real en qué te habías equivocado.

Se guardan con clave `fp:marks:<sala>:<partida>`, así sobreviven a un refresh y se
limpian solas en la revancha sin arrastrar nada.

El casillero donde escribís es **la fila siguiente del tablero**, no un cuadro
aparte: comparás con el intento de arriba y ya ves dónde va a caer el resultado.

## Ausentes

Cerrar la página no te saca al instante, porque recargar, cambiar de wifi o que se
bloquee el teléfono no deberían echarte. Después de **90 segundos** sí, y solo
donde es seguro:

- **Sala de espera**: te va.
- **Eligiendo número**: te va solo si todavía no elegiste. El que ya se comprometió
  se queda aunque pierda la conexión.
- **Partida en curso**: nunca (ver la primera sección).

La alarma del Durable Object está multiplexada: sirve para este barrido *y* para
vencer la sala a las 24 h sin uso. `nextAlarmAt()` devuelve el más cercano de los
dos. Si la sala queda sin nadie se borra al instante.

## Costo

Cada mensaje que entra por websocket cuenta como request del Durable Object. El
keep-alive del cliente está en **50 segundos** por eso: suficiente para que no se
corten las conexiones, sin gastar de más. Con eso cada persona genera unos 100
mensajes por hora de juego.

Los archivos estáticos no invocan el Worker, así que las visitas a la página son
gratis. Las salas inactivas hibernan y no cuestan nada.

## Trampas que ya nos comimos

- **`new_sqlite_classes` en la migración** (y no `new_classes`) es lo que permite
  usar Durable Objects en el plan gratis.
- **`run_worker_first: ["/api/*"]`**: sin eso, el fallback de página única se come
  las rutas de la API y el Worker no corre nunca.
- **Un subdominio `workers.dev` nuevo no se crea con el deploy**: hay que abrir la
  sección Workers del panel una vez. El primer deploy falla con el código 10063
  hasta que exista.
- **El certificado TLS del subdominio nuevo tarda**. Mientras tanto el sitio da
  `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` aunque el Worker ya esté sirviendo por HTTP.
  No es un error del deploy: es esperar.
- **PowerShell 5.1 no negocia TLS 1.2 por defecto**, así que `Invoke-WebRequest` y
  `curl.exe` fallan contra Cloudflare. Para probar, usar `node -e "fetch(...)"`.
- **Node 20 necesita `--experimental-websocket`** para tener `WebSocket` global.

## Por qué GitHub Actions y no Workers Builds

Cloudflare puede desplegar solo al conectar el repo desde su panel (Workers
Builds), y tiene una ventaja concreta: no hace falta ningún token. Se descartó
igual, por dos motivos.

El primero: **el "build" de este proyecto no valida casi nada.** No hay paso de
compilación; `wrangler deploy` solo empaqueta los tres archivos de `src/`.
`public/` se sube tal cual, sin que nadie lo parsee. Un error de sintaxis en
`public/app.js` —donde vive casi toda la interfaz— pasa cualquier "build check" y
llega roto a producción. Frenar ante un build fallido suena a red de seguridad y
acá es casi decorativo.

El segundo: lo que sí protege es correr una partida de prueba de verdad antes de
publicar, y eso conviene tenerlo **versionado en el repo** y no en la
configuración de un panel, que no viaja con el código ni se ve en un diff.

El precio es un token de API guardado como secreto del repo. Vale la pena.

## Cómo se prueba

No hay framework de tests. Lo que funcionó todo el desarrollo: un script de Node
que abre varios websockets con identidades distintas y juega una partida entera,
apuntando a local o a producción. Ver `CLAUDE.md` para la plantilla.

Es la única forma seria de probar esto, porque los bugs interesantes son de
coordinación entre jugadores, no de una función suelta. Dos pestañas normales del
navegador **no** sirven: comparten `localStorage` y son el mismo jugador.

Un aviso por experiencia: si el script dispara rondas más rápido de lo que se
resuelven, los intentos nuevos pisan los pendientes y parece un bug que no existe.
Dejale aire entre jugadas.

## Ideas que quedaron afuera

- Arrastrar para reordenar el círculo: en el celular se pelea con el scroll. Las
  flechas ▲▼ llegan al mismo lugar y funcionan en todos lados.
- Un ayudante que cuente los números todavía posibles (son 3024 permutaciones,
  se calcula en el cliente sin esfuerzo). Se descartó por ahora: le sacaría la
  gracia al juego. Si se agrega, que sea opcional y apagado por defecto.
- Más de 8 jugadores por sala: el círculo funciona igual, pero el historial se
  vuelve ilegible. El tope está en `MAX_PLAYERS`.
