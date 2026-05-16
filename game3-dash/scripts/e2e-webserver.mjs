/**
 * Starts backend + Vite for Playwright when ports are free.
 * Exits once both /health and the frontend respond.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'backend');
const API = 'http://127.0.0.1:3001/health';
const FRONTEND = 'http://localhost:5173/';
const FRONTEND_PORT = '5173';

const children = [];

function spawnProc(label, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  child.on('exit', (code) => {
    console.error(`[e2e-webserver] ${label} exited with code ${code}`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

async function waitFor(url, label, attempts = 120) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`[e2e-webserver] ${label} ready: ${url}`);
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`[e2e-webserver] timed out waiting for ${label} (${url})`);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

async function isUp(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const apiUp = await isUp(API);
const frontUp = await isUp(FRONTEND);

if (!apiUp) {
  spawnProc('backend', 'npm', ['run', 'dev'], backendDir);
  await waitFor(API, 'backend');
} else {
  console.log('[e2e-webserver] backend already running');
}

if (!frontUp) {
  spawnProc('frontend', 'npm', ['run', 'dev:strict'], root);
  for (let i = 0; i < 120; i += 1) {
    if ((await portOpen(Number(FRONTEND_PORT))) && (await isUp(FRONTEND))) {
      console.log(`[e2e-webserver] frontend ready: ${FRONTEND}`);
      break;
    }
    if (i === 119) {
      throw new Error(`[e2e-webserver] timed out waiting for frontend (${FRONTEND})`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} else {
  console.log('[e2e-webserver] frontend already running');
}

console.log('[e2e-webserver] ready — keeping servers alive for Playwright');
await new Promise(() => {});
