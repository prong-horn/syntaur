import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { formatDispatchLines, registerVerbCommands } from '../commands/verbs.js';

describe('formatDispatchLines', () => {
  it('prints queued dispatch with cancel curl when port is known', () => {
    expect(formatDispatchLines('FE-1', { state: 'queued', requestId: 'auto~abc' }, 8080)).toEqual([
      'Dispatch: queued (auto~abc)',
      'Cancel: curl -s -X POST http://127.0.0.1:8080/api/tickets/FE-1/dispatch/auto~abc/cancel',
    ]);
  });

  it('prints queued dispatch with dashboard fallback when port is missing', () => {
    expect(formatDispatchLines('FE-1', { state: 'queued', requestId: 'auto~abc' }, null)).toEqual([
      'Dispatch: queued (auto~abc)',
      'Cancel: POST /api/tickets/FE-1/dispatch/auto~abc/cancel on the dashboard',
    ]);
  });

  it('prints suppressed dispatch line', () => {
    expect(formatDispatchLines('FE-1', { state: 'suppressed' }, null)).toEqual([
      'Dispatch: suppressed (--no-dispatch); hand off manually when ready',
    ]);
  });

  it('keeps existing states unchanged', () => {
    expect(formatDispatchLines('FE-1', { state: 'skipped' }, null)).toEqual([
      'Dispatch: manual handoff required',
    ]);
    expect(formatDispatchLines('FE-1', { state: 'offline', warning: 'down' }, null)).toEqual([
      'Dispatch: offline — down',
    ]);
    expect(formatDispatchLines('FE-1', { state: 'failed', error: 'nope' }, null)).toEqual([
      'Dispatch: failed — nope',
    ]);
  });
});

describe('registerVerbCommands --no-dispatch', () => {
  function optionNames(commandName: string): string[] {
    const program = new Command();
    registerVerbCommands(program);
    const cmd = program.commands.find((c) => c.name() === commandName);
    if (!cmd) throw new Error(`missing command ${commandName}`);
    return cmd.options.map((o) => o.long);
  }

  it('declares --no-dispatch on stage-changing move verbs only', () => {
    for (const name of ['approve', 'start', 'review', 'done', 'drop', 'reopen']) {
      expect(optionNames(name)).toContain('--no-dispatch');
    }
    for (const name of ['block', 'unblock', 'park', 'unpark']) {
      expect(optionNames(name)).not.toContain('--no-dispatch');
    }
  });

  it('parses start --no-dispatch to dispatch false', () => {
    const program = new Command();
    registerVerbCommands(program);
    const start = program.commands.find((c) => c.name() === 'start');
    expect(start).toBeDefined();
    start!.exitOverride();
    start!.parse(['FE-1', '--no-dispatch'], { from: 'user' });
    expect(start!.opts()).toMatchObject({ dispatch: false });
  });
});
