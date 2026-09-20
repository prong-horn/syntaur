import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement } from '../db/engagement-db.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  cwd: string,
  syntaurHome: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = { ...process.env, SYNTAUR_HOME: syntaurHome, HOME: syntaurHome };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.OPENCODE_SESSION_ID;
    delete env.PI_SESSION_ID;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

const TICKET_ID = 'DEM-1';

function seedOpenEngagement(home: string, sessionId: string): void {
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  try {
    openEngagement({
      sessionId,
      ticketId: TICKET_ID,
      startedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    closeSessionDb();
  }
}

describe('syntaur session resume (last handoff)', () => {
  let syntaurHome: string;
  let workspaceRoot: string;
  let ticketDir: string;
  const SID = 'resume-handoff-1';

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-resume-handoff-'));
    await writeFile(
      resolve(syntaurHome, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(syntaurHome, 'projects')}\n---\n`,
    );
    await seedMissingBuiltins(syntaurHome);
    workspaceRoot = await mkdtemp(join(tmpdir(), 'syntaur-resume-handoff-wkspc-'));
    ticketDir = resolve(syntaurHome, 'projects', 'p', 'tickets', `${TICKET_ID}-demo`);
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      `---\nid: ${TICKET_ID}\nslug: demo\ntitle: Demo\nstatus: in_progress\ntemplate: legacy\n---\n# Demo\n`,
    );
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('prints last handoff from typed progress.md entry', async () => {
    seedOpenEngagement(syntaurHome, SID);
    await writeFile(
      resolve(ticketDir, 'progress.md'),
      `---
ticket: demo
entryCount: 1
updated: "2026-05-08T12:00:00Z"
---

# Progress

## 2026-05-08T12:00:00Z · handoff · human

Shipped the API layer.
`,
    );

    const human = await runCli(['session', 'resume'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('Last handoff: 2026-05-08T12:00:00Z · Shipped the API layer.');

    const json = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    const data = JSON.parse(json.stdout);
    expect(data.lastHandoff).toEqual({
      timestamp: '2026-05-08T12:00:00Z',
      firstLine: 'Shipped the API layer.',
    });
  });

  it('falls back to legacy handoff.md when the log has no handoff entry', async () => {
    seedOpenEngagement(syntaurHome, SID);
    await writeFile(
      resolve(ticketDir, 'handoff.md'),
      `---\nticket: demo\ngenerated: "2026-05-08T12:00:00Z"\n---\n\n## Handoff 1: 2026-05-08T12:00:00Z\n\nLegacy baton content.\n`,
    );

    const human = await runCli(['session', 'resume'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('Last handoff: Legacy baton content.');
  });

  it('skips injected Recorded line when previewing an undated legacy handoff', async () => {
    seedOpenEngagement(syntaurHome, SID);
    await writeFile(
      resolve(ticketDir, 'handoff.md'),
      `---\nticket: demo\ngenerated: "2026-05-08T12:00:00Z"\n---\n\n## Handoff 1\n\n**Recorded:** 2026-05-08T12:00:00Z\n\nFirst prose line for preview.\n`,
    );

    const json = await runCli(['session', 'resume', '--json'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    const data = JSON.parse(json.stdout);
    expect(data.lastHandoff?.firstLine).toBe('First prose line for preview.');
  });

  it('reads journal handoff on feature tickets', async () => {
    seedOpenEngagement(syntaurHome, SID);
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      `---\nid: ${TICKET_ID}\nslug: demo\ntitle: Demo\nstatus: in_progress\ntemplate: feature\n---\n# Demo\n`,
    );
    await writeFile(
      resolve(ticketDir, 'journal.md'),
      `---
purpose: test
---

## 2026-06-01T09:00:00Z · handoff · human

Journal baton line.
`,
    );

    const human = await runCli(['session', 'resume'], workspaceRoot, syntaurHome, {
      CLAUDE_CODE_SESSION_ID: SID,
    });
    expect(human.stdout).toContain('Last handoff: 2026-06-01T09:00:00Z · Journal baton line.');
  });
});
