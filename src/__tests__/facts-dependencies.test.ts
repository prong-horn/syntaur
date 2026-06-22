import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { areDependenciesSatisfied } from '../lifecycle/facts.js';

/**
 * Regression for bug #1: `areDependenciesSatisfied` must read the dependency's
 * status via the canonical frontmatter parser, so a QUOTED `status: "completed"`
 * (which formatYamlValue can emit) is correctly treated as terminal. The old
 * hand-rolled regex left the surrounding quotes on, so `terminalStatuses` never
 * matched and a satisfied dependency gate stayed closed forever.
 */
describe('areDependenciesSatisfied', () => {
  let projectDir: string;
  const terminal = new Set(['completed', 'failed']);

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'syntaur-deps-'));
  });
  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  async function writeDep(slug: string, statusLine: string): Promise<void> {
    const dir = join(projectDir, 'assignments', slug);
    await mkdir(dir, { recursive: true });
    const content = `---\nid: ${slug}\nslug: ${slug}\nstatus: ${statusLine}\n---\n\n# ${slug}\n`;
    await writeFile(join(dir, 'assignment.md'), content, 'utf-8');
  }

  it('treats a QUOTED terminal status as satisfied (bug #1)', async () => {
    await writeDep('dep-quoted', '"completed"');
    expect(await areDependenciesSatisfied(projectDir, ['dep-quoted'], terminal)).toBe(true);
  });

  it('treats an unquoted terminal status as satisfied', async () => {
    await writeDep('dep-bare', 'completed');
    expect(await areDependenciesSatisfied(projectDir, ['dep-bare'], terminal)).toBe(true);
  });

  it('returns false for a non-terminal dependency status', async () => {
    await writeDep('dep-open', 'in_progress');
    expect(await areDependenciesSatisfied(projectDir, ['dep-open'], terminal)).toBe(false);
  });

  it('returns false (fail-closed) when the dependency file is missing', async () => {
    expect(await areDependenciesSatisfied(projectDir, ['no-such-dep'], terminal)).toBe(false);
  });

  it('returns false (fail-closed) when the dependency file has no frontmatter', async () => {
    // parseAssignmentFrontmatter throws when the `---` delimiters are absent;
    // the surrounding try/catch must keep that fail-closed (exercises the
    // parser-throw path, not just the missing-file path).
    const dir = join(projectDir, 'assignments', 'dep-garbage');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'assignment.md'), 'no frontmatter here\njust body text\n', 'utf-8');
    expect(await areDependenciesSatisfied(projectDir, ['dep-garbage'], terminal)).toBe(false);
  });

  it('is trivially satisfied with no dependencies or a null project dir', async () => {
    expect(await areDependenciesSatisfied(projectDir, [], terminal)).toBe(true);
    expect(await areDependenciesSatisfied(null, ['anything'], terminal)).toBe(true);
  });
});
