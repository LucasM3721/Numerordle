/**
 * Sirve `public/` con las cabeceras reales de `public/_headers`, para poder
 * mirar la interfaz en un navegador sin levantar el Worker.
 *
 * Existe por dos motivos concretos:
 *
 * 1. **Una CSP mal puesta rompe el sitio y las pruebas no lo notan**, porque
 *    `npm test` no abre ningún navegador. Acá se ve enseguida: si la página
 *    carga con estilos y el selector de jugadores aparece lleno, el módulo
 *    corrió y nada quedó bloqueado.
 * 2. Los estados de saturación son difíciles de provocar de verdad. Con
 *    `?caso=` se fuerzan y se mira cómo quedan.
 *
 * **No reemplaza a `wrangler dev`**: no hay websocket, ni Durable Objects, ni
 * lógica de juego. De la sala en adelante no sirve para nada.
 *
 *   node scripts/servir-estatico.mjs [puerto]
 *
 * Casos, cambiando `?caso=` en cualquier URL:
 *
 *   ?caso=ok      crear sala devuelve un código falso (es lo de siempre)
 *   ?caso=ritmo   429 nuestro: "no se pueden crear salas nuevas"
 *   ?caso=cupo    la página de error 1027 de Cloudflare, cupo diario agotado
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PUERTO = Number(process.argv[2] ?? 8899);

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** Las cabeceras salen del propio `_headers`: se prueba lo que se despliega. */
function cabecerasDelArchivo() {
  const ruta = join(RAIZ, '_headers');
  if (!existsSync(ruta)) return {};
  const out = {};
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const m = linea.match(/^ {2}([A-Za-z-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Parecido a lo que sirve Cloudflare al agotarse el cupo diario. Lo que importa
// es que el cuerpo traiga el número: así lo distingue el cliente.
const PAGINA_1027 = `<!DOCTYPE html><html lang="en"><head><title>Worker threw exception | 1027</title></head>
<body><h1>Error 1027</h1><p>Worker exceeded free tier daily request limit</p></body></html>`;

let caso = 'ok';

createServer((req, res) => {
  const cabeceras = cabecerasDelArchivo();
  const url = new URL(req.url, `http://localhost:${PUERTO}`);
  if (url.searchParams.has('caso')) caso = url.searchParams.get('caso');

  if (url.pathname === '/api/rooms' && req.method === 'POST') {
    if (caso === 'cupo') {
      res.writeHead(429, { ...cabeceras, 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGINA_1027);
    }
    if (caso === 'ritmo') {
      res.writeHead(429, { ...cabeceras, 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        error: 'Ahora mismo no se pueden crear salas nuevas. Probá de nuevo en un minuto.',
      }));
    }
    res.writeHead(200, { ...cabeceras, 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ code: 'PRUEB' }));
  }

  if (url.pathname.startsWith('/api/')) {
    res.writeHead(404, { ...cabeceras, 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'Acá no hay Worker: usá npm run dev.' }));
  }

  // `normalize` y el chequeo de prefijo son para que `..` no saque a nadie de
  // public/. Es una herramienta local, pero abrir el disco entero por comodidad
  // es exactamente así como pasan las cosas.
  const pedido = normalize(join(RAIZ, decodeURIComponent(url.pathname)));
  const dentro = pedido.startsWith(normalize(RAIZ));
  // Fallback de página única: /r/K7Q4Z tiene que devolver el index, igual que
  // en producción con `not_found_handling`.
  const ruta = dentro && existsSync(pedido) && extname(pedido) ? pedido : join(RAIZ, 'index.html');

  res.writeHead(200, { ...cabeceras, 'content-type': TIPOS[extname(ruta)] ?? 'text/plain; charset=utf-8' });
  res.end(readFileSync(ruta));
}).listen(PUERTO, () => {
  console.log(`Sirviendo public/ en http://127.0.0.1:${PUERTO}`);
  console.log('Casos: ?caso=ok · ?caso=ritmo · ?caso=cupo');
  console.log('Sin websocket ni Durable Objects: de la sala en adelante, usá npm run dev.');
});
