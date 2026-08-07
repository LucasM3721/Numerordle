/**
 * Lee el dataset de partidas y arma el resumen con el que se calibra al bot.
 *
 * No vuelca filas: **aplica las reglas de censura** que están en "La trampa al
 * leer los intentos" (docs/DECISIONES.md). Esa es toda la gracia. Un promedio
 * sobre la columna de intentos, sin separar lo completo de lo truncado, da un
 * número más chico que el real y parece que la gente juega mejor de lo que
 * juega.
 *
 *   CF_ANALYTICS_TOKEN=... CF_ACCOUNT_ID=... npm run datos
 *
 * El token necesita un solo permiso: Account · Account Analytics · Read.
 */

const TOKEN = process.env.CF_ANALYTICS_TOKEN;
const CUENTA = process.env.CF_ACCOUNT_ID;
const DATASET = 'numerordle_partidas';

// Lo que mide `npm run bot`, para comparar contra la gente sin volver a correrlo.
const BOT = { facil: 15.9, normal: 12.0, dificil: 8.0 };

if (!TOKEN || !CUENTA) {
  console.error('Faltan CF_ANALYTICS_TOKEN y/o CF_ACCOUNT_ID en el entorno.');
  console.error('El token se crea en el panel: API Tokens → Custom Token →');
  console.error('Account · Account Analytics · Read. La cuenta sale de `npx wrangler whoami`.');
  process.exit(1);
}

const SQL = `
  SELECT timestamp, blob1 AS modo, blob2 AS quien, blob3 AS dia,
         double1 AS intentos, double2 AS gano, double6 AS siguio, double7 AS encontro
  FROM ${DATASET}
  ORDER BY timestamp DESC
  LIMIT 10000
`;

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CUENTA}/analytics_engine/sql`,
  { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: SQL },
);

if (!res.ok) {
  const texto = await res.text();
  console.error(`La API contestó HTTP ${res.status}.`);
  // El 401 es casi siempre el permiso del token, no el token en sí.
  if (res.status === 401) console.error('Revisá que el token tenga Account Analytics · Read.');
  console.error(texto.slice(0, 300));
  process.exit(1);
}

const { data } = await res.json();
const filas = data ?? [];

if (!filas.length) {
  console.log('El dataset está vacío. Todavía no terminó ninguna partida ni ningún desafío.');
  process.exit(0);
}

const num = (v) => Number(v ?? 0);
const resumen = (xs) => {
  if (!xs.length) return null;
  const o = [...xs].sort((a, b) => a - b);
  const media = o.reduce((a, b) => a + b, 0) / o.length;
  return { n: o.length, min: o[0], mediana: o[Math.floor(o.length / 2)], media, max: o.at(-1) };
};
const linea = (r) => r
  ? `n=${r.n}  mediana ${r.mediana}  media ${r.media.toFixed(1)}  rango ${r.min}–${r.max}`
  : 'sin datos';

const retos = filas.filter((f) => f.modo === 'reto');
const salas = filas.filter((f) => f.modo !== 'reto');
const personas = salas.filter((f) => f.quien === 'humano');
const maquinas = salas.filter((f) => f.quien !== 'humano');

console.log(`\nDatos de Numerordle — ${filas.length} filas\n`);

// ------------------------------------------------------------- las salas
console.log('PARTIDAS DE SALA');
const ganadas = personas.filter((f) => num(f.gano) === 1).map((f) => num(f.intentos));
const cortadas = personas.filter((f) => num(f.gano) !== 1).map((f) => num(f.intentos));
console.log(`  filas de personas: ${personas.length}`);
console.log(`    completas (ganaron): ${linea(resumen(ganadas))}`);
console.log(`    censuradas (cortó el rival): ${cortadas.length} — solo dicen "más de N"`);
console.log(`  filas de máquina: ${maquinas.length}`);

// ---------------------------------------------------------- el desafío
console.log('\nDESAFÍO DEL DÍA');
const dentro = retos.filter((f) => num(f.gano) === 1).map((f) => num(f.intentos));
const fuera = retos.filter((f) => num(f.gano) !== 1 && num(f.encontro) === 1).map((f) => num(f.intentos));
const nunca = retos.filter((f) => num(f.encontro) !== 1);
console.log(`  desafíos terminados: ${retos.length}`);
console.log(`    lo sacaron dentro de 12: ${linea(resumen(dentro))}`);
console.log(`    lo sacaron pasado el tope: ${linea(resumen(fuera))}`);
console.log(`    no lo sacaron: ${nunca.length} — censurados en el tope`);
if (retos.length) {
  const dias = new Set(retos.map((f) => f.dia).filter(Boolean));
  console.log(`  días distintos jugados: ${dias.size}`);
}

// ------------------------------------------------- lo que sí se compara
// Una observación sirve cuando la persona **encontró** el número: ahí el
// conteo es cuántos necesitó. Si no lo encontró, solo sabemos que necesitaba
// más, y mezclarlo baja el promedio de mentira.
const completas = [...ganadas, ...dentro, ...fuera];
const censuradas = cortadas.length + nunca.length;

console.log('\nLO QUE SE PUEDE COMPARAR');
console.log(`  personas, solo observaciones completas: ${linea(resumen(completas))}`);
console.log(`  descartadas por censura: ${censuradas}`);
const bot = Object.entries(BOT).map(([n, v]) => `${n} ${v.toFixed(1)}`).join(' · ');
console.log(`  el bot: ${bot}`);

const r = resumen(completas);
if (!r) {
  console.log('\n  Todavía no hay ninguna observación completa.');
} else if (r.n < 30) {
  // Un número puesto con seguridad sobre cuatro partidas hace más daño que no
  // tener número: se toman decisiones sobre ruido.
  console.log(`\n  ⚠ ${r.n} observaciones son pocas para mover los niveles del bot.`);
  console.log('    Sirve para ver la forma, no para calibrar.');
}
if (r && new Set(filas.map((f) => f.dia).filter(Boolean)).size <= 1 && r.n < 30) {
  console.log('    Y si son todas del mismo jugador, miden a esa persona, no a "la gente".');
}

console.log('\nEl porqué de estas reglas está en "La trampa al leer los intentos" (docs/DECISIONES.md).\n');
