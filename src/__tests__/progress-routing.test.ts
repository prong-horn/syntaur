import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendProgressLog } from '../lifecycle/log-append.js';
import { runLog } from '../commands/log.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { fileExists } from '../utils/fs.js';

let home: string;
let ticketDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'progress-routing-'));
  process.env.SYNTAUR_HOME = home;
  await seedMissingBuiltins(home);
  ticketDir = join(home, 'ticket');
  await mkdir(ticketDir, { recursive: true });
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('appendProgressLog routing', () => {
  it('without ticket.md keeps legacy progress.md format', async () => {
    const { path } = await appendProgressLog({
      ticketDir,
      ticketRef: 'demo',
      text: 'Legacy path',
      author: 'human',
    });
    expect(path).toContain('progress.md');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('# Progress');
    expect(content).toContain('Legacy path');
  });

  it('feature template appends §4.2 journal entries with author', async () => {
    await writeFile(
      join(ticketDir, 'ticket.md'),
      `---
id: F-1
slug: feat
template: feature
status: in_progress
---
# Feat
`,
    );
    const { path } = await appendProgressLog({
      ticketDir,
      ticketRef: 'feat',
      text: 'Did work',
      author: 'cursor',
    });
    expect(path).toContain('journal.md');
    const content = await readFile(path, 'utf-8');
    expect(content).toContain('## ');
    expect(content).toContain('· progress · cursor');
    expect(content).toContain('purpose:');
    expect(content).toContain('Did work');
  });

  it('quick template appends a chat note via runLog', async () => {
    const quickDir = resolve(home, 'projects', 's', 'tickets', 'SCR-2-q');
    await mkdir(quickDir, { recursive: true });
    await mkdir(resolve(home, 'projects', 's'), { recursive: true });
    await writeFile(
      resolve(home, 'projects', 's', 'project.md'),
      '---\nslug: s\ntitle: S\nprefix: SCR\nnextTicket: 3\n---\n',
    );
    await writeFile(
      join(quickDir, 'ticket.md'),
      `---
id: SCR-2
slug: q
template: quick
status: draft
---
# Q
`,
    );
    const message = await runLog('SCR-2', 'Quick note', { type: 'progress', project: 's' });
    expect(message).toContain('Logged note to chat');
    expect(await fileExists(join(quickDir, 'chat', 'events.jsonl'))).toBe(true);
    expect(await fileExists(join(quickDir, 'progress.md'))).toBe(false);
  });
});
