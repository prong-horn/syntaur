import { describe, expect, it } from 'vitest';
import type { DeriveInput, DerivedState } from '../types.js';
import { genericAdapter } from '../adapters/generic.js';
import { resolveAdapter } from '../adapters/registry.js';

const FIXED_NOW = 1_700_000_000_000;

function input(lines: string[], idle: number): DeriveInput {
  return {
    screen: { lines, cols: 80, rows: 24 },
    hookEvents: [],
    procAlive: true,
    outputIdleMs: idle,
    cwd: '/w',
    nowMs: FIXED_NOW,
  };
}

interface Case {
  name: string;
  lines: string[];
  idle: number;
  expected: DerivedState;
}

const cases: Case[] = [
  {
    name: 'y/n approval, idle',
    lines: ['Overwrite foo.txt? (y/n)'],
    idle: 2000,
    expected: { state: 'blocked', needs: 'confirm (y/n)' },
  },
  {
    name: '[y/N] approval, idle',
    lines: ['Proceed? [y/N]'],
    idle: 5000,
    expected: { state: 'blocked', needs: 'confirm [y/N]' },
  },
  {
    name: 'Allow question',
    lines: ['Allow network access to example.com?'],
    idle: 2000,
    expected: { state: 'blocked', needs: 'approval prompt' },
  },
  {
    name: 'password prompt',
    lines: ['sudo password:'],
    idle: 2000,
    expected: { state: 'blocked', needs: 'password prompt' },
  },
  {
    name: 'bare REPL prompt, long idle',
    lines: ['build done', '', '❯'],
    idle: 10000,
    expected: { state: 'blocked', needs: 'waiting at prompt' },
  },
  {
    name: 'REPL prompt but idle too short',
    lines: ['❯'],
    idle: 9999,
    expected: { state: 'working', needs: null },
  },
  {
    name: 'approval text but idle too short (mid-paint)',
    lines: ['Proceed? [y/N]'],
    idle: 1999,
    expected: { state: 'working', needs: null },
  },
  {
    name: 'FALSE-POSITIVE: (y/n) NOT on the prompt line (compiler echoed it, output continued)',
    lines: ['tests: expect prompt (y/n)', 'PASS 12 suites'],
    idle: 60000,
    expected: { state: 'working', needs: null },
  },
  {
    name: 'FALSE-POSITIVE: spinner',
    lines: ['⠋ Compiling...'],
    idle: 30000,
    expected: { state: 'working', needs: null },
  },
  {
    name: 'FALSE-POSITIVE: > quote-continuation with text after it on later line',
    lines: ['> quoted line', 'more output'],
    idle: 30000,
    expected: { state: 'working', needs: null },
  },
  {
    name: 'blank screen',
    lines: ['', '', ''],
    idle: 60000,
    expected: { state: 'working', needs: null },
  },
];

describe('genericAdapter.deriveState', () => {
  it.each(cases)('$name', ({ lines, idle, expected }) => {
    expect(genericAdapter.deriveState(input(lines, idle))).toEqual(expected);
  });

  it('is deterministic: same input twice yields identical result values', () => {
    const x = input(['Overwrite foo.txt? (y/n)'], 2000);
    const first = genericAdapter.deriveState(x);
    const second = genericAdapter.deriveState(x);
    expect(first).toEqual(second);
  });

  it('registry fallback: unknown agent resolves to the generic adapter', () => {
    expect(resolveAdapter('never-heard-of-it').id).toBe('generic');
  });
});
