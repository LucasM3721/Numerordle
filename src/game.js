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
const SECRET_RE = new RegExp(`^[1-9]{${SECRET_LEN}}$`);

export function randomCode(len = 5) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

export function isValidCode(code) {
  return typeof code === 'string' && /^[A-Z2-9]{4,8}$/.test(code);
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

export function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return name || 'Jugador';
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
