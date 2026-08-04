/**
 * El rival de la máquina. No resuelve el juego: lo juega.
 *
 * La decisión de la que cuelga todo: **el bot solo hace lo que se puede hacer
 * en la mesa, con un papel al lado.** No filtra las 3024 permutaciones.
 *
 * Con filtrado completo ganaría en cinco intentos siempre, y para que pareciera
 * humano habría que ponerle un handicap inventado: que falle a propósito. Así
 * no hace falta: es lento por la misma razón que somos lentos nosotros.
 *
 * Juega en dos etapas, como cualquiera:
 *
 * 1. **Averiguar qué dígitos son.** Cambia *un solo dígito por vez* respecto al
 *    intento anterior. Es lo que hace que el resultado signifique algo: si el
 *    total se movió, sabe exactamente cuál entró y cuál salió. Cambiar todo de
 *    golpe da un número nuevo del que no se concluye nada — y esa fue,
 *    literalmente, la primera versión de este archivo.
 * 2. **Ordenarlos.** Con los cuatro dígitos ya identificados quedan 24
 *    combinaciones. Ahí sí las repasa: veinticuatro es una cantidad que una
 *    persona enumera en un papel sin despeinarse. Tres mil no.
 *
 * Encima se olvida: `olvido` es la probabilidad de no usar algo que sabía.
 */

import { SECRET_LEN, scoreGuess } from './game.js';

const DIGITOS = '123456789'.split('');

/**
 * Los niveles no son un handicap: son tres formas distintas de jugar.
 *
 * - `olvido`: probabilidad de no usar algo que ya sabía. Se aplica tanto al
 *   anotar como al repasar, que es donde a uno se le escapan los renglones.
 * - `deduceCambio`: la técnica de cambiar de a un dígito y mirar si el total se
 *   mueve. La que más acelera y la que menos gente aplica sola.
 * - `repasa`: al ordenar, revisar las 24 combinaciones contra lo anotado. Sin
 *   esto prueba de memoria y se le mezclan.
 * - `grupos`: segunda tanda de cuatro dígitos nuevos, y el noveno por resta.
 * - `verifica` / `imagina`: cuántos números se imagina antes de tirar uno, y si
 *   los imagina libremente o retocando el anterior. Las dos cosas van juntas:
 *   imaginar libre sin insistir termina jugando cualquier cosa, y retocar el
 *   anterior nunca se aleja lo suficiente para encontrar el que cierra.
 *
 * Medidos sobre 20.000 partidas cada uno (`npm run bot`): media de 15,9 / 12,1
 * / 8,1 y mediana de 15 / 12 / 8. Si tocás cualquiera de estos números, corré
 * la medición: son knobs acoplados y la intuición falla feo.
 */
export const NIVELES = {
  // El distraído. Retoca el anterior de a un dígito, se olvida de casi la mitad
  // de lo que dedujo y al ordenar prueba de memoria. Igual cambia de a un
  // dígito: sin eso no aprende nada y no termina nunca. Un jugador malo es
  // lento, no inmortal.
  facil: { olvido: 0.45, deduceCambio: true, repasa: false, grupos: false, verifica: 2, imagina: false },

  // El que juega bien pero de memoria. Lleva la cuenta y repasa al ordenar,
  // pero piensa pocos números antes de tirar y se le escapan cosas.
  normal: { olvido: 0.28, deduceCambio: true, repasa: true, grupos: false, verifica: 8, imagina: false },

  // El metódico. Abre con dos tandas para cubrir los nueve dígitos y después
  // insiste hasta dar con un número que explique todo lo anotado. Lo que lo
  // frena es lo único que frena a alguien así: repasando salteado se le pasa
  // un renglón y tira un número que ya estaba descartado.
  dificil: { olvido: 0.25, deduceCambio: true, repasa: true, grupos: true, verifica: 400, imagina: true },
};

/**
 * `NIVELES[nivel]` contesta que sí para `toString` o `__proto__`: los hereda de
 * Object.prototype y no son niveles. Importa porque el nivel viene de afuera
 * —de la query al crear la sala y del mensaje que suma una máquina—, y con uno
 * de esos la máquina queda con un nivel que no existe: `NIVELES[c.nivel].olvido`
 * da undefined, todas las comparaciones contra él son falsas y juega cualquier
 * cosa. Es el mismo agujero que ya se tapó en `isValidPid`.
 */
export function esNivel(nivel) {
  return typeof nivel === 'string' && Object.hasOwn(NIVELES, nivel);
}

export function nuevoCuaderno(nivel = 'normal') {
  return {
    nivel: esNivel(nivel) ? nivel : 'normal',
    fuera: new Set(), // dígitos que sé que no están
    dentro: new Set(), // dígitos que sé que están, sin saber dónde
    prohibido: Array.from({ length: SECRET_LEN }, () => new Set()),
    historia: [],
    ultimo: null,
  };
}

/**
 * El cuaderno vive en el estado de la sala, que se guarda y se recupera. Los
 * `Set` no sobreviven a ese viaje de forma confiable, así que entra y sale como
 * listas planas. La conversión está acá y no en `room.js` para que el resto del
 * juego no tenga que saber cómo está armado el cuaderno por dentro.
 */
export function guardarCuaderno(c) {
  return {
    nivel: c.nivel,
    fuera: [...c.fuera],
    dentro: [...c.dentro],
    prohibido: c.prohibido.map((s) => [...s]),
    historia: c.historia,
    ultimo: c.ultimo,
  };
}

export function cargarCuaderno(plano) {
  const c = nuevoCuaderno(plano?.nivel);
  if (!plano) return c;
  c.fuera = new Set(plano.fuera ?? []);
  c.dentro = new Set(plano.dentro ?? []);
  c.prohibido = (plano.prohibido ?? []).map((l) => new Set(l));
  while (c.prohibido.length < SECRET_LEN) c.prohibido.push(new Set());
  c.historia = plano.historia ?? [];
  c.ultimo = plano.ultimo ?? null;
  return c;
}

const azarPorDefecto = () => Math.random();

function mezclar(lista, azar) {
  const out = [...lista];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const alAzar = (lista, azar) => lista[Math.floor(azar() * lista.length)];

// ------------------------------------------------------------- el cuaderno

/**
 * Anota el resultado de un intento. Todo lo que hay acá son deducciones que
 * cualquiera hace en la mesa; ninguna necesita papel aparte.
 */
export function anotarResultado(c, intento, fijos, picas, azar = azarPorDefecto) {
  const digitos = intento.split('');
  const total = fijos + picas;
  const nivel = NIVELES[c.nivel];
  const recuerda = () => azar() >= nivel.olvido;

  // "No hay nada de esto acá." El descarte más claro que existe.
  if (total === 0 && recuerda()) {
    for (const d of digitos) c.fuera.add(d);
  }

  // "Están los cuatro, me falta ordenarlos."
  if (total === SECRET_LEN && recuerda()) {
    for (const d of digitos) c.dentro.add(d);
  }

  // Ningún fijo: ninguno de esos dígitos va donde lo puse.
  if (fijos === 0 && recuerda()) {
    digitos.forEach((d, i) => c.prohibido[i].add(d));
  }

  // Cambié un solo dígito y el total se movió: sé cuál entró y cuál salió.
  if (nivel.deduceCambio && c.ultimo && recuerda()) {
    const antes = c.ultimo.intento.split('');
    const distintas = [];
    for (let i = 0; i < SECRET_LEN; i++) if (antes[i] !== digitos[i]) distintas.push(i);
    if (distintas.length === 1) {
      const i = distintas[0];
      const delta = total - (c.ultimo.fijos + c.ultimo.picas);
      if (delta === 1) {
        c.dentro.add(digitos[i]);
        c.fuera.add(antes[i]);
      } else if (delta === -1) {
        c.dentro.add(antes[i]);
        c.fuera.add(digitos[i]);
      } else if (nivel.grupos && c.fuera.has(digitos[i])) {
        // Metí a propósito uno que ya sabía que no estaba y el total no se
        // movió: el que saqué tampoco estaba. Cambiar contra un descarte
        // conocido es lo que vuelve concluyente hasta el empate.
        c.fuera.add(antes[i]);
      }
      // Con un dígito sin probar, en cambio, delta 0 no dice nada: o están los
      // dos o ninguno. Tampoco lo sabría una persona.
    }
  }

  // Si ya descarté cinco, los cuatro que quedan son los buenos. Es la cuenta
  // que uno hace al final: "no puede ser ninguno de esos, así que son estos".
  if (c.fuera.size === DIGITOS.length - SECRET_LEN && recuerda()) {
    for (const d of DIGITOS) if (!c.fuera.has(d)) c.dentro.add(d);
  }

  c.historia.push({ intento, fijos, picas });
  c.ultimo = { intento, fijos, picas };

  // Dos tandas de cuatro dígitos distintos cubren ocho de los nueve, y el que
  // falta sale por resta: si entre las dos suman cuatro, el noveno no está; si
  // suman tres, el noveno es justamente el que falta. Es la cuenta que hace
  // alguien que juega en serio, y no pide más que sumar.
  if (nivel.grupos && c.historia.length === 2 && recuerda()) {
    const [a, b] = c.historia;
    const vistos = new Set([...a.intento, ...b.intento]);
    if (vistos.size === 2 * SECRET_LEN) {
      const noveno = DIGITOS.find((d) => !vistos.has(d));
      const suma = a.fijos + a.picas + b.fijos + b.picas;
      if (suma === SECRET_LEN) c.fuera.add(noveno);
      else if (suma === SECRET_LEN - 1) c.dentro.add(noveno);
    }
  }
  // Si un desliz dejó un dígito en las dos listas, vale que está.
  for (const d of c.dentro) c.fuera.delete(d);
}

// -------------------------------------------------------------- el intento

/** Ordena los dígitos evitando las posiciones que ya sé que no son. */
function colocar(elegidos, c, azar) {
  for (let i = 0; i < 30; i++) {
    const orden = mezclar(elegidos, azar);
    if (orden.every((d, pos) => !c.prohibido[pos].has(d))) return orden.join('');
  }
  // No hay acomodo sin pisar algo prohibido. Juego igual: quedarse pensando
  // para siempre no es una opción y equivocarse no es grave.
  return mezclar(elegidos, azar).join('');
}

/** Cuatro dígitos: los que sé que están, después los que no probé. */
function cuatroDigitos(c, azar) {
  const dentro = mezclar([...c.dentro], azar);
  const sinProbar = mezclar(DIGITOS.filter((d) => !c.dentro.has(d) && !c.fuera.has(d)), azar);
  const resto = mezclar(DIGITOS.filter((d) => c.fuera.has(d) && !c.dentro.has(d)), azar);
  return [...dentro, ...sinProbar, ...resto].slice(0, SECRET_LEN);
}

/** Todas las formas de ordenar cuatro dígitos. Son 24. */
function permutaciones(digitos) {
  if (digitos.length <= 1) return [digitos];
  const out = [];
  for (let i = 0; i < digitos.length; i++) {
    const resto = [...digitos.slice(0, i), ...digitos.slice(i + 1)];
    for (const p of permutaciones(resto)) out.push([digitos[i], ...p]);
  }
  return out;
}

const mismoConjunto = (a, b) => [...a].sort().join('') === [...b].sort().join('');
const coincidencias = (a, b) => a.reduce((n, d, i) => n + (d === b[i] ? 1 : 0), 0);

/**
 * Etapa de ordenar: descarta las combinaciones que contradicen los fijos que ya
 * vio. Solo compara contra intentos con **los mismos cuatro dígitos**, que es
 * la única comparación que alguien hace de memoria en la mesa.
 */
function intentoDeOrden(c, azar) {
  const digitos = [...c.dentro].slice(0, SECRET_LEN);
  const todas = permutaciones(digitos);
  if (!NIVELES[c.nivel].repasa) return colocar(digitos, c, azar);

  const previos = c.historia
    .map((h) => ({ ...h, digitos: h.intento.split('') }))
    .filter((h) => mismoConjunto(h.digitos, digitos))
    // Se le pasa alguno: repasar veinticuatro líneas a mano no sale perfecto.
    .filter(() => azar() >= NIVELES[c.nivel].olvido);

  const viables = todas.filter((perm) =>
    previos.every((h) => coincidencias(perm, h.digitos) === h.fijos),
  );

  const elegida = viables.length > 0 ? alAzar(viables, azar) : alAzar(todas, azar);
  return elegida.join('');
}

/**
 * Etapa de averiguar: cambia **un solo dígito** respecto al intento anterior.
 * Ahí está toda la gracia: si el total se mueve, el resultado significa algo.
 */
function intentoDeBusqueda(c, azar) {
  const nivel = NIVELES[c.nivel];
  if (!c.ultimo) return colocar(cuatroDigitos(c, azar), c, azar);

  // Segunda tanda: cuatro dígitos nuevos de golpe. Entre las dos tandas quedan
  // cubiertos ocho de los nueve, y el noveno sale por resta.
  if (nivel.grupos && c.historia.length === 1) {
    const usados = new Set(c.ultimo.intento);
    const nuevos = mezclar(DIGITOS.filter((d) => !usados.has(d)), azar).slice(0, SECRET_LEN);
    if (nuevos.length === SECRET_LEN) return colocar(nuevos, c, azar);
  }

  const actual = c.ultimo.intento.split('');
  const sinProbar = DIGITOS.filter(
    (d) => !c.dentro.has(d) && !c.fuera.has(d) && !actual.includes(d),
  );
  const cambiables = actual
    .map((d, i) => i)
    .filter((i) => !c.dentro.has(actual[i]));

  // Sin nada nuevo que probar, o con los cuatro ya confirmados: a ordenar.
  if (sinProbar.length === 0 || cambiables.length === 0) {
    return colocar(cuatroDigitos(c, azar), c, azar);
  }

  const salida = [...actual];
  salida[alAzar(cambiables, azar)] = alAzar(mezclar(sinProbar, azar), azar);
  return salida.join('');
}

/**
 * ¿Este número explica todo lo que anoté? O sea: si el secreto fuera éste, ¿los
 * intentos que ya tiré habrían dado los fijos y picas que dieron? Es el "a ver,
 * probemos si cierra" de cualquiera antes de comprometerse con un número.
 *
 * Con `olvido` se saltea renglones: repasar la lista entera cada vez, sin que
 * se te escape ninguno, es justamente lo que no hace una persona.
 */
function cierraConLasNotas(candidato, c, azar) {
  const olvido = NIVELES[c.nivel].olvido;
  for (const h of c.historia) {
    if (azar() < olvido) continue;
    const { fijos, picas } = scoreGuess(h.intento, candidato);
    if (fijos !== h.fijos || picas !== h.picas) return false;
  }
  return true;
}

/**
 * El próximo intento. Piensa un número, se fija si cierra con lo anotado, y si
 * no, piensa otro. **No enumera las 3024**: las imagina de a una y las
 * descarta, que es lo que se puede hacer en la mesa. `verifica` es cuántas
 * llega a probar antes de encogerse de hombros y jugar la última que pensó —
 * o sea, cuánta paciencia tiene.
 */
export function proponerIntento(c, azar = azarPorDefecto) {
  const nivel = NIVELES[c.nivel];
  const pensar = () => {
    if (c.dentro.size >= SECRET_LEN) return intentoDeOrden(c, azar);
    // Cambiar de a un dígito hace que el resultado signifique algo, pero solo
    // imagina números pegados al anterior: si el que cierra está lejos, no lo
    // encuentra. Con paciencia para verificar conviene lo contrario —imaginar
    // libre y descartar— y sin ella, el cambio de a uno es lo mejor que hay.
    if (nivel.imagina) return colocar(cuatroDigitos(c, azar), c, azar);
    return intentoDeBusqueda(c, azar);
  };

  let candidato = pensar();
  for (let i = 0; i < nivel.verifica; i++) {
    if (cierraConLasNotas(candidato, c, azar)) return candidato;
    candidato = pensar();
  }
  return candidato;
}
