import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../../platforms/claude-code/hooks/session-cleanup.sh');

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-hook-cleanup-'));
});
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function runHookAsync(
  stdinJson: string,
  env: Record<string, string> = {},
): Promise<{ status: number | null }> {
  return new Promise((res) => {
    const child = spawn('bash', [hookPath], {
      env: { ...process.env, HOME: sandbox, SYNTAUR_DASHBOARD_PORT: '1', ...env },
    });
    child.on('close', (code) => res({ status: code }));
    child.stdin.end(stdinJson);
  });
}

async function withCaptureServer<T>(
  fn: (port: number, captured: { url?: string }) => Promise<T>,
): Promise<{ result: T; captured: { url?: string } }> {
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
    const result = await fn(port, captured);
    return { result, captured };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

describe('claude-code session-cleanup.sh', () => {
  it('marks the EXACT ending session (stdin .session_id), not the clobbered context.json scalar', async () => {
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    // Co-tenant clobbered the shared scalar to 'B'; the ending session is 'A'.
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p', assignmentSlug: 'a', sessionId: 'B' }),
    );
    const { captured } = await withCaptureServer(async (port) => {
      const r = await runHookAsync(JSON.stringify({ cwd: sandbox, session_id: 'A' }), {
        SYNTAUR_DASHBOARD_PORT: String(port),
      });
      expect(r.status).toBe(0);
    });
    expect(captured.url).toBe('/api/agent-sessions/A/status');
  });

  it('falls back to the context.json hint only when stdin carries no id', async () => {
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p', sessionId: 'HINT' }),
    );
    const { captured } = await withCaptureServer(async (port) => {
      const r = await runHookAsync(JSON.stringify({ cwd: sandbox }), {
        SYNTAUR_DASHBOARD_PORT: String(port),
      });
      expect(r.status).toBe(0);
    });
    expect(captured.url).toBe('/api/agent-sessions/HINT/status');
  });
});
