import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  createClaudeBackend,
  createPiBackend,
  resolveBackend,
  resolveSyntheticApiKey,
  runPrompt,
  extractPiAssistantText,
  PI_MODEL_ID,
} from '../sessions/summarize-backends.js';
import type { SyntaurConfig } from '../utils/config.js';

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-backends-'));
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

/**
 * Write a real executable stub. Spawning an actual process (rather than mocking
 * node:child_process) is what makes argv, stdin, env, and exit-code handling
 * genuinely covered.
 */
async function writeStub(name: string, script: string): Promise<string> {
  const path = resolve(sandbox, name);
  await writeFile(path, script);
  await chmod(path, 0o755);
  return path;
}

/** A stub that records its argv/env/stdin to a file, then prints `output`. */
async function recordingStub(name: string, output: string, exitCode = 0): Promise<string> {
  const record = resolve(sandbox, `${name}.record.json`);
  return writeStub(
    name,
    `#!/usr/bin/env node
const fs = require('fs');
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    argv: process.argv.slice(2),
    syntheticKey: process.env.SYNTHETIC_API_KEY ?? null,
    stdin,
  }));
  process.stdout.write(${JSON.stringify(output)});
  process.exit(${exitCode});
});
`,
  );
}

async function readRecord(name: string): Promise<{ argv: string[]; syntheticKey: string | null; stdin: string }> {
  return JSON.parse(await readFile(resolve(sandbox, `${name}.record.json`), 'utf-8'));
}

const contract = JSON.stringify({ description: 'd', summary: 's' });

/**
 * A realistic pi `--mode json` event stream carrying `assistantText` as the
 * assistant's final message — the shape the pi backend must parse (verified
 * against real `pi -p --mode json` output).
 */
function piStream(assistantText: string): string {
  return (
    [
      { type: 'session', version: 3, id: 'abc', cwd: '/tmp' },
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
      { type: 'turn_end' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n'
  );
}

describe('runPrompt', () => {
  it('pipes the prompt on stdin and captures stdout', async () => {
    const bin = await recordingStub('echoer', 'hello out');
    const result = await runPrompt(bin, ['--flag'], { stdin: 'the prompt' });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello out');
    const rec = await readRecord('echoer');
    expect(rec.stdin).toBe('the prompt');
    expect(rec.argv).toEqual(['--flag']);
  });

  it('reports ENOENT for a missing binary rather than throwing', async () => {
    const result = await runPrompt(resolve(sandbox, 'does-not-exist'), [], { stdin: 'x' });
    expect(result.enoent).toBe(true);
    expect(result.code).toBeNull();
  });

  it('SIGKILLs a hung child and reports the timeout', async () => {
    const bin = await writeStub('hang', '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n');
    const result = await runPrompt(bin, [], { stdin: 'x', timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
  });

  it('truncates oversized output and kills the child', async () => {
    const bin = await writeStub(
      'flood',
      "#!/usr/bin/env node\nprocess.stdout.write('x'.repeat(200000));\n",
    );
    const result = await runPrompt(bin, [], { stdin: 'x', maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  it('captures a stdin write failure without crashing (EPIPE)', async () => {
    // Exits immediately without reading stdin, so a large write has nowhere to
    // go. This must NOT crash the process, and the failure must be observable —
    // a backend that never received the prompt cannot have used it.
    const bin = await writeStub('quick', "#!/usr/bin/env node\nprocess.stdout.write('done');\n");
    const result = await runPrompt(bin, [], { stdin: 'x'.repeat(2_000_000) });
    expect(result.stdinError).toBe(true);
  });

  it('does not spawn when the signal is already aborted', async () => {
    const bin = await recordingStub('preaborted', 'out');
    const result = await runPrompt(bin, [], { stdin: 'x', signal: AbortSignal.abort() });
    expect(result.aborted).toBe(true);
    // The stub never ran, so its record file is absent.
    await expect(readRecord('preaborted')).rejects.toThrow();
  });

  it('SIGKILLs an in-flight child when the signal aborts (shutdown)', async () => {
    const controller = new AbortController();
    const bin = await writeStub('hang', '#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n');
    const promise = runPrompt(bin, [], { stdin: 'x', signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
  });
});

describe('claude backend', () => {
  it('passes the non-persistence and tool-disable invariants in argv', async () => {
    const bin = await recordingStub('claude', JSON.stringify({ result: contract }));
    const res = await createClaudeBackend(bin)('a prompt');

    expect(res).toEqual({ ok: true, text: contract });
    const { argv } = await readRecord('claude');
    // Invariant 1: never registers as a tracked session.
    expect(argv).toContain('--no-session-persistence');
    // Invariant 2: transcript text is untrusted, so no tools may be available.
    expect(argv).toContain('--disallowedTools');
    expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe('*');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--setting-sources');
    // --json-schema is deliberately absent: it routes output through a
    // StructuredOutput tool call, which the tool lockdown above blocks.
    expect(argv).not.toContain('--json-schema');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
  });

  it('unwraps the result envelope', async () => {
    const bin = await recordingStub('claude', JSON.stringify({ result: contract, is_error: false }));
    const res = await createClaudeBackend(bin)('p');
    expect(res).toEqual({ ok: true, text: contract });
  });

  it('unwraps an envelope surrounded by log noise', async () => {
    const bin = await recordingStub(
      'claude',
      `warning: something\n${JSON.stringify({ result: contract })}\ntrailing junk\n`,
    );
    const res = await createClaudeBackend(bin)('p');
    expect(res).toEqual({ ok: true, text: contract });
  });

  it('reports an error envelope as a failure', async () => {
    const bin = await recordingStub('claude', JSON.stringify({ is_error: true, result: 'nope' }));
    const res = await createClaudeBackend(bin)('p');
    expect(res.ok).toBe(false);
  });

  it('falls back to raw stdout when the envelope is not the expected shape', async () => {
    const bin = await recordingStub('claude', contract);
    const res = await createClaudeBackend(bin)('p');
    // The core parser gets a chance to find the contract in the raw text.
    expect(res).toEqual({ ok: true, text: contract });
  });

  it('surfaces stderr on a non-zero exit', async () => {
    const bin = await writeStub(
      'claude-fail',
      "#!/usr/bin/env node\nprocess.stderr.write('boom happened');\nprocess.exit(3);\n",
    );
    const res = await createClaudeBackend(bin)('p');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('boom happened');
      expect(res.error).toContain('3');
    }
  });

  it('reports a missing binary clearly', async () => {
    const res = await createClaudeBackend(resolve(sandbox, 'absent'))('p');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not found on PATH/);
  });
});

describe('pi backend', () => {
  it('injects the resolved key and passes the isolation invariants', async () => {
    const bin = await recordingStub('pi', piStream(contract));
    // Spread process.env like real callers do — a child needs PATH to exec.
    const res = await createPiBackend(bin, {
      env: { ...process.env, SYNTHETIC_API_KEY: 'sk-test-123' },
    })('p');

    // The backend extracts the assistant text from the event stream — it must
    // NOT return the raw JSONL (whose first object is the session header).
    expect(res).toEqual({ ok: true, text: contract });
    const rec = await readRecord('pi');
    // Eager resolution: the child receives the key, never relying on pi's own
    // (known-unreliable) lazy lookup.
    expect(rec.syntheticKey).toBe('sk-test-123');
    expect(rec.argv).toContain('--no-session');
    expect(rec.argv).toContain('--no-tools');
    expect(rec.argv).toContain('--no-extensions');
    expect(rec.argv).toContain('--no-skills');
    expect(rec.argv[rec.argv.indexOf('--model') + 1]).toBe(PI_MODEL_ID);
  });

  it('fails fast without spawning when no key can be resolved', async () => {
    const gcloudFail = await writeStub(
      'gcloud',
      "#!/usr/bin/env node\nprocess.stderr.write('no secret');\nprocess.exit(1);\n",
    );
    const piBin = await recordingStub('pi', piStream(contract));
    const res = await createPiBackend(piBin, {
      env: { ...process.env, SYNTHETIC_API_KEY: '' },
      gcloudBinary: gcloudFail,
    })('p');

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/SYNTHETIC_API_KEY unavailable/);
    // pi must never have run — a call that cannot authenticate is pure waste.
    await expect(readRecord('pi')).rejects.toThrow();
  });

  it('falls back to gcloud when the env var is absent', async () => {
    const gcloudOk = await writeStub(
      'gcloud',
      "#!/usr/bin/env node\nprocess.stdout.write('sk-from-gcloud\\n');\n",
    );
    const piBin = await recordingStub('pi', piStream(contract));
    await createPiBackend(piBin, {
      env: { ...process.env, SYNTHETIC_API_KEY: '' },
      gcloudBinary: gcloudOk,
    })('p');

    const rec = await readRecord('pi');
    expect(rec.syntheticKey).toBe('sk-from-gcloud');
  });

  it('errors when pi produces an event stream with no assistant text', async () => {
    // e.g. an auth failure that emits only a session header + error events.
    const headerOnly = JSON.stringify({ type: 'session', version: 3, id: 'x', cwd: '/tmp' }) + '\n';
    const piBin = await recordingStub('pi', headerOnly);
    const res = await createPiBackend(piBin, {
      env: { ...process.env, SYNTHETIC_API_KEY: 'sk-test' },
    })('p');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no assistant text/);
  });
});

describe('extractPiAssistantText', () => {
  it('returns the assistant text from a full event stream', () => {
    expect(extractPiAssistantText(piStream(contract))).toBe(contract);
  });

  it('returns the LAST assistant message when several are present', () => {
    const stream =
      piStream('first answer').trimEnd() +
      '\n' +
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] },
      }) +
      '\n';
    expect(extractPiAssistantText(stream)).toBe('final answer');
  });

  it('ignores user messages and non-message events', () => {
    const stream = [
      JSON.stringify({ type: 'session', id: 'x' }),
      JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } }),
      JSON.stringify({ type: 'agent_end' }),
    ].join('\n');
    expect(extractPiAssistantText(stream)).toBeNull();
  });

  it('returns null for an empty or non-JSONL stream', () => {
    expect(extractPiAssistantText('')).toBeNull();
    expect(extractPiAssistantText('not json at all\nplain text')).toBeNull();
  });
});

describe('resolveSyntheticApiKey', () => {
  it('prefers the environment variable', async () => {
    const key = await resolveSyntheticApiKey({ SYNTHETIC_API_KEY: 'sk-env' }, 'gcloud-not-used');
    expect(key).toBe('sk-env');
  });

  it('returns null when gcloud is unavailable', async () => {
    const key = await resolveSyntheticApiKey({}, resolve(sandbox, 'no-gcloud'));
    expect(key).toBeNull();
  });

  it('ignores a blank env value and falls through', async () => {
    const key = await resolveSyntheticApiKey({ SYNTHETIC_API_KEY: '   ' }, resolve(sandbox, 'no-gcloud'));
    expect(key).toBeNull();
  });
});

describe('resolveBackend', () => {
  // resolveBackend only reads session.summarizeBackend, so a minimal stub keeps
  // the test independent of unrelated config shape churn.
  const configWith = (backend: 'claude' | 'pi'): SyntaurConfig =>
    ({
      session: { autoTrack: 'all', summarizeBackend: backend, autoSummarize: 'on' },
    }) as SyntaurConfig;

  it('defaults to the configured backend', () => {
    expect(resolveBackend(undefined, configWith('pi')).name).toBe('pi');
    expect(resolveBackend(undefined, configWith('claude')).name).toBe('claude');
  });

  it('lets an explicit flag override the config', () => {
    expect(resolveBackend('claude', configWith('pi')).name).toBe('claude');
    expect(resolveBackend('pi', configWith('claude')).name).toBe('pi');
  });

  it('rejects an unknown backend name', () => {
    expect(() => resolveBackend('gpt', configWith('claude'))).toThrow(/Unknown summarize backend/);
  });
});
