import { describe, it, expect } from 'vitest';
import { serversDir } from '../utils/paths.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

describe('serversDir', () => {
  it('returns ~/.syntaur/servers', () => {
    expect(serversDir()).toBe(resolve(homedir(), '.syntaur', 'servers'));
  });
});
