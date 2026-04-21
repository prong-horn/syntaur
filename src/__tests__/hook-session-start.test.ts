import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  stat,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(
  here,
  '../../platforms/claude-code/hooks/session-start.sh',
);

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-hook-start-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

function runHook(stdinJson: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [hookPath], {
    input: stdinJson,
    encoding: 'utf-8',
    // Point HOME at a place with no dashboard-port file AND force the
    // dashboard port at an unused port so curl silently fails — keeps unit
    // tests isolated from any real dashboard process on this machine.
    env: {
      ...process.env,
      HOME: sandbox,
      SYNTAUR_DASHBOARD_PORT: '1',
      ...env,
    },
  });
}

// Async variant — required whenever the test needs node's event loop to
// process an incoming HTTP request WHILE the hook subprocess is still running.
// `spawnSync` blocks the main thread, so any in-process http server started
// inside the same test can't respond until the hook finishes, by which time
// curl has already timed out.
function runHookAsync(
  stdinJson: string,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [hookPath], {
      env: {
        ...process.env,
        HOME: sandbox,
        SYNTAUR_DASHBOARD_PORT: '1',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ status: code, stdout, stderr });
    });
    child.stdin.end(stdinJson);
  });
}

describe('claude-code session-start.sh', () => {
  it('merges session_id + transcript_path into an existing context.json without dropping other fields', async () => {
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'p',
        assignmentSlug: 'a',
        title: 'keep me',
      }),
    );

    const res = runHook(
      JSON.stringify({
        session_id: 'abc-123',
        transcript_path: '/tmp/t.jsonl',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);

    const after = JSON.parse(
      await readFile(resolve(sandbox, '.syntaur', 'context.json'), 'utf-8'),
    );
    expect(after).toMatchObject({
      projectSlug: 'p',
      assignmentSlug: 'a',
      title: 'keep me',
      sessionId: 'abc-123',
      transcriptPath: '/tmp/t.jsonl',
    });
  });

  it('never creates .syntaur/ when context.json is absent', async () => {
    const res = runHook(
      JSON.stringify({
        session_id: 'abc-123',
        transcript_path: '/tmp/t.jsonl',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);
    expect(existsSync(resolve(sandbox, '.syntaur'))).toBe(false);
  });

  it('replaces a stale transcriptPath with null when the new payload omits transcript_path', async () => {
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'p',
        sessionId: 'old-id',
        transcriptPath: '/tmp/old.jsonl',
      }),
    );

    const res = runHook(
      JSON.stringify({
        session_id: 'new-id',
        transcript_path: '',
        cwd: sandbox,
      }),
    );
    expect(res.status).toBe(0);

    const after = JSON.parse(
      await readFile(resolve(sandbox, '.syntaur', 'context.json'), 'utf-8'),
    );
    expect(after.sessionId).toBe('new-id');
    expect(after.transcriptPath).toBeNull();
    expect(after.projectSlug).toBe('p');
  });

  it('exits 0 and leaves filesystem untouched when session_id is missing from stdin', async () => {
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    const initial = JSON.stringify({ projectSlug: 'p' });
    await writeFile(resolve(sandbox, '.syntaur', 'context.json'), initial);
    const before = (
      await stat(resolve(sandbox, '.syntaur', 'context.json'))
    ).mtimeMs;

    const res = runHook(
      JSON.stringify({ cwd: sandbox, transcript_path: '/tmp/x' }),
    );
    expect(res.status).toBe(0);

    const content = await readFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      'utf-8',
    );
    expect(content).toBe(initial);
    const after = (
      await stat(resolve(sandbox, '.syntaur', 'context.json'))
    ).mtimeMs;
    expect(after).toBe(before);
  });

  it('POSTs a pre-registration to the dashboard including projectSlug / assignmentSlug when present', async () => {
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'my-proj', assignmentSlug: 'my-assn' }),
    );

    // Stand up a tiny HTTP server that captures the POST body.
    let captured: { url?: string; body?: string } = {};
    const server: Server = await new Promise((ready) => {
      const s = createServer((req: IncomingMessage, res) => {
        let data = '';
        req.on('data', (chunk) => {
          data += chunk;
        });
        req.on('end', () => {
          captured = { url: req.url, body: data };
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ sessionId: 'captured' }));
        });
      });
      s.listen(0, '127.0.0.1', () => ready(s));
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const res = await runHookAsync(
        JSON.stringify({
          session_id: 'real-sid',
          transcript_path: '/tmp/real.jsonl',
          cwd: sandbox,
        }),
        { SYNTAUR_DASHBOARD_PORT: String(port) },
      );
      expect(res.status).toBe(0);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }

    expect(captured.url).toBe('/api/agent-sessions');
    const parsed = JSON.parse(captured.body ?? '{}');
    expect(parsed.sessionId).toBe('real-sid');
    expect(parsed.transcriptPath).toBe('/tmp/real.jsonl');
    expect(parsed.projectSlug).toBe('my-proj');
    expect(parsed.assignmentSlug).toBe('my-assn');
    expect(parsed.agent).toBe('claude');
    expect(parsed.path).toBe(sandbox);
  });

  it('silently tolerates an unreachable dashboard and still exits 0', async () => {
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p' }),
    );

    const res = runHook(
      JSON.stringify({
        session_id: 'sid',
        transcript_path: '/tmp/x.jsonl',
        cwd: sandbox,
      }),
      { SYNTAUR_DASHBOARD_PORT: '1' }, // port 1 won't accept connections
    );
    expect(res.status).toBe(0);

    const after = JSON.parse(
      await readFile(resolve(sandbox, '.syntaur', 'context.json'), 'utf-8'),
    );
    expect(after.sessionId).toBe('sid');
  });
});
