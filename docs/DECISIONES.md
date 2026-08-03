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

## Identidad: el pid no es el id

Cada jugador tiene **dos** identificadores y no hay que confundirlos:

- El **pid** es la credencial. Lo genera el cliente, vive en su `localStorage` y
  viaja en la query del websocket. Quien lo tenga **es** ese jugador.
- El **id público** (`pub`) lo asigna el servidor al entrar. Es lo único que ven
  los demás: va en la lista de jugadores, en el historial, en `revealed` y en
  todo lo que sale por `viewFor`.

Al principio eran el mismo valor, y eso era un agujero grande: `viewFor` mandaba
el pid de todos a todos, así que cualquiera que hubiera pasado por la sala podía
reconectarse con el pid ajeno y el servidor le contestaba con el número secreto
de esa persona. La consola del navegador alcanzaba.

Por eso `viewFor` es **la frontera**: de ahí para afuera no sale ni un solo
identificador que sirva para autenticarse. Los mensajes que nombran a otro
jugador (mover, coronar, echar) traen ids públicos y se resuelven con
`findByPub`. Si agregás un campo al estado que lleve un id, fijate de qué
espacio es.

El pid además se valida (`isValidPid`): tiene que parecer un identificador, y
**queda afuera todo lo que un objeto plano ya contesta por herencia** —
`toString`, `hasOwnProperty`, `__proto__`—, porque el pid se usa como clave en
`state.pending`. No alcanza con listarlos a mano: `toString` mide 8 caracteres
y pasa cualquier patrón razonable. Y el daño es concreto: `pending['toString']`
devuelve una función, o sea que ese jugador contaría como que ya jugó sin haber
mandado nada y la ronda se cerraría sola con un intento inexistente. La
condición es `!(pid in {})`, que los agarra a todos.

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

Con el link circulando en público eso deja de ser solo una cuenta y pasa a ser
una superficie: cada mensaje que alguien mande cuesta. Por eso hay un tope de
**60 mensajes cada 10 segundos por jugador**; pasado eso se descartan en
silencio (contestar sería justo el trabajo que se quiere evitar) y a los 300 se
corta la conexión, porque a esa altura no es una pestaña colgada. Una partida
entera son decenas de mensajes: nadie que juegue lo va a notar.

## El límite de ritmo

Crear una sala es la operación cara: cada una es un Durable Object. Va limitada
a **10 por minuto por IP**, y abrir una sala a 60, con la API de Rate Limiting
de Workers declarada en `wrangler.jsonc`.

Se descartó la regla de *Rate Limiting* del WAF, que hace lo mismo desde el
panel, por una razón de interfaz: el WAF devuelve una página de error de
Cloudflare, y desde el Worker se puede devolver un 429 con JSON que el cliente
convierte en un aviso que explica qué pasó **y que entrar con un código sigue
andando**. Un juego no debería parecer roto porque alguien lo estaba abusando.

Se cuenta por `CF-Connecting-IP`, que pone el borde y el cliente no puede
falsear. **No** por jugador: el `pid` lo elige el cliente y se cambia borrando
el `localStorage`, así que serviría para frenar un accidente pero no a alguien
que no quiere ser frenado. Sin esa cabecera no estamos detrás del borde —o sea,
`wrangler dev`— y se deja pasar.

Dos límites del enfoque, para no confundirse:

- **El conteo es por centro de datos, no global.** Alguien distribuido lo
  esquiva en parte. Para el nivel de amenaza de un juego con link público
  alcanza; no es una barrera absoluta.
- **Una IP no es una persona.** Detrás de un NAT pueden ser muchos. Por eso 10
  por minuto y no 2: un grupo grande armando varias salas seguidas tiene que
  poder.

El aviso a Discord pasa por su propio limitador de uno por minuto. Sin eso, el
aviso amplificaría el ataque en vez de contarlo. No lleva la IP: es dato
personal de un tercero y no cambia lo que hay que hacer al respecto.

## Qué pasa si se agota el cupo del día

El plan gratis da 100.000 requests diarios al Worker, y **no factura por
exceso**: corta. El riesgo es quedarse sin juego, no un cobro.

Corta menos de lo que parece. **Los requests a archivos estáticos son gratis e
ilimitados y no cuentan**, y como `run_worker_first` deja al Worker corriendo
solo en `/api/*`, el HTML, el CSS, el JS y el favicon los sirve el binding de
assets sin invocarlo. Entonces, pasado el cupo:

- La página sigue cargando normal.
- Solo la API devuelve el error **1027** de Cloudflare.
- Se repone a la medianoche UTC.

El cliente lo distingue de su propio 429 **mirando si el cuerpo trae el número
1027**, no por el código de estado: Cloudflare no documenta cuál usa, y el
cuerpo de la página de error sí lo trae siempre. Cuando pasa, el botón de crear
sala queda apagado con una cuenta regresiva y el cartel dice a qué hora vuelve
—calculada en la zona horaria de quien mira, porque la medianoche UTC cae a
distinta hora según dónde esté cada uno.

Un botón que sigue pareciendo el principal invita a insistir, y cada insistencia
es otro request. Por eso se apaga de verdad y no con opacidad.

Hay un Cron Trigger que dos veces por día mira el consumo con la API de
analytics y avisa por Discord si pasó la mitad. Es opcional: sin los secretos no
corre. Lo importante es que **no está en el camino de ningún jugador**, así que
si falla no lo nota nadie —y si falla, avisa, que es mejor que quedarse mudo.

## Otros topes

Tres más, todos por la misma razón:

- **Una sala vacía vence a los 10 minutos**, no a las 24 horas. El que crea una
  sala se conecta en el acto, así que `players: []` significa que nadie llegó a
  entrar. Sin esto, un `for` con `fetch` deja miles de Durable Objects ocupados
  un día entero, que es el ataque más barato contra este proyecto.
- **Cinco sockets por jugador.** Las pestañas múltiples son a propósito, pero
  sin tope cada cambio de estado se multiplica por la cantidad de sockets
  abiertos. Cinco deja aire para una reconexión con el socket viejo todavía sin
  cerrar. Se rechaza *antes* de aceptar el socket: abrir uno para avisar que no
  hay lugar sería gastar justo lo que se está cuidando.
- **Antes de cerrar por avalancha se manda un `kicked`.** No es cortesía. El
  cliente pone su contador de reintentos en cero al abrir, así que ante un
  cierre pelado —con el socket ya abierto— reconectaría cada segundo para
  siempre. El aviso lo manda a la pantalla de inicio; el cliente además ignora
  cualquier cierre con código 4xxx, que son los que pone el servidor a
  propósito.

El historial también está acotado, en **600 entradas**. El estado de la sala se
guarda entero en una sola clave y se reescribe en cada jugada, así que el log
es lo único que puede crecer sin freno. 600 son unas 50 rondas con la sala
llena. Su numerador (`logSeq`) es aparte del largo del array: si se recorta, los
números no se repiten, que es lo que rompería las anotaciones del cuaderno.

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
- **`wrangler dev` puede no arrancar en Windows** con *"There was an access
  violation in the runtime"*. No es el código ni la versión de wrangler: le
  falta la [VC++ Redistributable x64](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)
  a la máquina. Mientras tanto, la única forma de correr `npm test` es abrir un
  pull request y dejar que lo haga CI.

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

## El cupo de la sala

El tope duro es **12** (`MAX_PLAYERS`) y cada sala elige el suyo dentro de ese
techo: el que la crea lo fija y lo puede mover mientras estén en la espera.

Antes el tope era 8 y estaba fijo, con el argumento de que más arriba el
historial se vuelve ilegible. Eso sigue siendo cierto —12 jugadores son 12
intentos por ronda en el mismo feed—, pero es una molestia de lectura, no algo
que rompa el juego, y la alternativa era que un grupo de 10 no pudiera jugar.
Si alguna vez molesta de verdad, lo que hay que arreglar es el historial (por
ejemplo plegando las rondas viejas), no bajar el tope.

El cupo **no baja nunca por debajo de los que ya están adentro**: entraron de
buena fe y dejarlos afuera con un cambio de configuración sería peor que tener
uno de más. `clampMaxPlayers()` recibe ese piso y lo hace cumplir; el servidor
recorta siempre, así que un cliente modificado no puede abrir una sala de 50.

Se toca solo en la sala de espera, que es donde el anfitrión está mirando la
lista. Durante el reparto todavía puede entrar gente hasta llenar el cupo, pero
ahí ya están todos eligiendo su número y andar moviendo la configuración de la
sala en ese momento es ruido.

## Ideas que quedaron afuera

- Arrastrar para reordenar el círculo: en el celular se pelea con el scroll. Las
  flechas ▲▼ llegan al mismo lugar y funcionan en todos lados.
- Un ayudante que cuente los números todavía posibles (son 3024 permutaciones,
  se calcula en el cliente sin esfuerzo). Se descartó por ahora: le sacaría la
  gracia al juego. Si se agrega, que sea opcional y apagado por defecto.
