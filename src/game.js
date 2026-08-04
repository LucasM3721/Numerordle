/**
 * Reglas puras del juego (fijos y picas). Sin estado, sin red: todo lo que
 * puede probarse mirando nada más que la entrada y la salida.
 */

export const SECRET_LEN = 4;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12; // tope duro de la aplicación
export const MAX_NAME = 16;

// Sin I, O, 0 ni 1: el código se dicta por teléfono sin ambigüedades.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 5;
// Se arma con el alfabeto y el largo de arriba para que validar y generar no
// puedan discrepar: aceptar una forma que no generamos es aceptar basura.
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);
const SECRET_RE = new RegExp(`^[1-9]{${SECRET_LEN}}$`);

export function randomCode(len = CODE_LEN) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

/**
 * Id público de un jugador. Es lo único que viaja a los demás: el `pid` con el
 * que cada uno se autentica no sale nunca del servidor, así que conocer a
 * alguien en la sala no alcanza para hacerse pasar por él.
 */
export function randomPublicId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * El pid lo elige el cliente y termina usándose como clave de objetos (los
 * intentos pendientes), así que conviene que sea un identificador y no
 * cualquier cosa.
 *
 * El `in` de la segunda condición saca todo lo que un objeto plano ya contesta
 * por herencia: `toString`, `hasOwnProperty`, `__proto__`. No alcanza con
 * listarlos a mano —`toString` mide 8 y pasa el patrón sin despeinarse— y el
 * daño es concreto: `state.pending['toString']` da una función, o sea que ese
 * jugador contaría como que ya jugó sin haber mandado nada, y la ronda se
 * cerraría sola con un intento que no existe.
 */
export function isValidPid(pid) {
  return (
    typeof pid === 'string'
    && /^[A-Za-z0-9_-]{8,64}$/.test(pid)
    && !(pid in {})
  );
}

/**
 * Aceptaba de 4 a 8 caracteres y dejaba pasar la I y la O, que el alfabeto no
 * genera nunca. Un código imposible llegaba igual a `idFromName` y despertaba
 * un Durable Object para no encontrar nada: se paga por descartar basura.
 */
export function isValidCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

/**
 * Cupo de una sala. Cada sala elige el suyo, pero nunca por encima del tope
 * duro ni por debajo de `piso` (los que ya están adentro: bajarlo más los
 * dejaría fuera de una sala en la que ya entraron).
 * Un valor ausente o ilegible cae en el tope, que es el comportamiento viejo.
 */
export function clampMaxPlayers(value, piso = MIN_PLAYERS) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return MAX_PLAYERS;
  return Math.min(MAX_PLAYERS, Math.max(piso, n));
}

/** 4 dígitos, todos entre 1 y 9, ninguno repetido. */
export function isValidSecret(value) {
  return typeof value === 'string'
    && SECRET_RE.test(value)
    && new Set(value).size === SECRET_LEN;
}

/**
 * Fijos: dígito correcto en la posición correcta.
 * Picas: dígito correcto en otra posición.
 * Como no hay dígitos repetidos, picas = coincidencias totales - fijos.
 */
export function scoreGuess(guess, secret) {
  let fijos = 0;
  let comunes = 0;
  for (let i = 0; i < SECRET_LEN; i++) {
    if (guess[i] === secret[i]) fijos++;
    if (secret.includes(guess[i])) comunes++;
  }
  return { fijos, picas: comunes - fijos };
}

/**
 * Las marcas de dirección son invisibles y dan vuelta el texto que las rodea:
 * un nombre con una adentro desordena la línea entera de la interfaz. Los
 * caracteres de control se cambian por espacio (y no se borran) para que
 * "Ana\nBeto" quede "Ana Beto" y no "AnaBeto".
 */
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const CONTROL = /\p{Cc}/gu;

export function cleanName(raw) {
  const name = String(raw ?? '')
    .replace(BIDI, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return name || 'Jugador';
}

/** Un número válido al azar. Lo usa la máquina para elegir el suyo. */
export function randomSecret() {
  const pool = '123456789'.split('');
  let out = '';
  for (let i = 0; i < SECRET_LEN; i++) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % pool.length;
    out += pool.splice(j, 1)[0];
  }
  return out;
}

/** Fisher-Yates con crypto, para mezclar el orden del círculo. */
export function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
