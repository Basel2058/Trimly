// Starts the real Worker (workerd + local D1) for the API and browser tests.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PORT = Number(process.env.TRIMLY_PORT ?? 8799);
export const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess | null = null;
let dir = '';

export async function startServer(port = PORT): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'trimly-'));
  child = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', 'TEST_MODE:1', '--persist-to', dir, '--test-scheduled', '--show-interactive-dev-session=false'],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1' } },
  );
  let log = '';
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const until = Date.now() + 90000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until || child.exitCode !== null) throw new Error('server did not start:\n' + log.slice(-3000));
    await new Promise((r) => setTimeout(r, 300));
  }
}

export async function stopServer(): Promise<void> {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
}

export async function setup(): Promise<void> {
  await startServer();
}
export async function teardown(): Promise<void> {
  await stopServer();
}
