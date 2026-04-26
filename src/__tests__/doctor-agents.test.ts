import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runChecks } from '../utils/doctor/index.js';
import { writeAgentsConfig } from '../utils/config.js';

describe('doctor agents checks', () => {
  const originalHome = process.env.HOME;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'syntaur-doctor-agents-'));
    process.env.HOME = homeDir;
    await mkdir(resolve(homeDir, '.syntaur', 'projects'), { recursive: true });
    await writeFile(
      resolve(homeDir, '.syntaur', 'config.md'),
      `---\nversion: "2.0"\ndefaultProjectDir: ${resolve(homeDir, '.syntaur', 'projects')}\n---\n`,
    );
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it('warns when a bare-name agent command is not on PATH', async () => {
    await writeAgentsConfig([
      { id: 'notreal', label: 'Not Real', command: 'definitely-not-a-real-cmd-xyz' },
    ]);
    const report = await runChecks();
    const warn = report.checks.find(
      (c) => c.id === 'agents.resolvable.notreal' && c.status === 'warn',
    );
    expect(warn).toBeTruthy();
    expect(warn?.detail).toMatch(/not found on PATH/);
  });

  it('warns when an absolute command does not exist', async () => {
    await writeAgentsConfig([
      { id: 'gone', label: 'Gone', command: '/tmp/__does-not-exist__' },
    ]);
    const report = await runChecks();
    const warn = report.checks.find(
      (c) => c.id === 'agents.resolvable.gone' && c.status === 'warn',
    );
    expect(warn).toBeTruthy();
    expect(warn?.detail).toMatch(/does not exist/);
  });

  it('warns when an absolute command exists but is not executable (EACCES)', async () => {
    const { writeFile, chmod } = await import('node:fs/promises');
    const path = resolve(homeDir, 'not-executable');
    await writeFile(path, '#!/bin/sh\necho hi\n');
    await chmod(path, 0o644); // readable but not executable
    await writeAgentsConfig([
      { id: 'noexec', label: 'NoExec', command: path },
    ]);
    const report = await runChecks();
    const warn = report.checks.find(
      (c) => c.id === 'agents.resolvable.noexec' && c.status === 'warn',
    );
    expect(warn).toBeTruthy();
    expect(warn?.detail).toMatch(/not executable/);
  });

  it('passes when shell-alias resolution is enabled', async () => {
    await writeAgentsConfig([
      {
        id: 'aliased',
        label: 'Aliased',
        command: 'c',
        resolveFromShellAliases: true,
      },
    ]);
    const report = await runChecks();
    const pass = report.checks.find(
      (c) => c.id === 'agents.resolvable.aliased' && c.status === 'pass',
    );
    expect(pass).toBeTruthy();
    expect(pass?.detail).toMatch(/shell-alias/);
  });
});
