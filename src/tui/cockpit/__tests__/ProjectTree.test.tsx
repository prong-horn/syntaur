import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { ProjectTree } from '../ProjectTree.js';

const WAIT_TIMEOUT = 20000;

/** Left-button-down SGR sequence at 0-indexed (x, y). */
function clickAt(x: number, y: number): string {
  return `\x1b[<0;${x + 1};${y + 1}M`;
}

async function writeProject(projectsDir: string, slug: string, assignments: Array<{ slug: string; title: string }>) {
  const projectDir = resolve(projectsDir, slug);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    resolve(projectDir, 'project.md'),
    [
      '---', `slug: ${slug}`, `title: ${slug}`, 'status: in_progress',
      'created: "2026-01-01T00:00:00Z"', 'updated: "2026-01-01T00:00:00Z"', '---', '', `# ${slug}`, '',
    ].join('\n'),
  );
  for (const a of assignments) {
    const assignmentDir = resolve(projectDir, 'assignments', a.slug);
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      [
        '---',
        `id: ${a.slug.padStart(8, '0')}-0000-0000-0000-000000000000`,
        `slug: ${a.slug}`, `title: "${a.title}"`, `project: ${slug}`,
        'type: feature', 'status: in_progress', 'priority: medium',
        'created: "2026-05-17T00:00:00Z"', 'updated: "2026-05-17T00:00:00Z"',
        'assignee: null', 'externalIds: []', 'dependsOn: []', 'links: []', 'blockedReason: null',
        'workspace:', '  repository: null', '  worktreePath: null', '  branch: null', '  parentBranch: null',
        'tags: []', '---', '', `# ${a.title}`, '',
      ].join('\n'),
    );
  }
}

/** Finds the frame row containing `text`, or -1 if not visible. */
function rowOf(frame: string, text: string): number {
  return frame.split('\n').findIndex((line) => line.includes(text));
}

describe('ProjectTree', () => {
  let testDir: string;
  let projectsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-projecttree-'));
    projectsDir = resolve(testDir, 'projects');
    await mkdir(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('renders the project row and expands on Enter', async () => {
    await writeProject(projectsDir, 'demo', [{ slug: 'a1', title: 'Assignment One' }]);
    const { lastFrame, stdin, unmount } = render(
      <MouseProvider>
        <ProjectTree
          projectsDir={projectsDir}
          contentRect={{ x: 0, y: 0, width: 40, height: 10 }}
          active
          onSelectAssignment={vi.fn()}
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('demo'), { timeout: WAIT_TIMEOUT });
    expect(lastFrame() ?? '').not.toContain('Assignment One');

    // Enter/toggle is NOT idempotent — send it exactly once, then poll a
    // read-only assertion (never resend the mutating input on retry).
    stdin.write('\r');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Assignment One'), { timeout: WAIT_TIMEOUT });
    unmount();
  }, 30000);

  it('clicking the project row toggles it open, then closed again', async () => {
    await writeProject(projectsDir, 'demo', [{ slug: 'a1', title: 'Assignment One' }]);
    const { lastFrame, stdin, unmount } = render(
      <MouseProvider>
        <ProjectTree
          projectsDir={projectsDir}
          contentRect={{ x: 0, y: 0, width: 40, height: 10 }}
          active
          onSelectAssignment={vi.fn()}
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('demo'), { timeout: WAIT_TIMEOUT });
    const row = rowOf(lastFrame() ?? '', 'demo');
    expect(row).toBeGreaterThanOrEqual(0);

    stdin.write(clickAt(0, row));
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Assignment One'), { timeout: WAIT_TIMEOUT });

    stdin.write(clickAt(0, row));
    await vi.waitFor(() => expect(lastFrame() ?? '').not.toContain('Assignment One'), { timeout: WAIT_TIMEOUT });
    unmount();
  }, 30000);

  it('clicking an assignment row selects it via onSelectAssignment', async () => {
    const assignments = [
      { slug: 'a1', title: 'Assignment One' },
      { slug: 'a2', title: 'Assignment Two' },
      { slug: 'a3', title: 'Assignment Three' },
    ];
    await writeProject(projectsDir, 'demo', assignments);
    const onSelectAssignment = vi.fn();
    const { lastFrame, stdin, unmount } = render(
      <MouseProvider>
        <ProjectTree
          projectsDir={projectsDir}
          contentRect={{ x: 0, y: 0, width: 40, height: 10 }}
          active
          onSelectAssignment={onSelectAssignment}
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('demo'), { timeout: WAIT_TIMEOUT });

    stdin.write('\r'); // expand — sent once
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Assignment One'), { timeout: WAIT_TIMEOUT });

    // Click math is derived from what's ACTUALLY rendered, not an assumed
    // directory-listing order — find whichever assignment is visible and
    // click its row, then assert the matching slug came through.
    const frame = lastFrame() ?? '';
    const visible = assignments.find((a) => frame.includes(a.title));
    expect(visible).toBeDefined();
    const row = rowOf(frame, visible!.title);
    stdin.write(clickAt(0, row));
    await vi.waitFor(() => expect(onSelectAssignment).toHaveBeenCalledWith('demo', visible!.slug), { timeout: WAIT_TIMEOUT });
    unmount();
  }, 30000);

  it('scrolled click selects the correct node (viewport-aware click math)', async () => {
    const assignments = Array.from({ length: 10 }, (_, i) => ({ slug: `a${i}`, title: `Assignment ${i}` }));
    await writeProject(projectsDir, 'demo', assignments);
    const onSelectAssignment = vi.fn();
    // A small height forces windowTreeRows to center on the cursor rather
    // than showing everything at once.
    const contentRect = { x: 0, y: 0, width: 40, height: 3 };
    const { lastFrame, stdin, unmount } = render(
      <MouseProvider>
        <ProjectTree projectsDir={projectsDir} contentRect={contentRect} active onSelectAssignment={onSelectAssignment} />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('demo'), { timeout: WAIT_TIMEOUT });

    stdin.write('\r'); // expand once — cursor stays on the project row
    await vi.waitFor(
      () => expect((lastFrame() ?? '').split('\n').some((l) => assignments.some((a) => l.includes(a.title)))).toBe(true),
      { timeout: WAIT_TIMEOUT },
    );

    // Move the cursor deep into the assignment list, one 'j' at a time with a
    // settle delay between each — moveDown is not idempotent, so each key
    // must land before the next is sent, exactly like a real user typing.
    for (let i = 0; i < 7; i++) {
      stdin.write('j');
      await new Promise((r) => setTimeout(r, 60));
    }
    // The centered window has scrolled far enough that the project row (the
    // very top of the list) is no longer visible.
    await vi.waitFor(() => expect(lastFrame() ?? '').not.toContain('demo'), { timeout: WAIT_TIMEOUT });

    const frame = lastFrame() ?? '';
    const visible = assignments.find((a) => frame.includes(a.title));
    expect(visible).toBeDefined();
    const row = rowOf(frame, visible!.title);
    stdin.write(clickAt(0, row));
    await vi.waitFor(() => expect(onSelectAssignment).toHaveBeenCalledWith('demo', visible!.slug), { timeout: WAIT_TIMEOUT });
    unmount();
  }, 30000);
});
