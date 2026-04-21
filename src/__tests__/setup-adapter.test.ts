import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupAdapterCommand } from '../commands/setup-adapter.js';

describe('setup-adapter command', () => {
  let tempDir: string;
  let projectDir: string;
  let assignmentDir: string;
  let originalCwd: string;
  let cwdDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'syntaur-test-'));
    projectDir = join(tempDir, 'projects', 'test-project');
    assignmentDir = join(projectDir, 'assignments', 'test-assignment');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(join(projectDir, 'project.md'), '---\ntitle: Test\n---\n');
    await writeFile(join(assignmentDir, 'assignment.md'), '---\nstatus: pending\n---\n');

    cwdDir = join(tempDir, 'workspace');
    await mkdir(cwdDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(cwdDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseOptions = (dir: string) => ({
    project: 'test-project',
    assignment: 'test-assignment',
    dir: join(dir, 'projects'),
  });

  it('generates Cursor adapter files', async () => {
    await setupAdapterCommand('cursor', baseOptions(tempDir));
    const protocolPath = resolve(cwdDir, '.cursor', 'rules', 'syntaur-protocol.mdc');
    const assignmentPath = resolve(cwdDir, '.cursor', 'rules', 'syntaur-assignment.mdc');
    const protocol = await readFile(protocolPath, 'utf-8');
    const assignment = await readFile(assignmentPath, 'utf-8');
    expect(protocol).toContain('alwaysApply: true');
    expect(protocol).toContain('Syntaur Protocol');
    expect(assignment).toContain('test-project');
    expect(assignment).toContain('test-assignment');
  });

  it('generates Codex adapter files', async () => {
    await setupAdapterCommand('codex', baseOptions(tempDir));
    const agentsPath = resolve(cwdDir, 'AGENTS.md');
    const agents = await readFile(agentsPath, 'utf-8');
    expect(agents).toContain('Syntaur Protocol');
    expect(agents).toContain('test-project');
    expect(agents).toContain('test-assignment');
  });

  it('generates OpenCode adapter files', async () => {
    await setupAdapterCommand('opencode', baseOptions(tempDir));
    const agentsPath = resolve(cwdDir, 'AGENTS.md');
    const configPath = resolve(cwdDir, 'opencode.json');
    const agents = await readFile(agentsPath, 'utf-8');
    const config = await readFile(configPath, 'utf-8');
    expect(agents).toContain('Syntaur Protocol');
    expect(() => JSON.parse(config)).not.toThrow();
    expect(JSON.parse(config).instructions).toBeDefined();
  });

  it('skips existing files without --force', async () => {
    const agentsPath = resolve(cwdDir, 'AGENTS.md');
    await writeFile(agentsPath, 'existing content');
    await setupAdapterCommand('codex', baseOptions(tempDir));
    const content = await readFile(agentsPath, 'utf-8');
    expect(content).toBe('existing content');
  });

  it('overwrites existing files with --force', async () => {
    const agentsPath = resolve(cwdDir, 'AGENTS.md');
    await writeFile(agentsPath, 'existing content');
    await setupAdapterCommand('codex', { ...baseOptions(tempDir), force: true });
    const content = await readFile(agentsPath, 'utf-8');
    expect(content).not.toBe('existing content');
    expect(content).toContain('Syntaur Protocol');
  });

  it('throws on invalid framework', async () => {
    await expect(
      setupAdapterCommand('invalid', baseOptions(tempDir)),
    ).rejects.toThrow('Unsupported framework');
  });

  it('throws on missing project', async () => {
    await expect(
      setupAdapterCommand('codex', {
        ...baseOptions(tempDir),
        project: 'nonexistent',
      }),
    ).rejects.toThrow('not found');
  });

  it('throws on missing assignment', async () => {
    await expect(
      setupAdapterCommand('codex', {
        ...baseOptions(tempDir),
        assignment: 'nonexistent',
      }),
    ).rejects.toThrow('not found');
  });
});
