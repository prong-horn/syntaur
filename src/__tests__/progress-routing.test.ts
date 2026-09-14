import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appendProgressLog } from '../lifecycle/progress-append.js';
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

  it('quick template refuses and does not create progress.md', async () => {
    await writeFile(
      join(ticketDir, 'ticket.md'),
      `---
id: Q-1
slug: q
template: quick
status: draft
---
# Q
`,
    );
    await expect(
      appendProgressLog({
        ticketDir,
        ticketRef: 'q',
        text: 'Nope',
        author: 'human',
      }),
    ).rejects.toThrow(/has no log role/);
    expect(await fileExists(join(ticketDir, 'progress.md'))).toBe(false);
  });
});
