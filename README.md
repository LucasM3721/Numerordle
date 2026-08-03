# Fijos y Picas

El juego de lápiz y papel: cada uno anota un número de 4 dígitos (del 1 al 9, sin
repetir) y hay que adivinarle el número al de al lado. Te responden cuántos
**fijos** (dígito correcto en la posición correcta) y cuántas **picas** (dígito
correcto en otro lugar), nunca cuáles.

Corre entero en Cloudflare Workers: cada sala es un Durable Object con su propio
estado y sus websockets. Sin base de datos, sin build, sin dependencias en el front.

## Probarlo local

```bash
npm install
npm run dev
```

Abre en `http://localhost:8787`. Para jugar de a varios en la misma máquina usá
ventanas de incógnito distintas: la identidad del jugador vive en `localStorage`,
así que dos pestañas normales son el *mismo* jugador.

## Verificar los cambios

```bash
npm run check   # sintaxis de src/ y public/
npm test        # juega dos partidas de prueba (necesita npm run dev en otra terminal)
```

`npm test` verifica los invariantes del juego, no solo que el código compile: el
círculo de objetivos, que los secretos no salgan del servidor, que los intentos
pendientes no se filtren y que fijos y picas den los números exactos.

## Subirlo

Está publicado en **https://numerordle.lucasm3721.workers.dev** — ese es el link
que pasás; el de una sala concreta es `.../r/ABC12`.

**Cada push a `main` despliega solo**, siempre que pasen las verificaciones
(`.github/workflows/deploy.yml`). Para trabajar sin publicar, usá una rama y abrí
un pull request: ahí corren los chequeos sin tocar producción.

A mano, desde cualquier máquina:

```bash
npx wrangler login
npm run deploy
```

El plan gratis alcanza: los Durable Objects con SQLite entran ahí, por eso la
migración usa `new_sqlite_classes`.

Para ver errores en vivo: `npm run tail`. Para volver atrás: `npx wrangler rollback`.

### Configurar el deploy automático (una sola vez)

1. En Cloudflare: **My Profile → API Tokens → Create Token**, plantilla
   **"Edit Cloudflare Workers"**. Copiá el token, se muestra una única vez.
2. En GitHub: **Settings → Secrets and variables → Actions → New repository
   secret**, con nombre `CLOUDFLARE_API_TOKEN`.

El token no va nunca al repo ni se le pasa a nadie. Si se pierde o se filtra, se
revoca desde el mismo panel de Cloudflare y se crea otro.

Si el deploy se queja de no poder resolver la cuenta, agregá un segundo secreto
`CLOUDFLARE_ACCOUNT_ID` (lo ves con `npx wrangler whoami`).

### Avisos cuando se frena la creación de salas (opcional)

Cuando alguien pide más de 10 salas por minuto, el Worker corta y puede avisarte
por Discord. En el canal que quieras: **Editar canal → Integraciones → Webhooks
→ Nuevo webhook**, copiás la URL y:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
```

Sin ese secreto el límite funciona igual, nada más que en silencio. El aviso
sale como mucho una vez por minuto —si no, el propio aviso amplificaría el
problema— y no incluye la IP de nadie.

### Aviso de cupo diario (opcional)

El plan gratis da **100.000 requests por día** al Worker. Los archivos estáticos
no cuentan, así que solo suma `/api/*`. Pasado el cupo, Cloudflare contesta el
error **1027** hasta la medianoche UTC: la página sigue cargando, pero no se
puede jugar. **No genera cobro**, corta y ya.

Dos veces por día (12:00 y 22:00 UTC) el Worker puede mirar cuánto va consumido
y avisarte por el mismo webhook si pasó la mitad. Necesita dos secretos más:

```bash
npx wrangler secret put CF_ACCOUNT_ID
```

```bash
npx wrangler secret put CF_ANALYTICS_TOKEN
```

El id de la cuenta lo ves con `npx wrangler whoami`. El token se crea en
**My Profile → API Tokens → Create Token → Create Custom Token**, con un único
permiso: **Account → Account Analytics → Read**. No hace falta nada más; si le
das de más, le estás dando de más a algo que solo lee un número.

Si falta cualquiera de los dos, el chequeo no corre y no molesta. Si están pero
la consulta falla —token vencido, cambio en la API— te avisa por Discord, que
es mejor que quedarse mudo para siempre.

> Al crear un subdominio `workers.dev` por primera vez, Cloudflare tarda en emitir
> el certificado TLS. Mientras tanto el sitio da `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`
> aunque el Worker ya esté sirviendo. Es esperar, no hay nada que configurar.

## Documentación

- [CLAUDE.md](CLAUDE.md) — comandos, estructura, cómo probar, invariantes.
- [docs/DECISIONES.md](docs/DECISIONES.md) — el porqué de cada decisión de diseño
  y las trampas operativas que ya nos comimos.

## Cómo está armado

| Archivo | Qué hace |
| --- | --- |
| `src/index.js` | Worker de entrada: crea salas y enruta el websocket al Durable Object. |
| `src/room.js` | El Durable Object: máquina de estados de la sala, turnos, rondas. |
| `src/game.js` | Reglas puras: validar un número, contar fijos y picas. |
| `public/` | El front: un HTML, un CSS, un JS. Sin framework. |

### Decisiones que importan

- **Los secretos nunca salen del servidor.** Cada websocket recibe una vista
  personalizada: ves tu número y los que ya se revelaron, nada más. Abrir las
  herramientas de desarrollo no te sirve de nada.
- **El servidor calcula fijos y picas.** Nadie cuenta mal ni filtra información
  sin querer.
- **En modo simultáneo los intentos se guardan sin publicarse** hasta que juegan
  todos, así nadie copia la jugada del otro.
- **La ronda se juega entera aunque alguien ya haya ganado**, como en la mesa:
  puede haber empate en la misma vuelta.
- **Nada se encola si se corta la conexión.** Reenviar un intento viejo podría
  caer en otra ronda, así que el cliente avisa y te pide repetirlo.
- **Las anotaciones son un cuaderno privado.** Viven en `localStorage` (por sala
  y por partida), no viajan al servidor y nadie las valida: podés marcar
  cualquier cosa, aunque esté mal. Se limpian solas en la revancha.

## El cuaderno del jugador

Durante la partida ves **tu propio número** y, debajo, los intentos que te viene
tirando el que te tiene que adivinar, para seguir cuánto le falta.

El casillero donde escribís es **la fila siguiente del tablero**, no un cuadro
aparte: comparás con el intento inmediato de arriba y ya estás viendo dónde va a
caer el resultado.

En **tus intentos**, cada dígito se toca para ir marcándolo. Cicla entre cuatro
estados y se guarda solo:

| Estado | Se ve | Quiere decir |
| --- | --- | --- |
| sin marcar | como está | todavía no sé |
| rojo, tachado | ~~4~~ | ese dígito no está en el número |
| amarillo, subrayado | 4 | es pica: está, pero en otro lugar |
| verde, en círculo | (4) | es fijo: va justo ahí |

Al terminar la partida el tablero sigue ahí con las marcas puestas, ahora al lado
del número verdadero: se ve enseguida en qué te habías equivocado.

### Los dos modos

- **Ronda simultánea** — cada uno manda su intento cuando puede y se revela todo
  junto. Sirve en vivo y también para jugar a lo largo del día.
- **Por turnos** — uno a la vez, en orden, con el resultado a la vista al toque.
  Fiel al original, pero necesita que estén todos conectados.

Si alguien desaparece a mitad de ronda, el anfitrión tiene un botón para saltear
ese turno (o cerrar la ronda sin los que faltan) y que la partida siga.

## El anfitrión

Es el que creó la sala. Si se le cae la conexión, el rol pasa solo al primer
jugador conectado, así la partida nunca queda sin quién la maneje. También lo
puede ceder a mano con 👑 (a alguien conectado, en cualquier momento).

En la sala de espera arma el círculo: **▲▼** mueve a cada uno un lugar y
**Mezclar orden** lo sortea. El orden define a quién le adivina cada uno, así que
se congela al empezar el reparto de números.

## Quién entra y quién se va

El orden del círculo define a quién le adivina cada uno, así que sacar a alguien
en plena partida cambiaría los objetivos y ensuciaría el historial. Por eso hay
dos comportamientos distintos:

| Momento | Salir / que te echen | Cerrar la página y no volver |
| --- | --- | --- |
| Sala de espera | desaparecés de la lista | te barre solo a los 90 s |
| Eligiendo número | desaparecés de la lista | te barre a los 90 s **solo si todavía no elegiste** |
| Partida en curso | quedás retirado, tu número sigue en el círculo | seguís en la partida, marcado sin conexión |
| Terminada | desaparecés de la lista | — |

Los 90 segundos son para que recargar la página, cambiar de wifi o que se te
bloquee el teléfono no te saquen de la sala. Si ya elegiste número, no te barre
nunca: te comprometiste con la partida. Si la sala queda sin nadie, se borra al
instante en vez de esperar las 24 h.

Cuando el anfitrión retira a alguien en plena partida, ese jugador deja de jugar
pero su número sigue siendo el objetivo de quien lo tenía: la ronda se recalcula
sola y no queda esperándolo.

## Detalles operativos

- Hasta 12 jugadores por sala. El que la crea elige el cupo (de 2 a 12) y lo
  puede cambiar en la sala de espera, pero nunca por debajo de los que ya
  entraron.
- Se puede entrar mientras el resto elige su número; la sala se cierra a los de
  afuera recién cuando arranca la primera ronda.
- Recargar la página o cambiar de dispositivo no te saca: la identidad va en
  `localStorage` y el estado vive en el servidor.
- Las salas se borran solas a las 24 h sin actividad (una alarma del Durable
  Object), así no se acumula basura.
