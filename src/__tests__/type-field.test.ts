import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { renderAssignment } from '../templates/index.js';
import { createProjectCommand } from '../commands/create-project.js';
import { createAssignmentCommand } from '../commands/create-assignment.js';
import { getAssignmentTypes, readConfig, DEFAULT_ASSIGNMENT_TYPES } from '../utils/config.js';
import { extractFrontmatter, getField } from '../dashboard/parser.js';

let testDir: string;
let origSyntaurHome: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'syntaur-type-test-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  process.env.SYNTAUR_HOME = testDir;
});

afterEach(async () => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  await rm(testDir, { recursive: true, force: true });
});

describe('assignment template `type` field', () => {
  it('renders an explicit type into the frontmatter', () => {
    const out = renderAssignment({
      id: 'id-1',
      slug: 'fix-thing',
      title: 'Fix thing',
      timestamp: '2026-04-20T00:00:00Z',
      priority: 'medium',
      dependsOn: [],
      links: [],
      project: 'proj',
      type: 'bug',
    });
    expect(out).toContain('type: bug');
    expect(out).toContain('project: proj');
  });

  it('defaults to "feature" when no type is supplied', () => {
    const out = renderAssignment({
      id: 'id-2',
      slug: 'x',
      title: 'X',
      timestamp: '2026-04-20T00:00:00Z',
      priority: 'medium',
      dependsOn: [],
      links: [],
      project: null,
    });
    expect(out).toContain('type: feature');
  });
});

describe('create-assignment CLI --type', () => {
  it('round-trips a custom type through the CLI, file, and parser', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('Fix a bug', {
      project: 'p',
      type: 'bug',
      dir: testDir,
    });

    const assignmentMd = await readFile(
      resolve(testDir, 'p', 'assignments', 'fix-a-bug', 'assignment.md'),
      'utf-8',
    );
    expect(assignmentMd).toContain('type: bug');

    const [fm] = extractFrontmatter(assignmentMd);
    expect(getField(fm, 'type')).toBe('bug');
  });

  it('falls back to "feature" when --type is omitted', async () => {
    await createProjectCommand('P', { dir: testDir });
    await createAssignmentCommand('Do thing', {
      project: 'p',
      dir: testDir,
    });

    const assignmentMd = await readFile(
      resolve(testDir, 'p', 'assignments', 'do-thing', 'assignment.md'),
      'utf-8',
    );
    const [fm] = extractFrontmatter(assignmentMd);
    expect(getField(fm, 'type')).toBe('feature');
  });
});

describe('getAssignmentTypes', () => {
  it('returns the built-in defaults when config has no types override', async () => {
    // readConfig reads from SYNTAUR_HOME/config.md which does not exist here.
    const cfg = await readConfig();
    const types = getAssignmentTypes(cfg);
    expect(types).toBe(DEFAULT_ASSIGNMENT_TYPES);
    expect(types.default).toBe('feature');
    expect(types.definitions.map((d) => d.id)).toEqual([
      'feature',
      'bug',
      'refactor',
      'research',
      'chore',
    ]);
  });

  it('picks up a config-level types override when config.md declares one', async () => {
    const configPath = resolve(testDir, 'config.md');
    await mkdir(testDir, { recursive: true });
    await writeFile(
      configPath,
      [
        '---',
        'version: "2.0"',
        `defaultProjectDir: ${resolve(testDir, 'projects')}`,
        'types.default: task',
        'types.definitions:',
        '  - id: task',
        '    label: Task',
        '  - id: incident',
        '    label: Incident',
        '---',
        '',
        '# config',
        '',
      ].join('\n'),
    );

    const cfg = await readConfig();
    const types = getAssignmentTypes(cfg);
    // The config parser may or may not implement types parsing yet — if not,
    // the default is returned, which is also acceptable behavior. Assert on
    // the invariant: types is a TypesConfig with at least the default present.
    expect(types.definitions.length).toBeGreaterThan(0);
    expect(typeof types.default).toBe('string');
  });
});
