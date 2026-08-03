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

## Subirlo

Necesitás una cuenta de Cloudflare (el plan gratis alcanza: los Durable Objects
con SQLite entran ahí, por eso la migración usa `new_sqlite_classes`).

```bash
npx wrangler login
npm run deploy
```

Está publicado en **https://numerordle.lucasm3721.workers.dev** — ese es el link
que pasás; el de una sala concreta es `.../r/ABC12`.

> La primera vez, Cloudflare tarda un rato en emitir el certificado TLS del
> subdominio nuevo. Mientras tanto el sitio da `ERR_SSL_VERSION_OR_CIPHER_MISMATCH`
> aunque el Worker ya esté andando. Es esperar, no hay nada que configurar.

Para ver errores en vivo: `npm run tail`.

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

- Hasta 8 jugadores por sala.
- Se puede entrar hasta que empieza el reparto de secretos; después la sala se
  cierra a los de afuera.
- Recargar la página o cambiar de dispositivo no te saca: la identidad va en
  `localStorage` y el estado vive en el servidor.
- Las salas se borran solas a las 24 h sin actividad (una alarma del Durable
  Object), así no se acumula basura.
