import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createProjectCommand } from '../commands/create-project.js';
import { newCommand } from '../commands/new.js';
import { isTicketId } from '../utils/ticket-ids.js';
import { trackSessionCommand } from '../commands/track-session.js';
import {
  closeSessionDb,
  resetSessionDb,
  getSessionDb,
} from '../dashboard/session-db.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('createProjectCommand', () => {
  it('creates all expected project files', async () => {
    const slug = await createProjectCommand('Test Project', {
      dir: testDir,
    });
    expect(slug).toBe('test-project');

    const projectDir = resolve(testDir, 'test-project');
    const files = await readdir(projectDir);

    expect(files).toContain('project.md');
    expect(files).not.toContain('agent.md');
    expect(files).not.toContain('claude.md');
    expect(files).not.toContain('manifest.md');
    expect(files).not.toContain('_index-tickets.md');
    expect(files).not.toContain('_index-plans.md');
    expect(files).not.toContain('_index-decisions.md');
    expect(files).not.toContain('_status.md');
    expect(files).toContain('tickets');
    expect(files).not.toContain('resources');
    expect(files).not.toContain('memories');
  });

  it('slug in project.md matches folder name', async () => {
    await createProjectCommand('My Great Project', { dir: testDir });
    const content = await readFile(
      resolve(testDir, 'my-great-project', 'project.md'),
      'utf-8',
    );
    expect(content).toContain('slug: my-great-project');
  });

  it('writes prefix, nextTicket, and defaultTemplate in project.md', async () => {
    await createProjectCommand('Fitsync', { slug: 'fitsync', dir: testDir });
    const content = await readFile(resolve(testDir, 'fitsync', 'project.md'), 'utf-8');
    expect(content).toContain('prefix: FIT');
    expect(content).toContain('nextTicket: 1');
    expect(content).toContain('defaultTemplate: feature');
  });

  it('honors --default-template when creating a project', async () => {
    await createProjectCommand('Quick project', {
      slug: 'quick-proj',
      dir: testDir,
      defaultTemplate: 'quick',
    });
    const content = await readFile(resolve(testDir, 'quick-proj', 'project.md'), 'utf-8');
    expect(content).toContain('defaultTemplate: quick');
  });

  it('uses custom slug when provided', async () => {
    const slug = await createProjectCommand('Test', {
      slug: 'custom-slug',
      dir: testDir,
    });
    expect(slug).toBe('custom-slug');
    const files = await readdir(resolve(testDir, 'custom-slug'));
    expect(files).toContain('project.md');
  });

  it('throws if project folder already exists', async () => {
    await createProjectCommand('Test', { dir: testDir });
    await expect(
      createProjectCommand('Test', { dir: testDir }),
    ).rejects.toThrow('already exists');
  });

  it('throws on empty title', async () => {
    await expect(
      createProjectCommand('', { dir: testDir }),
    ).rejects.toThrow('cannot be empty');
  });
});

describe('newCommand', () => {
  it('creates a scratch ticket when --project is omitted', async () => {
    const result = await newCommand('Write Tests', { dir: testDir, silent: true });
    expect(result.projectSlug).toBe('scratch');
    expect(result.id).toBe('SCR-1');
    const ticketDir = resolve(testDir, 'scratch', 'tickets', 'SCR-1-write-tests');
    const content = await readFile(resolve(ticketDir, 'ticket.md'), 'utf-8');
    expect(content).toContain('slug: write-tests');
    expect(content).toContain('id: SCR-1');
    expect(content).toContain('project: scratch');
  });

  it('allocates a per-project ticket id', async () => {
    await createProjectCommand('Fitsync', { slug: 'fitsync', dir: testDir });
    const result = await newCommand('First ticket', {
      project: 'fitsync',
      dir: testDir,
      silent: true,
    });
    expect(result.id).toBe('FIT-1');
    expect(isTicketId(result.id)).toBe(true);
    const content = await readFile(
      resolve(testDir, 'fitsync', 'tickets', 'FIT-1-first-ticket', 'ticket.md'),
      'utf-8',
    );
    expect(content).toContain('id: FIT-1');
  });

  it('writes acceptanceCriteria as checkbox items in ticket.md when option is set', async () => {
    await createProjectCommand('Test Project', { dir: testDir });
    await newCommand('Promoted Task', {
      project: 'test-project',
      dir: testDir,
      silent: true,
      acceptanceCriteria: ['fix the parser', 'add a test'],
    });
    const content = await readFile(
      resolve(testDir, 'test-project', 'tickets', 'TP-1-promoted-task', 'ticket.md'),
      'utf-8',
    );
    expect(content).toContain('## Acceptance Criteria');
    expect(content).toContain('- [ ] fix the parser');
    expect(content).toContain('- [ ] add a test');
    expect(content).not.toContain('<!-- criterion 1 -->');
  });

  it('rejects invalid dependency ids', async () => {
    await createProjectCommand('Test Project', { dir: testDir });
    await expect(
      newCommand('Test', {
        project: 'test-project',
        dir: testDir,
        depends_on_flag: 'not-an-id',
      }),
    ).rejects.toThrow('Invalid dependency id');
  });

  it('creates ticket with --project in specified dir', async () => {
    await createProjectCommand('Test Project', { dir: testDir });
    const dep = await newCommand('Dependency', {
      project: 'test-project',
      dir: testDir,
      silent: true,
    });

    await newCommand('My Task', {
      project: 'test-project',
      dir: testDir,
      priority: 'high',
      depends_on_flag: dep.id,
    });

    const ticketDir = resolve(
      testDir,
      'test-project',
      'tickets',
      'TP-2-my-task',
    );
    const content = await readFile(
      resolve(ticketDir, 'ticket.md'),
      'utf-8',
    );
    expect(content).toContain('status: backlog');
    expect(content).toContain('priority: high');
    expect(content).toContain('depends_on:');
    expect(content).toContain(`  - ${dep.id}`);
  });

  it('uses template defaultPriority when --priority is omitted', async () => {
    await createProjectCommand('Test Project', { dir: testDir });
    const bug = await newCommand('Bug fix', {
      project: 'test-project',
      dir: testDir,
      template: 'bug',
      silent: true,
    });
    const bugMd = await readFile(
      resolve(testDir, 'test-project', 'tickets', `${bug.id}-bug-fix`, 'ticket.md'),
      'utf-8',
    );
    expect(bugMd).toContain('priority: high');

    const quick = await newCommand('Quick chore', {
      project: 'test-project',
      dir: testDir,
      template: 'quick',
      silent: true,
    });
    const quickMd = await readFile(
      resolve(testDir, 'test-project', 'tickets', `${quick.id}-quick-chore`, 'ticket.md'),
      'utf-8',
    );
    expect(quickMd).toContain('priority: low');

    await newCommand('Explicit priority', {
      project: 'test-project',
      dir: testDir,
      template: 'quick',
      priority: 'critical',
      silent: true,
    });
    const explicitMd = await readFile(
      resolve(testDir, 'test-project', 'tickets', 'TP-3-explicit-priority', 'ticket.md'),
      'utf-8',
    );
    expect(explicitMd).toContain('priority: critical');
  });

  it('throws on empty title', async () => {
    await expect(
      newCommand('', { project: 'test' }),
    ).rejects.toThrow('cannot be empty');
  });

  it('throws on invalid project slug', async () => {
    await expect(
      newCommand('Test', {
        project: 'INVALID SLUG!',
        dir: testDir,
      }),
    ).rejects.toThrow('Invalid project slug');
  });

  it('throws on invalid dependency id', async () => {
    await createProjectCommand('Test', { dir: testDir });
    await expect(
      newCommand('Task', {
        project: 'test',
        dir: testDir,
        depends_on_flag: 'TP-1,not-an-id',
      }),
    ).rejects.toThrow('Invalid dependency id');
  });

});

describe('trackSessionCommand required flags', () => {
  it('rejects when sessionId is missing AND self-resolution finds nothing', async () => {
    // --session-id is optional now; the guard fires only when the six-layer
    // resolver also comes up empty (injected here for determinism).
    await expect(
      trackSessionCommand({ agent: 'claude' } as any, {
        resolveSessionId: async () => undefined,
        fallbackPid: () => null,
      }),
    ).rejects.toThrow(/session id/);
  });

  it('rejects when agent is missing', async () => {
    await expect(
      trackSessionCommand({ sessionId: 'real-id' } as any),
    ).rejects.toThrow(/--agent/);
  });
});

describe('trackSessionCommand path resolution', () => {
  beforeEach(() => {
    // Each test gets a fresh DB tied to SYNTAUR_HOME=testDir (set by the
    // top-level beforeEach). resetSessionDb clears the singleton so the next
    // initSessionDb call (inside trackSessionCommand) opens the new path.
    resetSessionDb();
  });

  afterEach(() => {
    closeSessionDb();
  });

  async function readSessionPath(sessionId: string): Promise<string | null> {
    const row = getSessionDb()
      .prepare('SELECT path FROM sessions WHERE session_id = ?')
      .get(sessionId) as { path: string | null } | undefined;
    return row?.path ?? null;
  }

  it('records the launch cwd from the transcript when --transcript-path is supplied, ignoring a stale --path', async () => {
    const transcriptPath = join(testDir, 'sample.jsonl');
    await writeFile(
      transcriptPath,
      JSON.stringify({ type: 'user', cwd: '/Users/me/launch-dir' }) + '\n',
    );

    const sessionId = `cli-${Math.random().toString(36).slice(2, 10)}`;
    await trackSessionCommand({
      agent: 'claude',
      sessionId,
      transcriptPath,
      // Caller's cwd at registration time disagrees with the transcript —
      // common when the agent cd'd into a worktree mid-session. The
      // transcript is authoritative.
      path: '/Users/me/some/worktree',
    });

    expect(await readSessionPath(sessionId)).toBe('/Users/me/launch-dir');
  });

  it('falls back to --path when no --transcript-path is supplied', async () => {
    const sessionId = `cli-${Math.random().toString(36).slice(2, 10)}`;
    await trackSessionCommand({
      agent: 'claude',
      sessionId,
      path: '/Users/me/explicit-path',
    });

    expect(await readSessionPath(sessionId)).toBe('/Users/me/explicit-path');
  });

  it('falls back to --path when the transcript file is missing', async () => {
    const sessionId = `cli-${Math.random().toString(36).slice(2, 10)}`;
    await trackSessionCommand({
      agent: 'claude',
      sessionId,
      transcriptPath: join(testDir, 'does-not-exist.jsonl'),
      path: '/Users/me/fallback',
    });

    expect(await readSessionPath(sessionId)).toBe('/Users/me/fallback');
  });

});

describe('track-session CLI: optional --session-id', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const cliPath = resolve(here, '../../dist/index.js');

  it('exits non-zero with a session-id error when omitted AND unresolvable', async () => {
    if (!existsSync(cliPath)) {
      // Verification plan requires a prior `npm run build`. Fail loudly rather
      // than silently passing so the dev notices.
      throw new Error(
        `dist CLI not found at ${cliPath}. Run \`npm run build\` before the test suite.`,
      );
    }

    // Hermetic env: strip the session-id env vars, point HOME at an empty
    // sandbox (no marker dirs, no transcripts) and run from a cwd with no
    // .syntaur/context.json — all six resolver layers must come up empty.
    const sandbox = await mkdtemp(join(tmpdir(), 'syntaur-cli-track-'));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: sandbox,
        SYNTAUR_HOME: join(sandbox, '.syntaur'),
      };
      delete env.CLAUDE_CODE_SESSION_ID;
      delete env.OPENCODE_SESSION_ID;
      delete env.PI_SESSION_ID;
      delete env.CODEX_HOME;
      delete env.CODEX_SESSIONS_DIR;

      const res = spawnSync(
        'node',
        [cliPath, 'track-session', '--agent', 'claude'],
        { encoding: 'utf-8', cwd: sandbox, env },
      );
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/session id/i);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
