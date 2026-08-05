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

- **Sala de espera**: te va de la lista.
- **Eligiendo número**: te va solo si todavía no elegiste. El que ya se comprometió
  se queda aunque pierda la conexión.
- **Partida en curso**: no te saca nunca (ver la primera sección), pero **tu turno
  se pasa solo**.

Esa última parte es la que hace que una desconexión no arruine la partida del
resto. Sacarte del círculo le cambiaría el objetivo a otro, así que no se hace;
lo que se hace es dejar tu lugar y seguir. En modo por turnos se saltea tu turno
y en simultáneo se cierra la ronda, y en los dos casos queda anotado como "pasó"
en el historial. Si volvés, seguís en la partida con tu número intacto.

**El anfitrión conserva sus botones** para no esperar los 90 segundos; esto es la
red para cuando no está mirando, o para cuando el que se cayó es él mismo (ahí el
rol pasa solo al primer jugador conectado, y la máquina nunca hereda la sala).

En simultáneo se fuerza **solo si todos los que faltan están ausentes**: con uno
presente la ronda todavía tiene a quién esperar de verdad.

La alarma del Durable Object está multiplexada: barrer ausentes, destrabar la
ronda y vencer la sala a las 24 h. `nextAlarmAt()` devuelve la más cercana de las
tres. Hace falta la alarma y no alcanza con revisar en cada mensaje: si nadie más
está jugando, no hay ningún mensaje que dispare la revisión. Si la sala queda sin
nadie se borra al instante.

Los 90 segundos se pueden bajar con la variable `DESTRABE_MS` **solo para las
pruebas** — esperar minuto y medio por caso en CI no es viable, y un caso que no
se corre no protege de nada. Producción usa el valor real.

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

## Lo único que se registra

Al terminar una partida se escribe **una fila por jugador** con la forma de esa
partida: modo, cuántos jugaron, cuántas rondas duró, si hubo descuento, y para
cada uno cuántos intentos tiró, si ganó y en qué ronda. Y **qué era**: una
persona o una máquina, y de qué nivel. Nada más.

**No va nada que identifique a nadie**: ni nombres, ni números secretos, ni
ids, ni el código de la sala, ni de dónde se conectó cada uno. `quien` dice
`humano` o el nivel de la máquina, que no distingue a una persona de otra. Si
algún día hace falta agregar un campo, que pase por `filasDePartida()` y por
esta sección; la suite verifica que no salga ninguno más.

Existe por una razón concreta: los tres niveles del rival de la máquina están
calibrados contra una hipótesis de cómo juega la gente, no contra una medición.
Con unas cuantas partidas registradas se puede comparar la distribución real
con la del bot y correr los objetivos a donde estén de verdad.

**Ese `quien` es lo que hace posible la comparación, y faltaba.** Las partidas
que se venían juntando no lo tenían, así que una partida de dos no decía si
había sido contra alguien o contra la máquina —ni de qué nivel—, y las dos
filas de intentos quedaban sin dueño. Servían para ver cuánto duraban las
partidas y qué modos se usan; para calibrar, no. Lo que se registró antes de
esto no se puede usar.

Se guarda por dos vías, con propósitos distintos:

- **`console.log`**, para mirar en vivo con `npm run tail` mientras se juega.
  No sirve para calibrar: en el plan gratis los logs duran **tres días**, así
  que son una ventana móvil y no un histórico.
- **Analytics Engine** (`PARTIDAS`, dataset `numerordle_partidas`), que los
  guarda **noventa días** y se consulta por SQL. De acá sale el dato con el que
  se comparan los niveles del bot. Escribir ahí no puede voltear una partida:
  si falla, se pierde el dato y se sigue jugando.

## Escribir antes de que te toque

En modo por turnos el pad está habilitado aunque no sea tu turno: pensar el
número es la mitad del juego y no tiene por qué empezar recién cuando te toca.
Lo que se bloquea es **mandarlo**, no tipearlo.

Dos detalles sin los cuales no sirve:

- **El pad se limpia cuando jugaste vos, no cuando cambia la ronda.** Atado a la
  ronda te borraba lo que venías escribiendo justo antes de poder mandarlo.
- **El estado que llega no pisa lo que estás tipeando.** El intento pendiente
  solo se vuelca al pad si está vacío; si no, cada actualización del servidor te
  reescribía el casillero encima de los dedos.

Enter avisa "todavía no es tu turno" del lado del cliente. Dejarlo llegar al
servidor también funcionaría, pero contesta con un error rojo, y esto no es un
error: es alguien apurado.

## La pausa de la máquina

El servidor resuelve la jugada del bot en el mismo instante que la tuya, así que
las dos llegan en el mismo estado y aparecían en el mismo parpadeo. Funcionaba,
pero se sentía un `console.log` y no un rival.

El cliente retiene **solo lo suyo** un segundo (`DEMORA_BOT_MS` en `app.js`) y
mientras tanto le pone "pensando…" en la mesa. Tu resultado se ve al instante.

El número salió de jugar: 700 ms se sentía apurado todavía. Es puro gusto y se
cambia en una línea, así que si en algún momento molesta, movelo.

Tres decisiones que importan más que el número:

- **Es maquillaje del cliente, no del servidor.** Hacer esperar al bot del lado
  del Durable Object costaría tiempo facturable y, en una sala con gente, haría
  esperar a todos. Acá el resultado ya está decidido y esto no lo puede alterar:
  si el temporizador falla, lo peor que pasa es que la jugada aparezca antes.
- **No se dosifica la jugada con la que gana.** Cuando la ronda cierra la fase,
  la pantalla cambia sola y retener el intento ganador mientras ya se ve el
  cartel de "alguien lo sacó" sería peor que mostrarlo.
- **Se retiene por entrada del historial, no por estado entero.** Si se
  retuviera el estado completo también se demoraría *tu* resultado, que es lo
  contrario de lo que se busca.

## El uno contra uno no tiene sala de espera

La sala que nace con máquina nace en el reparto: `create` la mete en el círculo
y deja `phase` en `'secret'`. No es un atajo del cliente, es la sala la que
arranca ahí.

La espera existe para tres cosas —ver quién va llegando, acomodar el orden y
decidir cuándo se empieza— y **ninguna aplica a un uno contra uno**: no hay a
quién esperar, con dos jugadores el círculo es mutuo y el único que decide ya
apretó el botón. Lo que quedaba era una pantalla con un botón "Empezar" entre
el que quiere jugar y el juego.

Lo que no cambia:

- **El mínimo de dos lo sigue haciendo cumplir `everyoneReady`**, que es quien
  arranca la partida, y no el botón que desapareció. Una sala en `'secret'` con
  un solo jugador no puede empezar aunque él elija su número.
- **`join` ya aceptaba gente en `'secret'`**, así que el que la creó entra
  derecho a elegir. No hizo falta tocar la puerta.
- **El anfitrión sigue siendo una persona**: el bot está en la sala antes que
  nadie, pero `nuevoAnfitrion` solo mira humanos.
- **La máquina elige su número al crearse la sala**, no cuando vos mandás el
  tuyo. Así la lista ya la muestra lista y se ve que lo único que falta sos vos.

El precio es que desde el uno contra uno ya no se puede cambiar de modo, subir
el cupo ni invitar a nadie, porque todo eso era de la espera. Está bien: para
eso está el camino de crear una sala normal y sumarle gente o máquinas, que
hace lo mismo y se explica solo.

## De dónde salieron los colores y las formas

La primera versión se notaba armada sin decidir: fondo azul-pizarra (`#0f1117` y
familia, el gris por defecto de medio internet), un solo acento, esquinas de
14 px en todo y una columna de tarjetas iguales.

Se rehizo contra dos referencias que dio Lucas —potrerofutbol.ar/el-idolo y
copero.com.ar/juegos/simulador-carrera— y no de ojo: se les midieron los tokens.
Las dos usan negro **neutro** (`#040505` y `#09090b`), bordes de un pelo al 6-8 %,
píldoras para los estados y una fuente cargada. Ninguna de las dos tiene el
resplandor radial de fondo; Potrero incluso dejó escrito
`--page-bg-gradient: var(--page-bg-solid)` para colapsarlo a propósito.

De ahí salieron los grises neutros, los bordes al 7 %, la escala de radios (8 la
tarjeta, 6 lo de adentro, píldora los estados) y, después, el tono: Lucas eligió
entre tres versiones la de **base callada con una sola display, y solo en el
título de la portada**. Los números van con una grotesca condensada.

Vale la pena repetir el método antes que el resultado: **medirle los tokens a una
referencia** dice más que mirarla, y explica por qué cada número es el que es.

## La única fuente que se carga

El repo tiene un solo binario: `public/fuentes/anton-latin.woff2`, 18 KB, y va
únicamente en el `h1` de la portada.

Entró porque la pila del sistema tapaba el agujero justo donde no importaba.
Esto es dónde caía cada una antes:

| | Título (Impact →) | Números (Bahnschrift →) |
| --- | --- | --- |
| Windows | Impact ✓ | Bahnschrift ✓ |
| macOS | Impact ✓ | DIN Alternate ✓ |
| iPhone | ✗ la del sistema en negrita | DIN Alternate ✓ |
| Android | ✗ la del sistema en negrita | ✗ monoespaciada |

O sea que la display existía solo en escritorio, y un juego que se pasa por link
se juega en el teléfono. Los números, en cambio, estaban cubiertos en tres de
cuatro y en el que faltaba caían en monoespaciada, que se ve más pobre pero
**sigue alineada**, que es lo único que no se puede perder. Por eso se carga una
sola fuente y no dos: a la de los números le alcanzó con sumarle
`"Roboto Condensed"` a la pila, que en Android ya está instalada y no cuesta un
byte.

Cuatro decisiones chicas que no son obvias:

- **Es el archivo `latin` de Google Fonts tal cual.** Recortarlo a las letras de
  "FIJOS Y PICAS" lo bajaría a unos 3 KB, pero necesita herramientas que este
  repo no tiene y el día que el título cambie una letra se rompe en silencio,
  mezclando glifos de dos fuentes. Por 15 KB no vale.
- **El `@font-face` declara `font-weight: 400 700`** aunque Anton tenga un solo
  grosor. El `h1` pide 700 —lo pide para cuando la fuente todavía no está—, y
  sin el rango el navegador la engorda a la fuerza. `font-synthesis-weight`
  hace lo mismo pero no existe en Safari anterior al 16.4, que es justo uno de
  los lados que se venía a arreglar.
- **Se precarga desde el HTML, con `crossorigin`.** Sin el atributo se baja dos
  veces, porque las fuentes se piden en modo CORS aunque sean del mismo origen.
- **No se le puso `Cache-Control: immutable`**, que sería lo natural para un
  archivo que no cambia: el nombre no lleva hash, así que un día de estos
  cambiar la fuente dejaría a medio mundo con la vieja durante un año. Si
  alguna vez se quiere, primero el nombre y después la cabecera.

La CSP no hubo que tocarla: no hay `font-src`, así que cae en `default-src
'self'` y una fuente servida desde `public/` ya estaba permitida.

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

**Un cron no se puede disparar a mano**, y probarlo bajándole el intervalo a un
minuto tarda en propagar y no se controla. Lo que funcionó fue sacar la lógica a
una función y llamarla desde una ruta temporal e impredecible en `fetch`, una
vez, y borrar la ruta en el mismo rato. Si hay que volver a tocar el aviso de
cupo, ese es el camino.

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
- Las reglas de WAF que circulan para sacarse el tráfico sucio de encima
  (bloquear países enteros, ~250 ASN de hosting, patrones de inyección SQL).
  Acá no se pueden ni poner: las reglas del WAF son de zona y `workers.dev` no
  es una zona propia, el mismo motivo por el que quedó afuera la regla de Rate
  Limiting. Y aunque hubiera dominio propio seguirían sin pegarle a nada
  nuestro: no hay una sola consulta SQL en el proyecto, y lo que un escaneo
  golpea son rutas que sirve la capa de assets sin ejecutar el Worker
  (`run_worker_first` es solo `/api/*`). Contra eso las listas bloquean gente
  de verdad: la que circulaba traía AS3356 y AS174, que son tránsito, y AS786,
  que es la red académica del Reino Unido. Lo que protege el cupo es lo que ya
  está puesto: los límites por IP de `wrangler.jsonc`.
