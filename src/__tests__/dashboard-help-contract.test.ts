import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDashboardHelp, getHelpCommandNames } from '../dashboard/help.js';

describe('dashboard help contract', () => {
  it('only documents commands that exist in src/index.ts', async () => {
    const indexSource = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf-8');
    const commands = getHelpCommandNames();

    for (const command of commands) {
      expect(indexSource).toContain(`.command('${command}')`);
    }
  });

  it('does not advertise speculative rebuild behavior', () => {
    const help = getDashboardHelp();
    expect(help.commands.some((command) => command.command.includes('rebuild'))).toBe(false);
  });
});
