// GIF Lab — the standalone server.
//
// It serves the built page and mounts the routes at /api, which is exactly
// where the original mounts them, so the components' own fetch calls did not
// change. Nothing is uploaded anywhere: every job runs as a program on this
// machine, and unplugging the internet changes nothing.

import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import gifRouter from './routes/gif.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function readOption(name: string, fallback: string): string {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  const next = process.argv[i + 1];
  if (i !== -1 && next && !next.startsWith('--')) return next;
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

const PORT = Number(readOption('port', process.env.PORT || '8080'));
// Loopback by default. There is no password on any of this, so being reachable
// from the rest of the network has to be asked for out loud.
const HOST = readOption('host', process.env.HOST || '127.0.0.1');
const CHECK_ONLY = process.argv.includes('--check');

/** Is a program on PATH, and which version? */
function which(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.split('\n')[0].trim() : null));
  });
}

const ffmpeg = await which('ffmpeg', ['-version']);
const gifsicle = await which('gifsicle', ['--version']);
const cutoutPython = process.env.GIFLAB_PYTHON || '';
const cutoutModel = process.env.GIFLAB_MODEL || '';
const cutoutReady = Boolean(cutoutPython && cutoutModel && existsSync(cutoutPython) && existsSync(cutoutModel));

console.log('');
console.log('Checking what this computer has installed:');
console.log(`  ${ffmpeg ? 'yes' : 'NO '}  ffmpeg${ffmpeg ? `  (${ffmpeg})` : ''}`);
console.log(`  ${gifsicle ? 'yes' : 'NO '}  gifsicle${gifsicle ? `  (${gifsicle})` : ''}`);
console.log(`  ${cutoutReady ? 'yes' : 'NO '}  background removal — automatic${cutoutReady ? '' : '  (needs extra setup, see the README)'}`);
console.log('');

if (!ffmpeg || !gifsicle) {
  const missing = [!ffmpeg && 'ffmpeg', !gifsicle && 'gifsicle'].filter(Boolean).join(' and ');
  console.error(`${missing} is not installed, and nothing here works without it.`);
  console.error('  macOS          brew install ffmpeg gifsicle');
  console.error('  Ubuntu/Debian  sudo apt install ffmpeg gifsicle');
  console.error('  Fedora         sudo dnf install ffmpeg gifsicle');
  console.error('  Windows        winget install Gyan.FFmpeg   then   winget install gifsicle');
  console.error('');
  console.error('On Windows, open a NEW terminal afterwards — a program just added to');
  console.error('your PATH is invisible to a window that was already open.');
  process.exit(1);
}
if (CHECK_ONLY) process.exit(0);

if (!cutoutReady) {
  console.log('Automatic background removal is included but not switched on here —');
  console.log('it needs a Python and a model file this computer has not got yet.');
  console.log('See "Background removal" in the README. Removing a flat color works now.');
  console.log('');
}

// The routes write under process.cwd()/data and read the python scripts from
// process.cwd()/tools, so the server has to run from the project root whichever
// way it was started.
process.chdir(ROOT);
mkdirSync(join(ROOT, 'data', 'gif-work'), { recursive: true });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64mb' }));
// A RATE LIMIT ON THE API, because every one of these routes spawns a program.
//
// On loopback this is a formality. It stops mattering the moment anyone runs
// this with --host 0.0.0.0, which the readme offers and which has no password —
// at that point one machine on the network can start unbounded ffmpeg processes
// on yours. In memory on purpose: a tool that needs no database to run a GIF
// should not gain one to count requests, and the count only has to survive as
// long as the process does.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 240;
const seen = new Map<string, { count: number; until: number }>();

app.use('/api', (req, res, next) => {
  const now = Date.now();
  const who = req.socket.remoteAddress || 'local';
  const entry = seen.get(who);
  if (!entry || now > entry.until) {
    seen.set(who, { count: 1, until: now + RATE_WINDOW_MS });
    // Sweep here rather than on a timer, so an idle process is genuinely idle.
    if (seen.size > 512) for (const [k, v] of seen) if (now > v.until) seen.delete(k);
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    res.status(429).json({ error: 'Too many requests at once. Wait a moment and try again.' });
    return;
  }
  next();
});

app.use('/api', gifRouter);

// Anything under /api that got this far does not exist. Without this it falls
// through to the page below and answers a fetch with a lump of HTML, which looks
// to the browser like the request worked.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'No such address.' });
});

// Anything that throws under /api answers in JSON. Without this express falls
// back to its own HTML error page, the browser tries to parse it, and what the
// person actually sees is "Unexpected token '<', "<!DOCTYPE "... is not valid
// JSON" — which says nothing about what went wrong. Mounted before the static
// files so it only ever covers the API.
app.use('/api', (err: NodeJS.ErrnoException & { code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'That file is too big for this tool (the limit is 50 MB).' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err?.message || 'Something went wrong on this computer.' });
});

const DIST = join(ROOT, 'dist');
if (!existsSync(DIST)) {
  console.error('The page has not been built yet. Run:  npm run build');
  process.exit(1);
}
app.use(express.static(DIST));
app.get('*', (_req, res) => res.sendFile(join(DIST, 'index.html')));

const server = app.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log('GIF Lab is running.');
  console.log('');
  console.log(`  Open this in your browser:  http://${shown}:${PORT}`);
  console.log('');
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.log('  It is also reachable from other devices on your network, and it');
    console.log('  has no password. Only do this on a network you trust.');
    console.log('');
  }
  console.log('  Working files go in:', join(ROOT, 'data', 'gif-work'));
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`Port ${PORT} is already being used by something else on this computer.`);
    console.error(`Start it on a different one, for example:  npm start -- --port ${PORT + 1}`);
    console.error('');
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\nStopping.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
