import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDashboardHelp, getHelpCommandNames } from '../dashboard/help.js';

describe('dashboard help contract', () => {
  it('only documents commands that exist in src/index.ts', async () => {
    const indexSource = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf-8');
    const projectSource = await readFile(resolve(process.cwd(), 'src/commands/project.ts'), 'utf-8');
    const commands = getHelpCommandNames();

    for (const command of commands) {
      if (command.startsWith('project ')) {
        const sub = command.slice('project '.length);
        expect(projectSource).toContain(`.command('${sub}')`);
      } else {
        expect(indexSource).toContain(`.command('${command}')`);
      }
    }
  });

  it('does not advertise speculative rebuild behavior', async () => {
    const help = await getDashboardHelp();
    expect(help.commands.some((command) => command.command.includes('rebuild'))).toBe(false);
  });
});
