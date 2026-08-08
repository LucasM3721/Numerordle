/**
 * Qué filas del dataset son de prueba y no cuentan para calibrar.
 *
 * Está aparte de `consultar-datos.mjs` por el mismo motivo por el que
 * `public/racha.js` está aparte de `app.js`: **acá no hay red ni entorno**, así
 * que la suite lo importa y lo prueba sin token y sin llamar a Cloudflare. Y
 * conviene probarlo, porque esto decide qué números se van a mirar para mover
 * los niveles del bot: si excluye de más o de menos, el resultado igual se ve
 * razonable y nadie se entera.
 *
 * Hay dos vías, y no son intercambiables:
 *
 * - **La marca** (`blob4 = 'prueba'`), que la pone el servidor cuando el pedido
 *   trajo `PRUEBA_CLAVE`. Es la buena: no hay que acordarse de nada después.
 * - **A mano**, para lo que se jugó antes de que la marca existiera o se escapó
 *   sin ella. Cada regla va con la fecha y con qué la delata, para que se pueda
 *   comprobar en vez de creer.
 *
 * Se identifican por forma y no por un id, porque el dataset **no guarda
 * ninguno** —a propósito, ver "Lo único que se registra" en DECISIONES—. Por eso
 * conviene que la lista sea corta: si crece, el problema no es la lista, es que
 * se está probando sin marca.
 *
 * **Cada regla lleva el minuto en que pasó**, y no solo la forma. La primera
 * versión de la segunda regla decía "strict, humano, 0 intentos, no ganó" y en
 * la primera corrida contra los datos de verdad se llevó puesta **una fila que
 * no era nuestra**: otra partida del mismo día, veintitrés horas antes, con la
 * misma forma. Una regla que saca de más se ve igual de razonable que una que
 * saca bien, así que el criterio es el de siempre: **en duda, el dato cuenta**.
 */

const num = (v) => Number(v ?? 0);

/** El timestamp viene como `2026-08-08 23:29:35`, en UTC. */
const enElMinuto = (f, minuto) => String(f.timestamp ?? '').startsWith(minuto);

export const A_MANO = [
  {
    porque: '6 de agosto de 2026: un desafío llevado al tope de 30 a propósito, antes de que existiera la marca',
    es: (f) => f.modo === 'reto' && f.dia === '2026-08-06' && num(f.intentos) === 30,
  },
  {
    porque: '8 de agosto de 2026, 23:29 UTC: las dos filas de una verificación post-deploy contra producción, sin la marca puesta',
    es: (f) => enElMinuto(f, '2026-08-08 23:29')
      && f.modo === 'strict' && f.quien === 'humano'
      && num(f.intentos) === 0 && num(f.gano) === 0,
  },
];

/**
 * Parte las filas en las que cuentan y las que no.
 *
 * Devuelve las excluidas por separado y no solo el total, porque el resumen las
 * nombra: una exclusión silenciosa es indistinguible de no tener esos datos, y
 * ahí es donde se empieza a creer un número que no es.
 *
 * Una fila ya marcada no se vuelve a contar como excluida a mano aunque encaje
 * con una regla, o el mismo dato aparecería dos veces en el conteo.
 */
export function separarPruebas(crudas, reglas = A_MANO) {
  const marcadas = crudas.filter((f) => f.marca === 'prueba');
  const restantes = crudas.filter((f) => f.marca !== 'prueba');

  const yaSacadas = new Set();
  const aMano = [];
  for (const regla of reglas) {
    const filas = restantes.filter((f) => !yaSacadas.has(f) && regla.es(f));
    if (!filas.length) continue;
    filas.forEach((f) => yaSacadas.add(f));
    aMano.push({ porque: regla.porque, filas });
  }

  return {
    filas: restantes.filter((f) => !yaSacadas.has(f)),
    marcadas,
    aMano,
    cuantas: marcadas.length + yaSacadas.size,
  };
}
