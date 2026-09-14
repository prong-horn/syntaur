import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getDashboardHelp, getHelpCommandNames } from '../dashboard/help.js';

describe('dashboard help contract', () => {
  it('only documents commands that exist in src/index.ts', async () => {
    const indexSource = await readFile(resolve(process.cwd(), 'src/index.ts'), 'utf-8');
    const projectSource = await readFile(resolve(process.cwd(), 'src/commands/project.ts'), 'utf-8');
    const verbsSource = await readFile(resolve(process.cwd(), 'src/commands/verbs.ts'), 'utf-8');
    const planSource = await readFile(resolve(process.cwd(), 'src/commands/plan.ts'), 'utf-8');
    const commands = getHelpCommandNames();

    const VERB_COMMANDS = new Set([
      'approve',
      'unapprove',
      'start',
      'review',
      'done',
      'drop',
      'reopen',
      'block',
      'unblock',
      'park',
      'unpark',
    ]);

    for (const command of commands) {
      if (command.startsWith('project ')) {
        const sub = command.slice('project '.length);
        expect(projectSource).toContain(`.command('${sub}')`);
      } else if (command === 'plan') {
        expect(indexSource).toContain(`addCommand(planCommand)`);
      } else if (VERB_COMMANDS.has(command)) {
        expect(verbsSource).toContain(`.command('${command}')`);
      } else {
        expect(indexSource).toContain(`.command('${command}')`);
      }
    }
  });

  it('does not advertise speculative rebuild behavior', async () => {
    const help = await getDashboardHelp();
    expect(help.commands.some((command) => command.command.includes('rebuild'))).toBe(false);
  });

  it('documents v2 lifecycle verbs and fixed stages in the FAQ', async () => {
    const help = await getDashboardHelp();
    const statusAnswer = help.faq.find((item) => item.question.includes("change a ticket's status"));
    expect(statusAnswer?.answer).toContain('syntaur plan create');
    expect(statusAnswer?.answer).toContain('backlog');
    expect(statusAnswer?.answer).not.toContain('Override Status');
    expect(statusAnswer?.answer).not.toContain('syntaur complete');

    const settingsNav = help.navigation.find((item) => item.label === 'Settings');
    expect(settingsNav?.description).not.toContain('status definitions');

    const planCmd = help.commands.find((command) => command.command === 'syntaur plan');
    expect(planCmd?.example).toContain('plan create');

    const backlogFaq = help.faq.find((item) => item.question.includes('stay in backlog'));
    expect(backlogFaq?.answer).toContain('depends_on');
    expect(backlogFaq?.answer).not.toContain('pending even');

    const blockCmd = help.commands.find((command) => command.command === 'syntaur block');
    const parkCmd = help.commands.find((command) => command.command === 'syntaur park');
    expect(blockCmd?.example).toContain('UI-1 "Waiting on API spec"');
    expect(blockCmd?.example).not.toContain('--reason');
    expect(parkCmd?.example).toContain('UI-1 "Waiting on design"');
    expect(parkCmd?.example).not.toContain('--reason');
  });
});
