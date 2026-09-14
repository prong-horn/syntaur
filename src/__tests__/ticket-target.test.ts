import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { resolveTicketTarget, TicketTargetError } from '../utils/ticket-target.js';

let originalHome: string | undefined;
let tmpRoot: string;
let projectsDir: string;
let cwdRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'syntaur-ticket-target-'));
  projectsDir = resolve(tmpRoot, 'projects');
  cwdRoot = resolve(tmpRoot, 'cwd');
  await mkdir(projectsDir, { recursive: true });
  await mkdir(cwdRoot, { recursive: true });

  originalHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = tmpRoot;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = originalHome;
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeProject(slug: string, prefix = 'MP'): Promise<void> {
  const dir = resolve(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, 'project.md'),
    [
      '---',
      `id: proj-${slug}`,
      `slug: ${slug}`,
      `title: ${slug}`,
      `prefix: ${prefix}`,
      'nextTicket: 2',
      '---',
      '',
      `# ${slug}`,
      '',
    ].join('\n'),
  );
}

async function writeTicket(
  projectSlug: string,
  folderName: string,
  id: string,
  slug: string,
  extras: Record<string, string> = {},
): Promise<void> {
  const dir = resolve(projectsDir, projectSlug, 'tickets', folderName);
  await mkdir(dir, { recursive: true });
  const lines = [
    '---',
    `id: ${id}`,
    `slug: ${slug}`,
    'title: Example',
    'status: pending',
    'priority: medium',
    'created: "2026-04-20T00:00:00Z"',
    'updated: "2026-04-20T00:00:00Z"',
    ...Object.entries(extras).map(([k, v]) => `${k}: ${v}`),
    '---',
    '',
    '# Example',
    '',
  ];
  await writeFile(resolve(dir, 'ticket.md'), lines.join('\n'));
}

async function writeContextJson(cwd: string, payload: Record<string, unknown>): Promise<void> {
  const dir = resolve(cwd, '.syntaur');
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'context.json'), JSON.stringify(payload, null, 2));
}

describe('resolveTicketTarget', () => {
  it('resolves --project + ticket slug', async () => {
    const projectSlug = 'my-proj';
    const aslug = 'do-thing';
    await writeProject(projectSlug, 'MP');
    await writeTicket(projectSlug, 'MP-1-do-thing', 'MP-1', aslug, { project: projectSlug });

    const resolved = await resolveTicketTarget('MP-1', { project: projectSlug, dir: projectsDir });

    expect(resolved.projectSlug).toBe(projectSlug);
    expect(resolved.ticketSlug).toBe(aslug);
    expect(resolved.standalone).toBe(false);
    expect(resolved.id).toBe('MP-1');
  });

  it('resolves a bare ticket id', async () => {
    await writeProject('scan-proj', 'SP');
    await writeTicket('scan-proj', 'SP-1-scan-task', 'SP-1', 'scan-task', {
      project: 'scan-proj',
    });

    const resolved = await resolveTicketTarget('SP-1', { dir: projectsDir });

    expect(resolved.projectSlug).toBe('scan-proj');
    expect(resolved.ticketSlug).toBe('scan-task');
    expect(resolved.standalone).toBe(false);
    expect(resolved.id).toBe('SP-1');
  });

  it('resolves from the open engagement (project-nested)', async () => {
    const projectSlug = 'eng-proj';
    const aslug = 'eng-task';
    const id = 'EP-1';
    await writeProject(projectSlug, 'EP');
    await writeTicket(projectSlug, 'EP-1-eng-task', id, aslug, { project: projectSlug });

    const resolved = await resolveTicketTarget(undefined, {
      cwd: cwdRoot,
      dir: projectsDir,
      resolveEngagement: async () => ({
        ticketId: id,
        projectSlug,
        ticketSlug: aslug,
        stage: 'plan',
      }),
    });

    expect(resolved.projectSlug).toBe(projectSlug);
    expect(resolved.ticketSlug).toBe(aslug);
    expect(resolved.standalone).toBe(false);
    expect(resolved.id).toBe(id);
    expect(resolved.stage).toBe('plan');
  });

  it('explicit --project + slug takes precedence over the open engagement (seam not consulted)', async () => {
    const projectSlug = 'explicit-proj';
    const aslug = 'explicit-task';
    await writeProject(projectSlug, 'XP');
    await writeTicket(projectSlug, 'XP-1-explicit-task', 'XP-1', aslug, {
      project: projectSlug,
    });

    let called = false;
    const resolved = await resolveTicketTarget('XP-1', { project: projectSlug, dir: projectsDir, resolveEngagement: async () => {
        called = true;
        return { ticketId: 'XP-99', projectSlug: 'other', ticketSlug: 'other', stage: 'plan' };
      },
    });

    expect(resolved.ticketSlug).toBe(aslug);
    expect(called).toBe(false);
  });

  it('throws the selector error when there is no positional and no open engagement', async () => {
    await expect(
      resolveTicketTarget(undefined, {
        cwd: cwdRoot,
        dir: projectsDir,
        resolveEngagement: async () => null,
      }),
    ).rejects.toThrow(/No open engagement/);
  });

  it('throws when no resolveEngagement seam is provided', async () => {
    await expect(
      resolveTicketTarget(undefined, { cwd: cwdRoot, dir: projectsDir }),
    ).rejects.toThrow(TicketTargetError);
  });

  it('throws on invalid project slug', async () => {
    await expect(
      resolveTicketTarget('foo', { project: 'BAD slug!', dir: projectsDir }),
    ).rejects.toThrow(/Invalid project slug/);
  });

  it('throws when --project is given without a positional slug', async () => {
    await expect(
      resolveTicketTarget(undefined, { project: 'some-proj', dir: projectsDir }),
    ).rejects.toThrow(/--project requires/);
  });

  it('throws on missing project', async () => {
    await expect(
      resolveTicketTarget('SCR-1', { project: 'no-such-project', dir: projectsDir }),
    ).rejects.toThrow(/not found/);
  });

  it('throws on invalid ticket id format', async () => {
    await expect(
      resolveTicketTarget('not-a-real-id-xxxx', { dir: projectsDir }),
    ).rejects.toThrow(/not a valid ticket id/);
  });

  it('throws on unknown ticket id', async () => {
    await expect(resolveTicketTarget('SCR-99', { dir: projectsDir })).rejects.toThrow(/not found/);
  });

  it('throws when the open engagement points to a missing ticket', async () => {
    await expect(
      resolveTicketTarget(undefined, {
        cwd: cwdRoot,
        dir: projectsDir,
        resolveEngagement: async () => ({
          ticketId: 'MP-99',
          projectSlug: 'ghost-proj',
          ticketSlug: 'ghost-task',
          stage: 'plan',
        }),
      }),
    ).rejects.toThrow(/missing ticket/);
  });

  it('does not let a workspace-marker-only context.json resolve a ticket', async () => {
    await writeContextJson(cwdRoot, {
      repository: '/repo',
      branch: 'feat/x',
      worktree: '/repo/.worktrees/x',
      sessionId: 'sess-abc',
    });

    await expect(
      resolveTicketTarget(undefined, {
        cwd: cwdRoot,
        dir: projectsDir,
        resolveEngagement: async () => null,
      }),
    ).rejects.toThrow(/No open engagement/);
  });
});
