import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../../platforms/codex/scripts/session-cleanup.sh');

let sandbox: string;
let runtimeDir: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-codex-cleanup-'));
  runtimeDir = await mkdtemp(join(tmpdir(), 'syntaur-codex-runtime-'));
  await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
});
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
  await rm(runtimeDir, { recursive: true, force: true });
});

function runHookAsync(
  stdinJson: string,
  env: Record<string, string> = {},
): Promise<{ status: number | null }> {
  return new Promise((res) => {
    const child = spawn('bash', [hookPath], {
      env: { ...process.env, HOME: sandbox, ...env },
    });
    child.on('close', (code) => res({ status: code }));
    child.stdin.end(stdinJson);
  });
}

async function withCaptureServer<T>(
  fn: (port: number, captured: { url?: string }) => Promise<T>,
): Promise<{ captured: { url?: string } }> {
  const captured: { url?: string } = {};
  const server: Server = await new Promise((ready) => {
    const s = createServer((req: IncomingMessage, response) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        captured.url = req.url;
        response.statusCode = 200;
        response.end('{}');
      });
    });
    s.listen(0, '127.0.0.1', () => ready(s));
  });
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port, captured);
    return { captured };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('codex session-cleanup.sh', () => {
  it('resolves the ending id from a capture-at-birth runtime marker (never the context scalar)', async () => {
    // context.json has a CLOBBERED scalar; the hook must ignore it and use the
    // marker keyed by the hook's parent pid (= this node process).
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p', sessionId: 'CLOBBERED' }),
    );
    await writeFile(join(runtimeDir, `${process.pid}.json`), JSON.stringify({ sessionId: 'CODEX-A', agent: 'codex' }));
    await writeFile(resolve(sandbox, '.syntaur', 'dashboard-port'), '1');

    const { captured } = await withCaptureServer(async (port) => {
      await writeFile(resolve(sandbox, '.syntaur', 'dashboard-port'), String(port));
      const r = await runHookAsync(JSON.stringify({ cwd: sandbox }), {
        SYNTAUR_RUNTIME_SESSIONS_DIR: runtimeDir,
      });
      expect(r.status).toBe(0);
    });
    expect(captured.url).toBe('/api/agent-sessions/CODEX-A/status');
  });

  it('fails CLOSED: skips a marker whose procStart does not match the live process', async () => {
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p', sessionId: 'CLOBBERED' }),
    );
    // procStart is bogus → cannot match the test process's real `ps -o lstart=` → skip.
    await writeFile(
      join(runtimeDir, `${process.pid}.json`),
      JSON.stringify({ sessionId: 'CODEX-STALE', procStart: 'Mon Jan  1 00:00:00 2001' }),
    );
    const { captured } = await withCaptureServer(async (port) => {
      await writeFile(resolve(sandbox, '.syntaur', 'dashboard-port'), String(port));
      const r = await runHookAsync(JSON.stringify({ cwd: sandbox }), {
        SYNTAUR_RUNTIME_SESSIONS_DIR: runtimeDir,
      });
      expect(r.status).toBe(0);
    });
    expect(captured.url).toBeUndefined();
  });

  it('skips the PATCH when no exact marker resolves (does NOT trust the clobbered scalar)', async () => {
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p', sessionId: 'CLOBBERED' }),
    );
    // runtimeDir is empty — no marker for any ancestor pid.
    const { captured } = await withCaptureServer(async (port) => {
      await writeFile(resolve(sandbox, '.syntaur', 'dashboard-port'), String(port));
      const r = await runHookAsync(JSON.stringify({ cwd: sandbox }), {
        SYNTAUR_RUNTIME_SESSIONS_DIR: runtimeDir,
      });
      expect(r.status).toBe(0);
    });
    // No request should have been made — the clobbered scalar must NOT be used.
    expect(captured.url).toBeUndefined();
  });
});
