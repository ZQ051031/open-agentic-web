import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function nodeServer(port) {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
  const server = createHttpServer(async (request, response) => {
    try {
      let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const path = resolve(repoRoot, '.' + pathname);
      if (!path.startsWith(resolve(repoRoot) + sep)) throw Error('Invalid path');
      const body = await readFile(path);
      response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { origin: 'http://127.0.0.1:' + port, kind: 'Node fallback', stop: () => new Promise((r) => server.close(r)) };
}

export async function startServer() {
  const port = await freePort();
  const process = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let missing = false;
  let failure = '';
  process.on('error', (error) => {
    missing = error.code === 'ENOENT';
    failure = error.message;
  });
  process.stderr.on('data', (chunk) => {
    failure = (failure + chunk).slice(-4000);
  });
  const origin = 'http://127.0.0.1:' + port;
  const stop = async () => {
    if (process.exitCode !== null || missing) return;
    const exited = new Promise((resolve) => process.once('exit', resolve));
    process.kill('SIGTERM');
    await exited;
  };
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (missing) return nodeServer(port);
      if (process.exitCode !== null) throw Error('Static server exited: ' + failure);
      try {
        const response = await fetch(origin + '/agent-manifest.json');
        if (response.ok) return { origin, kind: 'python3 -m http.server', stop };
      } catch {
        /* Wait for the server socket. */
      }
      await delay(50);
    }
    throw Error('Static server startup timed out: ' + failure);
  } catch (error) {
    await stop();
    throw error;
  }
}
