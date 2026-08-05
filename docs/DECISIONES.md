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

### Qué es cada columna

Analytics Engine no guarda nombres: las columnas son posiciones, y una consulta
contra `double3` no dice nada por sí sola. El mapa vive acá porque no está en
ningún otro lado, y una fila es **un jugador de una partida**, no una partida.

| Columna | Qué es |
| --- | --- |
| `index1` | `humano`, o el nivel de la máquina |
| `blob1` | el modo: `strict` o `sim` |
| `blob2` | lo mismo que `index1` |
| `blob3` | el día del desafío; vacío en las partidas |
| `double1` | intentos que tiró |
| `double2` | si ganó: 1 o 0 |
| `double3` | en qué ronda ganó, 0 si no ganó |
| `double4` | cuántos jugaron |
| `double5` | cuántas rondas duró |
| `double6` | si hubo descuento: 1 o 0 |

`blob2` repite `index1` a propósito y no hace falta para consultar —se pregunta
por `index1`—, pero mover las posiciones ahora partiría el histórico en dos
esquemas, y eso cuesta más que un slot de los veinte que hay.

**Si agregás un campo, va al final.** Reordenar es lo único que no se puede: las
filas viejas no se reescriben y quedarían diciendo otra cosa.

`blob3` existe porque el `timestamp` de la fila dice cuándo se escribió, no de
qué día era el desafío, y **con las tres horas de gracia no son lo mismo**: uno
del 5 se puede terminar a las 00:30 del 6. Agrupar por `timestamp` movería esas
partidas de día. Para contar desafíos por día se agrupa por `blob3`.

Una consulta que anda, para arrancar:

```sql
SELECT timestamp, index1 AS quien, double1 AS intentos, double2 AS gano
FROM numerordle_partidas
ORDER BY timestamp DESC
```

**`timestamp` tiene que estar en el `SELECT` para poder ordenar por él.** El
`ORDER BY` se resuelve contra las columnas proyectadas, no contra el esquema, y
si no está contesta `unable to find type of column: "timestamp"` — que suena a
que la columna no existe, y no es eso.

## La trampa al leer los intentos

En una partida por turnos los dos juegan todas las rondas, y la partida corta en
el instante en que alguien acierta. Así que `n` termina siendo, para todos, más
o menos el número de rondas: sobre las 23 partidas que había registradas al 5 de
agosto de 2026, en **19 los dos jugadores tenían exactamente el mismo `n`** y en
3 más se llevaban uno.

O sea que **el número del que perdió no dice cuánto habría tardado**: dice solo
que necesitaba más que eso. Está censurado. La única medición limpia es la del
que ganó, y por eso `gano` no es un adorno del registro sino lo que decide si la
fila sirve.

De ahí sale que **el número de alguien solo se observa cuando esa persona gana**,
con lo cual la muestra se corre sola hacia los rápidos.

Pero hay una salida, y ya está en el juego: **el que pierde puede seguir jugando
hasta encontrarlo**. Si elige eso, la partida sigue en descuento y su número
queda registrado entero. Se ve en los datos: las 3 partidas con
`descuento: true` son exactamente las 3 que terminaron con dos `gano: true`. Las
otras 20 tienen un solo ganador y una fila censurada.

Así que la regla para juntar datos es corta:

- **Si perdés, seguí jugando.** Ahí tu número llega entero, sea cual sea el
  nivel del rival. Es lo único que hace falta pedirle a quien juegue.
- Si no, que sea contra `facil`: necesita 15,9 intentos de media, así que la
  persona gana casi siempre y el truncamiento casi no aparece. Contra `dificil`,
  que necesita 8, se pierde alrededor de la mitad.

De yapa, el descuento **deja esas partidas etiquetadas sin necesidad de
`quien`**: la máquina nunca elige seguir —se planta apenas pierde, ver
`unaJugadaDeBot`—, así que en un uno contra uno con descuento el que ganó
segundo es siempre la persona.

Lo que había registrado hasta esa fecha es el peor caso posible para esto: un
solo jugador, rápido —mediana de 6, cuando la referencia de alguien que juega
bien es de 6 a 10— y casi siempre contra `dificil`. Sirvió para descubrir la
censura, no para calibrar nada.

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

## El desafío del día

El diseño se decidió y se escribió acá **antes** de tocar código, porque son
varias decisiones cuyo porqué no se iba a poder deducir del resultado.

**La clave `RETO_CLAVE` es un secreto del Worker y hay que cargarla a mano.**
Si falta, el desafío contesta 503 y el resto del juego sigue andando. Para
probar en local y en CI se pasa como `--var` con un valor cualquiera: derivar
el número de una clave de juguete está bien mientras la de producción sea otra.

Un jugador solo contra el número del día, con un tope de **12 intentos**. No hay
círculo ni rival.

### Por qué una clase de Durable Object aparte

El invariante que sostiene el juego es que **el orden de `players` es el
círculo**. Un jugador solo no tiene círculo, así que meter un modo sin rival
adentro de `GameRoom` dejaría ese invariante hablando de un caso que ya no
cubre, que es exactamente como se erosionan hasta dejar de proteger.

La clase nueva necesita tres cosas: el número, los intentos que van y el tope.
`scoreGuess` e `isValidSecret` ya son puras y se reusan tal cual.

Es **un objeto por jugador y por día**, reutilizado durante sus doce intentos y
no uno por intento. Cada sala de juego que existe hoy es un objeto más grande y
más longevo que este, así que no es de donde va a venir el costo.

### El número se deriva, no se guarda

`HMAC(clave_del_worker, fecha)` → índice entre las 3024 permutaciones de cuatro
dígitos distintos del 1 al 9. Con seis bytes del MAC el sesgo del módulo es
despreciable.

Derivarlo en vez de guardarlo **elimina la coordinación**: cualquier instancia
valida un intento sin consultarle a nadie, y no hay ningún lugar donde el número
esté escrito. La alternativa —un objeto por día que lo genera y lo guarda—
obliga a que todos lo consulten, y eso es un punto caliente y único para algo
que no lo necesita.

**Tiene que ser un hash con clave.** Con `SHA-256(fecha)` a secas cualquiera con
la fecha calcula el número del día en su casa: sería público aunque nunca
viajara al cliente. La clave es lo único que hace que de la secuencia observada
no se deduzca la que sigue.

El día es **UTC−3**, y no UTC como el resto del proyecto. Con UTC el número
cambiaría a las nueve de la noche de acá, en plena hora de jugar.

### El tope es 12, y tiene un costo cruzado

Cuanto más bajo, mejor el juego —el tope se siente, perder es posible— y peor el
dato, porque censura a los jugadores normales, que son justo los que hay que
medir. 10 hace mejor juego; 15 hace mejor dato y le saca la tensión.

12 deja terminar casi siempre a alguien que juega bien (de 6 a 10 intentos) y
coincide con la media del bot `normal`, que es una referencia razonable de qué
es un tope justo.

### HTTP y no websocket

Un jugador solo no tiene nada que le empujen. `GET /api/reto` para el estado y
`POST /api/reto` para el intento sale más barato —sin socket abierto ni
hibernación—, se prueba sin abrir websockets y no arrastra la reconexión.

Lo que cuesta es un camino de render nuevo en el cliente, porque hoy todo se
dibuja desde los mensajes `state`. Se paga una vez para no pagar el del socket
todos los días.

Lo que **no** cambia es que el número no sale del servidor: la respuesta a un
intento lleva fijos y picas y nada más, igual que en el juego normal.

### El que quedó jugando cuando cambió el día

El Worker enruta siempre a la fecha de hoy, así que apenas cambia el día el
desafío de ayer **deja de tener puerta**: al que estaba jugando se le vaciaba el
tablero y le aparecía otro número, sin aviso. No lo causaba el barrido —lo causa
el enrutado—, y por eso no se arreglaba dejando la sala viva más tiempo.

Ahora el cliente manda la fecha del desafío que está jugando, y se acepta **solo
para continuar uno ya empezado, nunca para empezar**. Ahí está toda la
seguridad del asunto: si se pudiera empezar el de ayer, pedir esa fecha sería
pedir un número que ya se sabe. Como la sala solo existe si esa persona ya había
arrancado, alcanza con exigir que haya algo empezado y sin terminar.

Dura **tres horas** pasada la medianoche, y solo mientras la pantalla siga
abierta: el cliente no guarda nada, así que al salir o recargar te toca el de
hoy. Es a propósito —el desafío del día es de un día— y las tres horas son para
que el que arrancó 23:50 pueda terminar, no para estirar el juego.

Pasado eso el servidor contesta que venció, y el cliente trae el de hoy
**diciéndolo**: cambiarle el tablero en silencio se lee como que perdió todo.

### Los reintentos no se pueden evitar, y no se intenta

Borrando el almacenamiento del navegador se juega de nuevo el mismo día. **No
hay identidad de dispositivo confiable sin cuentas**: localStorage y cookies se
borran, una IP no es una persona (ver "El límite de ritmo") y el fingerprinting
choca de frente con no guardar nada que identifique a nadie.

El caso real igual queda cubierto: el reto usa el mismo `pid` que el juego, así
que recargar, cerrar o abrir otra pestaña devuelven al mismo reto. Reintentar
exige borrar el almacenamiento a propósito —perdiendo de paso la identidad del
juego— o ir a incógnito. Sin premio, el incentivo es poco.

Lo que sí importa es que **un reintento se juega sabiendo el número**, así que
da un conteo bajo que ensucia la calibración y es indistinguible de una primera
vez. No se corrige: se separa. El reto se registra con `blob1 = 'reto'`, y eso
permite correr la calibración con él y sin él.

Las dos fuentes fallan distinto, que es lo que las hace útiles juntas:

| | uno contra uno | reto del día |
| --- | --- | --- |
| Censura | arbitraria: corta cuando gana el otro | conocida: siempre en 12 |
| Reintentos | no aplica | posibles, indetectables |

Si las dos distribuciones coinciden, ninguno de los dos problemas es material.
Si difieren, el desacuerdo mismo dice dónde mirar. Es mejor que ponderar a ojo.

### Cómo entra en el dataset

Sin tocar el esquema de "Qué es cada columna":

| Columna | Valor en un reto |
| --- | --- |
| `index1`, `blob2` | `humano` |
| `blob1` | `reto` |
| `double1` | intentos que tiró |
| `double2` | si lo encontró: 1 o 0 |
| `double3` | los intentos si lo encontró, 0 si no |
| `double4` | 1 |
| `double5` | los intentos |
| `double6` | 0 |

Y trae algo que el uno contra uno no puede dar: **la censura pasa a ser
conocida**. Un `double2 = 0` quiere decir "necesitaba más de 12", siempre el
mismo número, y eso es algo con lo que se puede trabajar. En el uno contra uno
la partida corta en un punto que depende del rival.

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
