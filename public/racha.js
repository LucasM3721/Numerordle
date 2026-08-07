/**
 * La racha del desafío: cuántos días seguidos jugaste y cómo te fue en cada uno.
 *
 * Compartir el resultado trae gente nueva; esto es la otra mitad, que es que
 * alguien vuelva mañana. El porqué está en "Lo que falta no es una función, es
 * gente" (docs/DECISIONES.md).
 *
 * Vive entera en el navegador: no viaja nada al servidor, no hay tabla de
 * posiciones y no hay que identificar a nadie. Lo único que el juego sabe de tu
 * racha es lo que se acuerde tu propia máquina.
 *
 * Es el segundo archivo del cliente y está aparte por una sola razón: acá no se
 * toca el DOM ni `localStorage`, así que la suite lo importa y lo prueba sin
 * navegador. Guardar y dibujar es cosa de `app.js`.
 */

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * El día corre en UTC−3, igual que en `src/reto.js`. Es otra regla escrita de
 * los dos lados —como `CODE_LEN` y `CODIGO_RE`— porque el cliente no importa
 * nada del servidor.
 *
 * Si algún día se corren, conviene saber qué se rompe y qué no: el que manda
 * sobre cuál es el desafío de hoy es siempre el servidor, que manda su `fecha`
 * en cada respuesta. Esta copia se usa solo para dibujar la racha en la
 * portada, antes de haberle preguntado nada a nadie.
 */
const DESFASE_MS = 3 * 60 * 60 * 1000;

/**
 * Cuántos días se guardan. No es por espacio —noventa días son un par de
 * kilobytes— sino porque `localStorage` es del navegador y no de una cuenta:
 * lo que no se va a mirar nunca más no tiene por qué quedar guardado.
 *
 * Es el mismo número que duran las partidas en Analytics Engine, y por la misma
 * razón: más atrás que eso ya no le importa a nadie.
 */
export const TOPE_DIAS = 90;

/** Cuántos días entran en la tira que se dibuja. Diez entran en un teléfono. */
export const DIAS_A_LA_VISTA = 10;

/** La fecha de hoy en UTC−3, con la forma `2026-08-07`. */
export function fechaDeHoy(ahora = Date.now()) {
  return new Date(ahora - DESFASE_MS).toISOString().slice(0, 10);
}

/**
 * El día anterior a `fecha`, con la misma forma.
 *
 * Las dos puntas hablan UTC: `Date.parse` de un `YYYY-MM-DD` lee UTC y
 * `toISOString` escribe UTC. Así los fines de mes y los bisiestos salen solos, y
 * se esquiva el único bug que tiene esto —parsear en UTC y formatear en local,
 * que de este lado del mundo corre la fecha un día para atrás—. Es el mismo
 * motivo por el que `textoParaCompartir` arma la fecha a mano.
 */
export function diaAnterior(fecha) {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) - DIA_MS).toISOString().slice(0, 10);
}

/**
 * Anota cómo te fue un día y devuelve el historial nuevo. No toca el que
 * recibe: quien guarda es `app.js`, y así esto se puede probar solo.
 *
 * Se guarda por `fecha` del desafío y no por el día en que se terminó, igual
 * que `blob3` en el registro del servidor: con las tres horas de gracia, uno del
 * 5 se puede cerrar el 6, y contarlo como del 6 le movería la racha de lugar.
 */
export function anotarDia(historial, fecha, { n, gano, encontro }) {
  const dias = { ...historial, [fecha]: { n, gano, encontro } };
  const claves = Object.keys(dias).sort();
  for (const vieja of claves.slice(0, Math.max(0, claves.length - TOPE_DIAS))) {
    delete dias[vieja];
  }
  return dias;
}

/** La racha más larga que hubo, para tener contra qué comparar la de ahora. */
function mejorRacha(historial) {
  let mejor = 0;
  let corriendo = 0;
  let previo = null;
  for (const dia of Object.keys(historial).sort()) {
    corriendo = previo && diaAnterior(dia) === previo ? corriendo + 1 : 1;
    previo = dia;
    if (corriendo > mejor) mejor = corriendo;
  }
  return mejor;
}

/**
 * Todo lo que hace falta para dibujar la racha.
 *
 * **No jugar todavía hoy no corta la racha.** Mientras el día no termine sigue
 * viva, y decirle "0" al que justo viene a jugar sería mentirle en el único
 * momento en que esto tiene que empujar para el otro lado. Se corta cuando pasó
 * un día entero sin jugar, que es cuando de verdad se cortó.
 */
export function resumen(historial, hoy = fechaDeHoy()) {
  const jugoHoy = Boolean(historial[hoy]);

  let racha = 0;
  let dia = jugoHoy ? hoy : diaAnterior(hoy);
  while (historial[dia]) {
    racha++;
    dia = diaAnterior(dia);
  }

  const jugados = Object.keys(historial).length;
  const ganados = Object.values(historial).filter((d) => d.gano).length;

  // De más viejo a más nuevo, terminando en hoy, con los días que no jugaste
  // adentro. Sin los huecos la tira se lee corrida: diez días seguidos y tres
  // salteados dibujarían lo mismo, que es justo lo que la racha viene a contar.
  const dias = [];
  for (let f = hoy, i = 0; i < DIAS_A_LA_VISTA; i++, f = diaAnterior(f)) {
    dias.unshift({ fecha: f, entrada: historial[f] ?? null, esHoy: f === hoy });
  }

  return { racha, mejor: mejorRacha(historial), jugoHoy, jugados, ganados, dias };
}
