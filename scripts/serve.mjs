/** Minimal static server for local preview: `npm run serve` (PORT=… to override). */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

const ROOT = new URL('../dist/', import.meta.url);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const PORT = Number(process.env.PORT) || 4321;

try {
  await stat(new URL('index.html', ROOT));
} catch {
  console.error('dist/index.html not found — run `npm run build` first.');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  // Keep traversal inside dist/.
  const target = new URL(path, ROOT);
  if (!target.href.startsWith(ROOT.href)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use — another preview server is probably still running.\n\n` +
      `  Find it:  lsof -nP -iTCP:${PORT} -sTCP:LISTEN\n` +
      `  Stop it:  kill $(lsof -t -iTCP:${PORT} -sTCP:LISTEN)\n\n` +
      `Or serve on a different port:  PORT=4322 npm run serve`,
    );
    process.exit(1);
  }
  throw err;
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

server.listen(PORT, () => console.log(`Serving dist/ at http://localhost:${PORT}  (Ctrl-C to stop)`));
