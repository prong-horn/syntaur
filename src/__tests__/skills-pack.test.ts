import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SKILLS_DIR = join(REPO_ROOT, 'skills');

const EXPECTED_SKILLS = ['done', 'grab', 'log', 'plan', 'syntaur-protocol', 'worktree'] as const;

/** Registered `syntaur <verb> [<sub>]` forms skills may reference (Decision 2). */
const ALLOWED_COMMANDS = [
  'hooks install',
  'hooks uninstall',
  'statusline install',
  'statusline configure',
  'statusline uninstall',
  'plan create',
  'plan version',
  'workspace set',
  'worktree create',
  'worktree list',
  'worktree remove',
  'session register',
  'session touch',
  'session stop',
  'session context',
  'session resume',
  'session resolve-id',
  'track-session',
  'init',
  'new',
  'rename',
  'show',
  'log',
  'approve',
  'start',
  'review',
  'done',
  'drop',
  'reopen',
  'block',
  'unblock',
  'park',
  'unpark',
  'assign',
  'unassign',
  'archive',
  'restore',
  'dashboard',
  'doctor',
  'update',
] as const;

const COMMAND_FLAGS: Record<string, readonly string[]> = {
  init: ['--force'],
  new: [
    '--project',
    '--slug',
    '--priority',
    '-t',
    '--template',
    '--depends-on',
    '--links',
    '--dir',
  ],
  rename: ['--dir'],
  show: ['--project', '--json', '--log', '-t', '--type'],
  log: [
    '-t',
    '--type',
    '--project',
    '--agent',
    '--verdict',
    '--open',
    '--answers',
    '--attach',
  ],
  'plan create': ['--ticket', '--project', '--dir', '--by', '--force'],
  'plan version': ['--ticket', '--project', '--dir', '--by', '--force'],
  approve: ['--force', '--by', '--project'],
  start: ['--force', '--by', '--project', '--agent'],
  review: ['--force', '--by', '--project'],
  done: ['--force', '--by', '--project'],
  drop: ['--force', '--by', '--project'],
  reopen: ['--force', '--by', '--project'],
  block: ['--force', '--by', '--project'],
  unblock: ['--force', '--by', '--project'],
  park: ['--force', '--by', '--project'],
  unpark: ['--force', '--by', '--project'],
  'workspace set': [
    '--repository',
    '--worktree-path',
    '--branch',
    '--parent-branch',
    '--ticket',
    '--project',
  ],
  'worktree create': [
    '--branch',
    '--repository',
    '--parent-branch',
    '--ticket',
    '--project',
    '--worktree-path',
  ],
  'worktree list': ['--repository', '--json'],
  'worktree remove': [
    '--ticket',
    '--project',
    '--repository',
    '--delete-branch',
    '--force',
    '--yes',
  ],
  assign: ['--project', '--agent', '--dir'],
  unassign: ['--project', '--dir'],
  archive: ['--reason', '--dir'],
  restore: ['--dir'],
  'track-session': [
    '--project',
    '--ticket',
    '--agent',
    '--session-id',
    '--transcript-path',
    '--path',
    '--dir',
    '--description',
  ],
  'session register': ['--from-hook', '--agent'],
  'session touch': ['--from-hook', '--session-id'],
  'session stop': ['--from-hook'],
  'session context': ['--from-hook', '--session-id', '--cwd'],
  'session resume': ['--json'],
  'session resolve-id': ['--cwd'],
  dashboard: ['--port', '--dev', '--server-only', '--api-only', '--no-open'],
  doctor: ['--json', '--fix', '--only', '--verbose'],
  update: ['--version', '--check', '--dry-run', '--skip-refresh', '--pm', '--yes'],
  'hooks install': [],
  'hooks uninstall': [],
  'statusline install': ['--mode', '--link'],
  'statusline uninstall': ['--keep-script'],
  'statusline configure': ['--preset', '--segments', '--separator', '--wrap', '--preview'],
};

const ALLOWED_SORTED = [...ALLOWED_COMMANDS].sort((a, b) => b.length - a.length);

function skillBody(md: string): string {
  const end = md.indexOf('---', 3);
  return end >= 0 ? md.slice(end + 3) : md;
}

function parseFrontmatterDescription(md: string): string {
  const m = md.match(/^description:\s*>-\s*\n((?:\s+.+\n?)+)/m);
  if (m) return m[1].replace(/^\s+/gm, '').replace(/\n/g, ' ').trim();
  const inline = md.match(/^description:\s*(.+)$/m);
  return inline?.[1]?.trim() ?? '';
}

function resolveCommand(rest: string): string | null {
  const tryRests = [rest];
  const tick = rest.indexOf('`');
  if (tick >= 0) tryRests.push(rest.slice(0, tick));
  for (const candidate of tryRests) {
    for (const cmd of ALLOWED_SORTED) {
      if (candidate === cmd || candidate.startsWith(`${cmd} `) || candidate.startsWith(`${cmd}\t`)) {
        return cmd;
      }
    }
  }
  return null;
}

function extractFlagsAfterCommand(line: string, cmd: string): string[] {
  const idx = line.indexOf(`syntaur ${cmd}`);
  if (idx < 0) return [];
  const tail = line.slice(idx + `syntaur ${cmd}`.length);
  const flags: string[] = [];
  for (const m of tail.matchAll(/(--[\w-]+)/g)) {
    flags.push(m[1]);
  }
  return flags;
}

/** Every `syntaur …` reference in the skill body (1-based line numbers). */
function findAllSyntaurRefs(
  body: string,
): { lineNo: number; line: string; rest: string; cmd: string | null }[] {
  const out: { lineNo: number; line: string; rest: string; cmd: string | null }[] = [];
  const lines = body.split('\n');
  for (let lineNo = 1; lineNo <= lines.length; lineNo++) {
    const line = lines[lineNo - 1];
    let pos = 0;
    while (true) {
      const i = line.indexOf('syntaur ', pos);
      if (i < 0) break;
      const rest = line.slice(i + 'syntaur '.length);
      out.push({ lineNo, line, rest, cmd: resolveCommand(rest) });
      pos = i + 8;
    }
  }
  return out;
}

function findSyntaurInvocations(body: string): { cmd: string; line: string }[] {
  return findAllSyntaurRefs(body)
    .filter((r) => r.cmd !== null)
    .map((r) => ({ cmd: r.cmd!, line: r.line }));
}

describe('skills pack', () => {
  it('has six directories with matching frontmatter', async () => {
    const dirs = (await readdir(SKILLS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([...EXPECTED_SKILLS].sort());

    for (const name of EXPECTED_SKILLS) {
      const md = await readFile(join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8');
      const nameMatch = md.match(/^name:\s*(\S+)\s*$/m);
      expect(nameMatch?.[1]).toBe(name);
      const desc = parseFrontmatterDescription(md);
      expect(desc.length).toBeGreaterThan(0);
      expect(desc.length).toBeLessThanOrEqual(1024);
      expect(md).toMatch(/metadata:\s*\n\s+author:\s*prong-horn/);
      expect(md).toMatch(/version:\s*"3\.0\.0"/);
    }
  });

  it('only references registered syntaur commands and flags', async () => {
    for (const name of EXPECTED_SKILLS) {
      const md = await readFile(join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8');
      const body = skillBody(md);
      for (const ref of findAllSyntaurRefs(body)) {
        expect(
          ref.cmd,
          `${name}:${ref.lineNo}: unregistered syntaur verb in \`${ref.line.trim()}\``,
        ).not.toBeNull();
      }
      for (const { cmd, line } of findSyntaurInvocations(body)) {
        expect(ALLOWED_COMMANDS as readonly string[]).toContain(cmd);
        const allowedFlags = new Set(COMMAND_FLAGS[cmd] ?? []);
        for (const flag of extractFlagsAfterCommand(line, cmd)) {
          expect(allowedFlags.has(flag), `${name}: ${cmd} uses unknown flag ${flag}`).toBe(true);
        }
      }
    }
  });

  it('build-skills-index emits six entries with digests', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'syntaur-pack-index-'));
    try {
      execFileSync('node', ['scripts/build-skills-index.mjs', '--out-dir', outDir], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });
      const index = JSON.parse(await readFile(join(outDir, 'index.json'), 'utf-8'));
      expect(index.skills).toHaveLength(6);
      for (const s of index.skills) {
        expect(s.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        const bytes = await readFile(join(outDir, s.url));
        const got = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        expect(got).toBe(s.digest);
      }
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
