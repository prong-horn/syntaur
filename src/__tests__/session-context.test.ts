import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { HOOK_ENTRIES } from '../commands/hooks.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import { getSessionDb } from '../dashboard/session-db.js';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  initSessionDb,
  closeSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import { openEngagement } from '../db/engagement-db.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { buildPromptContext, runSessionContext } from '../commands/session-context.js';
import { rowToBinding } from '../utils/engagement-binding.js';
import type { EngagementRow } from '../db/engagement-db.js';

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'syntaur.js');
let home: string;
let cwd: string;
const SESSION_ID = 'sess-context-1';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  syntaurHome: string,
  input?: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SYNTAUR_HOME: syntaurHome,
      HOME: syntaurHome,
    };
    delete env.CLAUDE_CODE_SESSION_ID;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function writePlaybook(slug: string, name: string, body: string): Promise<void> {
  const dir = resolve(home, 'playbooks');
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, `${slug}.md`),
    [
      '---',
      `name: "${name}"`,
      `slug: ${slug}`,
      'description: "test"',
      'when_to_use: "testing"',
      'created: "2026-04-02T00:00:00Z"',
      'updated: "2026-04-02T00:00:00Z"',
      'tags: []',
      '---',
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeFeatureTicket(
  ticketId: string,
  status: string,
  title = 'Feature ticket',
): Promise<void> {
  const ticketDir = resolve(home, 'projects', 'scratch', 'tickets', `${ticketId}-feat`);
  await mkdir(ticketDir, { recursive: true });
  await mkdir(resolve(home, 'projects', 'scratch'), { recursive: true });
  await writeFile(
    resolve(home, 'projects', 'scratch', 'project.md'),
    `---\nslug: scratch\ntitle: scratch\nprefix: SCR\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n`,
  );
  await writeFile(
    resolve(ticketDir, 'ticket.md'),
    `---\nid: ${ticketId}\nslug: feat\ntitle: ${title}\nproject: scratch\ntemplate: feature\nstatus: ${status}\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# ${title}\n`,
  );
}

function seedEngagement(ticketId: string, stage = 'planning'): void {
  resetSessionDb();
  initSessionDb(resolve(home, 'syntaur.db'));
  openEngagement({
    sessionId: SESSION_ID,
    ticketId,
    stage,
    startedAt: '2026-01-01T00:00:00Z',
  });
  closeSessionDb();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'syntaur-session-context-'));
  cwd = await mkdtemp(join(tmpdir(), 'syntaur-session-context-cwd-'));
  await writeFile(
    resolve(home, 'config.md'),
    `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\n---\n`,
  );
  await seedMissingBuiltins(home);
  await writePlaybook('commit-discipline', 'Commit Discipline', '# Commit Discipline\n\nCommit often.');
  await writePlaybook('test-before-done', 'Test Before Done', '# Test Before Done\n\nRun tests.');
});

afterEach(async () => {
  closeSessionDb();
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('buildPromptContext explicit session binding', () => {
  const ENV_SESSION = 'env-bound-session';

  beforeEach(async () => {
    process.env.SYNTAUR_HOME = home;
    await writeFeatureTicket('SCR-20', 'planning');
    seedEngagement('SCR-20', 'planning');
    process.env.CLAUDE_CODE_SESSION_ID = ENV_SESSION;
    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    openEngagement({
      sessionId: ENV_SESSION,
      ticketId: 'SCR-20',
      stage: 'planning',
      startedAt: '2026-01-02T00:00:00Z',
    });
    closeSessionDb();
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('does not bind from CLAUDE_CODE_SESSION_ID when session id is omitted', async () => {
    const result = await buildPromptContext({ root: home, cwd, sessionId: null });
    expect(result.ticketId).toBeNull();
    expect(result.text).not.toContain('Ticket:');
    expect(result.text).toContain('## Playbooks');
  });

  it('does not bind an invalid explicit session id', async () => {
    const result = await buildPromptContext({ root: home, cwd, sessionId: 'bad id!' });
    expect(result.ticketId).toBeNull();
    expect(result.text).not.toContain('Ticket:');
  });
});

describe('runSessionContext explicit session binding', () => {
  const ENV_SESSION = 'env-bound-session';

  beforeEach(async () => {
    process.env.SYNTAUR_HOME = home;
    await writeFeatureTicket('SCR-21', 'backlog');
    process.env.CLAUDE_CODE_SESSION_ID = ENV_SESSION;
    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    openEngagement({
      sessionId: ENV_SESSION,
      ticketId: 'SCR-21',
      stage: 'backlog',
      startedAt: '2026-01-02T00:00:00Z',
    });
    closeSessionDb();
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('hook payload without session_id and no context.json prints playbooks only', async () => {
    const result = await runSessionContext(
      JSON.stringify({ cwd, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      { cwd, fromHook: true },
    );
    expect(result?.ticketId).toBeNull();
    expect(result?.text).not.toContain('Ticket:');
    expect(result?.text).toContain('## Playbooks');
  });
});

describe('syntaur session context CLI explicit binding', () => {
  const ENV_SESSION = 'env-bound-session';

  beforeEach(async () => {
    await writeFeatureTicket('SCR-22', 'planning');
    process.env.CLAUDE_CODE_SESSION_ID = ENV_SESSION;
    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    openEngagement({
      sessionId: ENV_SESSION,
      ticketId: 'SCR-22',
      stage: 'planning',
      startedAt: '2026-01-02T00:00:00Z',
    });
    closeSessionDb();
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('with no session id prints playbooks only despite env session', async () => {
    const res = await runCli(['session', 'context', '--cwd', cwd], home, undefined, {
      CLAUDE_CODE_SESSION_ID: ENV_SESSION,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('Ticket:');
    expect(res.stdout).toContain('## Playbooks');
  });

  it('with invalid --session-id prints playbooks only', async () => {
    const res = await runCli(
      ['session', 'context', '--session-id', 'bad id!', '--cwd', cwd],
      home,
      undefined,
      { CLAUDE_CODE_SESSION_ID: ENV_SESSION },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('Ticket:');
    expect(res.stdout).toContain('## Playbooks');
  });

  it('hook stdin without session_id prints playbooks only', async () => {
    const payload = JSON.stringify({
      cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hi',
    });
    const res = await runCli(['session', 'context', '--from-hook'], home, payload, {
      CLAUDE_CODE_SESSION_ID: ENV_SESSION,
    });
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('Ticket:');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('## Playbooks');
  });
});

describe('buildPromptContext', () => {
  it('strips a leading H1 from playbook bodies so the title appears once', async () => {
    process.env.SYNTAUR_HOME = home;
    const result = await buildPromptContext({ root: home, cwd, sessionId: SESSION_ID });
    expect(result.text).toContain('### Commit Discipline');
    expect(result.text).not.toMatch(/^# Commit Discipline/m);
    expect(result.text).toContain('Commit often.');
    expect(result.text.split('Commit Discipline').length - 1).toBe(1);
  });

  it('leaves playbook bodies that start with a paragraph unchanged', async () => {
    process.env.SYNTAUR_HOME = home;
    await writePlaybook('plain-body', 'Plain Body', 'Start with prose.\n\nMore text.');
    const result = await buildPromptContext({ root: home, cwd, sessionId: SESSION_ID });
    expect(result.text).toContain('### Plain Body');
    expect(result.text).toContain('Start with prose.');
  });

  it('prints ticket block with stage instructions, Next and bytes', async () => {
    process.env.SYNTAUR_HOME = home;
    await writeFeatureTicket('SCR-9', 'planning');
    seedEngagement('SCR-9', 'planning');

    const result = await buildPromptContext({
      root: home,
      cwd,
      sessionId: SESSION_ID,
    });

    expect(result.ticketId).toBe('SCR-9');
    expect(result.stage).toBe('planning');
    expect(result.text).toContain('# Syntaur');
    expect(result.text).toContain('Ticket: SCR-9 · Feature ticket · feature · stage: planning');
    expect(result.text).toContain('Stage instructions:');
    expect(result.text).toContain('Read before you plan, in order:');
    expect(result.text).toContain('Next:');
    expect(result.bytes).toBe(Buffer.byteLength(result.text, 'utf8'));
    expect(result.bytes).toBeGreaterThan(0);

    const manifest = await loadTemplate(home, 'feature');
    const planning = manifest.stages.find((s) => s.id === 'planning');
    expect(result.text).toContain(planning!.instructions.trim());
  });

  it('with no engagement prints only the playbook section', async () => {
    process.env.SYNTAUR_HOME = home;
    resetSessionDb();
    initSessionDb(resolve(home, 'syntaur.db'));
    closeSessionDb();

    const result = await buildPromptContext({
      root: home,
      cwd,
      sessionId: SESSION_ID,
    });

    expect(result.ticketId).toBeNull();
    expect(result.text).not.toContain('Ticket:');
    expect(result.text).toContain('## Playbooks');
    expect(result.text).toContain('### Commit Discipline');
    expect(result.text).toContain('### Test Before Done');
  });

  it('with an unregistered session id prints only playbooks', async () => {
    process.env.SYNTAUR_HOME = home;
    const result = await buildPromptContext({
      root: home,
      cwd,
      sessionId: 'unknown-session',
    });
    expect(result.text).not.toContain('Ticket:');
    expect(result.text).toContain('## Playbooks');
  });

  it('excludes disabled playbooks', async () => {
    process.env.SYNTAUR_HOME = home;
    await writeFile(
      resolve(home, 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(home, 'projects')}\nplaybooks:\n  disabled:\n    - test-before-done\n---\n`,
    );

    const result = await buildPromptContext({ root: home, cwd, sessionId: SESSION_ID });
    expect(result.text).toContain('### Commit Discipline');
    expect(result.text).not.toContain('### Test Before Done');
  });

  it('excludes playbooks claimed by a home template', async () => {
    process.env.SYNTAUR_HOME = home;
    const customDir = resolve(home, 'templates', 'custom');
    await mkdir(customDir, { recursive: true });
    await writeFile(
      resolve(customDir, 'template.md'),
      `---\nid: custom\nversion: 1\ndescription: custom\nwhenToUse: test\nplaybooks:\n  - commit-discipline\nstages:\n  - id: backlog\n    instructions: go\n  - id: done\n    instructions: done\nfiles: []\ngates:\n  done: []\n---\n`,
    );

    const result = await buildPromptContext({ root: home, cwd, sessionId: SESSION_ID });
    expect(result.text).not.toContain('### Commit Discipline');
    expect(result.text).toContain('### Test Before Done');
  });

  it('renders off-template stage without instructions line', async () => {
    process.env.SYNTAUR_HOME = home;
    const ticketDir = resolve(home, 'projects', 'scratch', 'tickets', 'SCR-10-quick');
    await mkdir(ticketDir, { recursive: true });
    await writeFile(
      resolve(home, 'projects', 'scratch', 'project.md'),
      `---\nslug: scratch\ntitle: scratch\nprefix: SCR\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n`,
    );
    await writeFile(
      resolve(ticketDir, 'ticket.md'),
      `---\nid: SCR-10\nslug: quick\ntitle: Quick one\nproject: scratch\ntemplate: quick\nstatus: in_progress\ncreated: "2026-01-01"\nupdated: "2026-01-01"\n---\n# Quick\n`,
    );
    seedEngagement('SCR-10', 'in_progress');

    const result = await buildPromptContext({
      root: home,
      cwd,
      sessionId: SESSION_ID,
    });

    expect(result.text).toContain('Stage: in_progress (not declared by template quick)');
    expect(result.text).not.toContain('Stage instructions:');
  });

  it('renders dropped stage without instructions line', async () => {
    process.env.SYNTAUR_HOME = home;
    await writeFeatureTicket('SCR-11', 'dropped', 'Dropped ticket');
    seedEngagement('SCR-11', 'dropped');

    const result = await buildPromptContext({
      root: home,
      cwd,
      sessionId: SESSION_ID,
    });

    expect(result.text).toContain('stage: dropped');
    expect(result.text).not.toContain('Stage instructions:');
    expect(result.text).not.toContain('not declared by template');
  });
});

describe('rowToBinding', () => {
  it('maps engagement row fields', () => {
    const row = {
      id: 1,
      session_id: SESSION_ID,
      ticket_id: 'SCR-1',
      stage: 'planning',
      started_at: '2026-01-01T00:00:00Z',
      ended_at: null,
      tokens_at_open: null,
      tokens_at_close: null,
      close_reason: null,
    } satisfies EngagementRow;
    expect(rowToBinding(row)).toEqual({
      ticketId: 'SCR-1',
      projectSlug: null,
      ticketSlug: null,
      stage: 'planning',
    });
  });
});

describe('syntaur session context CLI', () => {
  it('respects SYNTAUR_HOME', async () => {
    await writeFeatureTicket('SCR-12', 'backlog');
    seedEngagement('SCR-12', 'backlog');

    const res = await runCli(
      ['session', 'context', '--session-id', SESSION_ID, '--cwd', cwd],
      home,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Ticket: SCR-12');
    expect(res.stdout).toContain('stage: backlog');
  });

  it('text mode exits 1 with stderr when the engagement ticket directory is missing', async () => {
    await writeFeatureTicket('SCR-99', 'planning');
    seedEngagement('SCR-99', 'planning');
    const ticketDir = resolve(home, 'projects', 'scratch', 'tickets', 'SCR-99-feat');
    await rm(ticketDir, { recursive: true, force: true });

    const res = await runCli(
      ['session', 'context', '--session-id', SESSION_ID, '--cwd', cwd],
      home,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('missing ticket');
    expect(res.stdout.trim()).toBe('');
  });

  it('hook mode swallows the missing-ticket error and exits 0 with no output', async () => {
    await writeFeatureTicket('SCR-100', 'planning');
    seedEngagement('SCR-100', 'planning');
    const ticketDir = resolve(home, 'projects', 'scratch', 'tickets', 'SCR-100-feat');
    await rm(ticketDir, { recursive: true, force: true });

    const payload = JSON.stringify({
      session_id: SESSION_ID,
      cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hi',
    });
    const res = await runCli(['session', 'context', '--from-hook'], home, payload);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('');
    expect(res.stderr.trim()).toBe('');
  });

  it('emits hook JSON with UserPromptSubmit event name', async () => {
    await writeFeatureTicket('SCR-13', 'planning');
    seedEngagement('SCR-13', 'planning');

    const payload = JSON.stringify({
      session_id: SESSION_ID,
      cwd,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hi',
    });
    const res = await runCli(['session', 'context', '--from-hook'], home, payload);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout.trim()) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Ticket: SCR-13');
  });

  it('prints nothing and exits 0 on garbage stdin with --from-hook', async () => {
    const res = await runCli(['session', 'context', '--from-hook'], home, 'not json');
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });
});

describe('runSessionContext', () => {
  it('returns null on garbage hook stdin', async () => {
    process.env.SYNTAUR_HOME = home;
    const result = await runSessionContext('not json', { cwd, fromHook: true });
    expect(result).toBeNull();
  });
});

describe('HOOK_ENTRIES', () => {
  it('lists three events with one entry each, timeout 5, expected script names', () => {
    expect(HOOK_ENTRIES).toHaveLength(3);
    for (const entry of HOOK_ENTRIES) {
      expect(entry.timeout).toBe(5);
      expect(entry.script).toMatch(/\.sh$/);
    }
    const scripts = HOOK_ENTRIES.map((e) => e.script);
    expect(scripts).toContain('session-start.sh');
    expect(scripts).toContain('session-touch.sh');
    expect(scripts).toContain('prompt-context.sh');
  });
});

describe('runSessionContext touch', () => {
  it('advances updated_at for a registered session', async () => {
    process.env.SYNTAUR_HOME = home;
    initSessionDb();
    const sessionId = 'sess-touch-context';
    await appendSession('', {
      sessionId,
      agent: 'claude',
      status: 'active',
      path: cwd,
      started: new Date().toISOString(),
      projectSlug: null,
      ticketSlug: null,
      ticketId: null,
    });
    getSessionDb()
      .prepare("UPDATE sessions SET updated_at = datetime('now', '-1 hour') WHERE session_id = ?")
      .run(sessionId);
    const before = getSessionDb()
      .prepare('SELECT updated_at FROM sessions WHERE session_id = ?')
      .get(sessionId) as { updated_at: string };
    await runSessionContext(JSON.stringify({ session_id: sessionId, cwd }), {
      cwd,
      fromHook: true,
    });
    const after = getSessionDb()
      .prepare('SELECT updated_at FROM sessions WHERE session_id = ?')
      .get(sessionId) as { updated_at: string };
    expect(after.updated_at).not.toBe(before.updated_at);
  });

  it('does not touch unsafe session ids', async () => {
    process.env.SYNTAUR_HOME = home;
    initSessionDb();
    await runSessionContext(JSON.stringify({ session_id: '../evil', cwd }), {
      cwd,
      fromHook: true,
    });
    const count = getSessionDb().prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('advances updated_at when session id comes from context.json', async () => {
    process.env.SYNTAUR_HOME = home;
    initSessionDb();
    const sessionId = 'sess-context-file';
    await appendSession('', {
      sessionId,
      agent: 'claude',
      status: 'active',
      path: cwd,
      started: new Date().toISOString(),
      projectSlug: null,
      ticketSlug: null,
      ticketId: null,
    });
    await mkdir(resolve(cwd, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(cwd, '.syntaur', 'context.json'),
      JSON.stringify({ sessionId }),
      'utf-8',
    );
    getSessionDb()
      .prepare("UPDATE sessions SET updated_at = datetime('now', '-1 hour') WHERE session_id = ?")
      .run(sessionId);
    const before = getSessionDb()
      .prepare('SELECT updated_at FROM sessions WHERE session_id = ?')
      .get(sessionId) as { updated_at: string };

    const result = await runSessionContext(
      JSON.stringify({ cwd, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
      { cwd, fromHook: true },
    );
    expect(result).not.toBeNull();
    expect(result!.text).toContain('## Playbooks');

    const after = getSessionDb()
      .prepare('SELECT updated_at FROM sessions WHERE session_id = ?')
      .get(sessionId) as { updated_at: string };
    expect(after.updated_at).not.toBe(before.updated_at);
  });
});
