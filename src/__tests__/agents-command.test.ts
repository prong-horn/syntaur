import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentsCommand } from '../commands/agents.js';
import { readConfig } from '../utils/config.js';

// Integration coverage that goes THROUGH Commander (option registration,
// camelCasing of --launch-prompt → options.launchPrompt, persistence, and the
// `agents list` truncation) — the helper-level unit tests can't prove these.

const originalHome = process.env.HOME;
let tmpHome: string;
let logs: string[];

class ExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'syntaur-agents-cmd-'));
  await mkdir(join(tmpHome, '.syntaur'), { recursive: true });
  process.env.HOME = tmpHome;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.HOME = originalHome;
  await rm(tmpHome, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<void> {
  try {
    await agentsCommand.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof ExitError) return;
    throw err;
  }
}

describe('agents CLI --launch-prompt (through Commander)', () => {
  const LONG_PROMPT = '@assignment Run @e2e-dev-cycle end-to-end and then summarize the result.';

  it('add --launch-prompt registers + persists the field', async () => {
    await run(['add', '--id', 'lp', '--label', 'LP', '--command', 'claude', '--launch-prompt', LONG_PROMPT]);
    const config = await readConfig();
    const agent = config.agents?.find((a) => a.id === 'lp');
    expect(agent?.launchPrompt).toBe(LONG_PROMPT);
  });

  it('agents list shows a TRUNCATED launchPrompt (not the full value)', async () => {
    await run(['add', '--id', 'lp', '--label', 'LP', '--command', 'claude', '--launch-prompt', LONG_PROMPT]);
    logs = [];
    await run(['list']);
    const line = logs.find((l) => l.includes('lp') && l.includes('launchPrompt='));
    expect(line).toBeDefined();
    expect(line).toContain('…'); // truncated
    expect(line).not.toContain(LONG_PROMPT); // full value must not appear in list
  });

  it('set --launch-prompt "" clears the field', async () => {
    await run(['add', '--id', 'lp', '--label', 'LP', '--command', 'claude', '--launch-prompt', LONG_PROMPT]);
    await run(['set', 'lp', '--launch-prompt', '']);
    const config = await readConfig();
    const agent = config.agents?.find((a) => a.id === 'lp');
    expect(agent?.launchPrompt).toBeUndefined();
  });
});
