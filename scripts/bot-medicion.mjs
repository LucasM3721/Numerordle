/**
 * Mide cuánto tarda el bot en adivinar. No es una prueba de que ande: es la
 * forma de discutir si juega como una persona o como una computadora.
 *
 * La referencia: alguien que juega bien saca el número en 6 a 10 intentos, con
 * días malos de 13 o 14. Un resolvedor por descarte de candidatos lo saca en 5
 * casi siempre y casi nunca pasa de 7 — si las cifras dan eso, el bot es
 * demasiado bueno por más que se llame "fácil".
 *
 *   node scripts/bot-medicion.mjs [partidas]
 */

import { scoreGuess } from '../src/game.js';
import { NIVELES, anotarResultado, nuevoCuaderno, proponerIntento } from '../src/bot.js';

const PARTIDAS = Number(process.argv[2] ?? 5000);
const TOPE = 40; // si llega acá, se colgó

function secretoAlAzar() {
  const pool = '123456789'.split('');
  let out = '';
  for (let i = 0; i < 4; i++) out += pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
  return out;
}

function jugar(nivel) {
  const secreto = secretoAlAzar();
  const cuaderno = nuevoCuaderno(nivel);
  for (let n = 1; n <= TOPE; n++) {
    const intento = proponerIntento(cuaderno);
    const { fijos, picas } = scoreGuess(intento, secreto);
    if (fijos === 4) return n;
    anotarResultado(cuaderno, intento, fijos, picas);
  }
  return TOPE;
}

function percentil(ordenados, p) {
  return ordenados[Math.min(ordenados.length - 1, Math.floor(ordenados.length * p))];
}

console.log(`${PARTIDAS} partidas por nivel\n`);
console.log('nivel     media  mediana   p90   p99   máx   >15   colgadas');
console.log('-'.repeat(62));

for (const nivel of Object.keys(NIVELES)) {
  const r = [];
  for (let i = 0; i < PARTIDAS; i++) r.push(jugar(nivel));
  r.sort((a, b) => a - b);
  const media = r.reduce((a, b) => a + b, 0) / r.length;
  const largas = r.filter((x) => x > 15).length / r.length;
  const colgadas = r.filter((x) => x >= TOPE).length;
  console.log(
    nivel.padEnd(10) +
    media.toFixed(1).padStart(5) +
    String(percentil(r, 0.5)).padStart(9) +
    String(percentil(r, 0.9)).padStart(6) +
    String(percentil(r, 0.99)).padStart(6) +
    String(r.at(-1)).padStart(6) +
    `${(largas * 100).toFixed(1)}%`.padStart(7) +
    String(colgadas).padStart(11),
  );
}
