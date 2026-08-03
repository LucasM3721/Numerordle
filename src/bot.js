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

import { SECRET_LEN } from './game.js';

const DIGITOS = '123456789'.split('');

/**
 * `deduceCambio` es la técnica de cambiar de a un dígito y mirar el total: la
 * que más acelera y la que menos gente aplica sola. `repasa` es enumerar las
 * 24 combinaciones al ordenar; sin eso, prueba de memoria y se le mezclan.
 */
export const NIVELES = {
  // Fácil también cambia de a un dígito: sin eso no aprende nada y no termina
  // nunca. Un jugador malo es lento, no inmortal. Lo que lo hace malo es que se
  // olvida de la mitad de lo que dedujo y que al ordenar prueba de memoria.
  facil: { olvido: 0.45, deduceCambio: true, repasa: false },
  normal: { olvido: 0.15, deduceCambio: true, repasa: true },
  dificil: { olvido: 0.02, deduceCambio: true, repasa: true },
};

export function nuevoCuaderno(nivel = 'normal') {
  return {
    nivel: NIVELES[nivel] ? nivel : 'normal',
    fuera: new Set(), // dígitos que sé que no están
    dentro: new Set(), // dígitos que sé que están, sin saber dónde
    prohibido: Array.from({ length: SECRET_LEN }, () => new Set()),
    historia: [],
    ultimo: null,
  };
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
      }
      // delta 0 no dice nada: o los dos están, o ninguno. Tampoco lo sabría
      // una persona, así que el bot se queda igual de colgado.
    }
  }

  // Si ya descarté cinco, los cuatro que quedan son los buenos. Es la cuenta
  // que uno hace al final: "no puede ser ninguno de esos, así que son estos".
  if (c.fuera.size === DIGITOS.length - SECRET_LEN && recuerda()) {
    for (const d of DIGITOS) if (!c.fuera.has(d)) c.dentro.add(d);
  }

  c.historia.push({ intento, fijos, picas });
  c.ultimo = { intento, fijos, picas };
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
  if (!c.ultimo) return colocar(cuatroDigitos(c, azar), c, azar);

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

export function proponerIntento(c, azar = azarPorDefecto) {
  return c.dentro.size >= SECRET_LEN ? intentoDeOrden(c, azar) : intentoDeBusqueda(c, azar);
}
