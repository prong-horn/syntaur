import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import { MouseProvider } from '../../mouse/MouseContext.js';
import { DetailPane, sliceWithIndicators } from '../DetailPane.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';
import type { DisplayRow } from '../../transcript-render/index.js';

const WAIT_TIMEOUT = 20000;

const FULL_RECT = { x: 0, y: 0, width: 60, height: 20 };

function rows(n: number): DisplayRow[] {
  return Array.from({ length: n }, (_, i) => ({ text: `row-${i}`, style: 'assistant' }));
}

describe('sliceWithIndicators', () => {
  it('shows everything with no indicators when content fits', () => {
    const r = sliceWithIndicators(rows(3), 0, 10);
    expect(r).toEqual({ visible: rows(3), moreAbove: 0, moreBelow: 0 });
  });

  it('at the bottom (follow-tail), ends on the newest row with only a top indicator', () => {
    const r = sliceWithIndicators(rows(20), 16, 4);
    expect(r.visible.map((x) => x.text)).toEqual(['row-17', 'row-18', 'row-19']);
    expect(r.moreAbove).toBe(17);
    expect(r.moreBelow).toBe(0);
  });

  it('scrolled to the middle shows both indicators', () => {
    const r = sliceWithIndicators(rows(20), 15, 4);
    expect(r.visible.map((x) => x.text)).toEqual(['row-15', 'row-16']);
    expect(r.moreAbove).toBe(15);
    expect(r.moreBelow).toBe(3);
  });

  it('at the very top shows only a bottom indicator', () => {
    const r = sliceWithIndicators(rows(20), 0, 4);
    expect(r.visible.map((x) => x.text)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(r.moreAbove).toBe(0);
    expect(r.moreBelow).toBe(17);
  });

  it('total rows (visible + indicators) never exceeds viewHeight', () => {
    for (const offset of [0, 5, 10, 16]) {
      const r = sliceWithIndicators(rows(20), offset, 4);
      const total = r.visible.length + (r.moreAbove > 0 ? 1 : 0) + (r.moreBelow > 0 ? 1 : 0);
      expect(total).toBeLessThanOrEqual(4);
    }
  });
});

describe('DetailPane — no selection', () => {
  it('shows a hint when nothing is selected', () => {
    const { lastFrame, unmount } = render(
      <DetailPane
        projectsDir="/tmp/p"
        assignmentsDir="/tmp/a"
        selection={{ kind: 'none' }}
        contentRect={FULL_RECT}
        focused={false}
      />,
    );
    expect(lastFrame() ?? '').toContain('Select an assignment or session');
    unmount();
  });
});

describe('DetailPane — assignment view', () => {
  let testDir: string;
  let projectsDir: string;
  let assignmentsDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-detailpane-'));
    projectsDir = resolve(testDir, 'projects');
    assignmentsDir = resolve(testDir, 'assignments');
    await mkdir(projectsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeAssignment(acCount: number) {
    const projectDir = resolve(projectsDir, 'demo');
    const assignmentDir = resolve(projectDir, 'assignments', 'task');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(projectDir, 'project.md'),
      ['---', 'slug: demo', 'title: demo', 'status: in_progress', 'created: "2026-01-01T00:00:00Z"', 'updated: "2026-01-01T00:00:00Z"', '---', '', '# demo', ''].join('\n'),
    );
    const acs = Array.from({ length: acCount }, (_, i) => `- [${i % 2 === 0 ? 'x' : ' '}] Criterion ${i}`).join('\n');
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      [
        '---', 'id: 11111111-1111-1111-1111-111111111111', 'slug: task', 'title: "Demo Task"', 'project: demo',
        'type: feature', 'status: in_progress', 'priority: medium',
        'created: "2026-05-17T00:00:00Z"', 'updated: "2026-05-17T00:00:00Z"',
        'assignee: null', 'externalIds: []', 'dependsOn: []', 'links: []', 'blockedReason: null',
        'workspace:', '  repository: null', '  worktreePath: null', '  branch: null', '  parentBranch: null',
        'tags: []', '---', '', '# Demo Task', '', '## Acceptance Criteria', '', acs, '',
      ].join('\n'),
    );
  }

  it('renders the title, colored status, and acceptance criteria', async () => {
    await writeAssignment(2);
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <DetailPane
          projectsDir={projectsDir}
          assignmentsDir={assignmentsDir}
          selection={{ kind: 'assignment', projectSlug: 'demo', assignmentSlug: 'task' }}
          contentRect={FULL_RECT}
          focused
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Demo Task'), { timeout: WAIT_TIMEOUT });
    const f = lastFrame() ?? '';
    expect(f).toContain('Status:');
    expect(f).toContain('in_progress');
    expect(f).toContain('☑ Criterion 0');
    expect(f).toContain('☐ Criterion 1');
    unmount();
  }, 30000);

  it('scrolls a long acceptance-criteria list and shows a "more" indicator', async () => {
    await writeAssignment(30);
    const smallRect = { x: 0, y: 0, width: 60, height: 6 };
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <DetailPane
          projectsDir={projectsDir}
          assignmentsDir={assignmentsDir}
          selection={{ kind: 'assignment', projectSlug: 'demo', assignmentSlug: 'task' }}
          contentRect={smallRect}
          focused
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Demo Task'), { timeout: WAIT_TIMEOUT });
    const f = lastFrame() ?? '';
    // 30 criteria won't fit in 6 rows alongside the title/status/heading — a
    // "more below" indicator must appear, and the pane must never exceed its height.
    expect(f).toContain('▼');
    expect(f.split('\n').filter((l) => l.trim().length > 0).length).toBeLessThanOrEqual(6);
    unmount();
  }, 30000);
});

describe('DetailPane — transcript view', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'syntaur-transcript-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  function session(overrides: Partial<AgentSessionWithLiveness> = {}): AgentSessionWithLiveness {
    return {
      sessionId: 's1', agent: 'claude', started: '2026-07-01T00:00:00Z', status: 'active',
      isLive: true, resumeSupported: true, forkSupported: false,
      projectSlug: null, assignmentSlug: null, path: '/tmp/s1',
      ...overrides,
    } as AgentSessionWithLiveness;
  }

  it('shows a placeholder when there is no transcript path', async () => {
    const { lastFrame, unmount } = render(
      <MouseProvider>
        <DetailPane
          projectsDir="/tmp/p" assignmentsDir="/tmp/a"
          selection={{ kind: 'session', session: session({ transcriptPath: null }) }}
          contentRect={FULL_RECT} focused
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('(no transcript available)'), { timeout: WAIT_TIMEOUT });
    unmount();
  });

  it('renders parsed Claude JSONL turns — never a raw JSON line', async () => {
    const transcriptPath = resolve(dir, 't.jsonl');
    const lines = [
      { type: 'user', message: { content: 'Add a widget.' }, uuid: 'u1' },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: "I'll look at the code first." }] },
        uuid: 'a1',
      },
    ];
    await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const { lastFrame, unmount } = render(
      <MouseProvider>
        <DetailPane
          projectsDir="/tmp/p" assignmentsDir="/tmp/a"
          selection={{ kind: 'session', session: session({ transcriptPath }) }}
          contentRect={FULL_RECT} focused
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Add a widget'), { timeout: WAIT_TIMEOUT });
    const f = lastFrame() ?? '';
    expect(f).toContain("I'll look at the code first.");
    expect(f).not.toContain('"type"');
    expect(f.startsWith('{')).toBe(false);
    unmount();
  }, 30000);

  it('scrolling up disables follow-tail, and End resumes it', async () => {
    const transcriptPath = resolve(dir, 't.jsonl');
    const lines = Array.from({ length: 20 }, (_, i) => ({
      type: 'user', message: { content: `message number ${i}` }, uuid: `u${i}`,
    }));
    await writeFile(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const smallRect = { x: 0, y: 0, width: 60, height: 4 };
    const { lastFrame, stdin, unmount } = render(
      <MouseProvider>
        <DetailPane
          projectsDir="/tmp/p" assignmentsDir="/tmp/a"
          selection={{ kind: 'session', session: session({ transcriptPath }) }}
          contentRect={smallRect} focused
        />
      </MouseProvider>,
    );
    // Follows the tail by default -> the LAST message is visible, the first is not.
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('message number 19'), { timeout: WAIT_TIMEOUT });
    expect(lastFrame() ?? '').not.toContain('message number 0');

    stdin.write('k'); // scroll up once — stops following the tail
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('▼'), { timeout: WAIT_TIMEOUT });

    stdin.write('\x1b[F'); // End key
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('message number 19'), { timeout: WAIT_TIMEOUT });
    unmount();
  }, 30000);

  it('switching sessions resets follow-tail — a newly-selected session opens pinned to its own tail, not the previous session\'s scroll state', async () => {
    const pathA = resolve(dir, 'a.jsonl');
    const pathB = resolve(dir, 'b.jsonl');
    const linesFor = (label: string) => Array.from({ length: 20 }, (_, i) => ({
      type: 'user', message: { content: `${label} message ${i}` }, uuid: `${label}${i}`,
    }));
    await writeFile(pathA, linesFor('a').map((l) => JSON.stringify(l)).join('\n') + '\n');
    await writeFile(pathB, linesFor('b').map((l) => JSON.stringify(l)).join('\n') + '\n');

    const smallRect = { x: 0, y: 0, width: 60, height: 4 };
    const { lastFrame, stdin, rerender, unmount } = render(
      <MouseProvider>
        <DetailPane
          projectsDir="/tmp/p" assignmentsDir="/tmp/a"
          selection={{ kind: 'session', session: session({ sessionId: 'a', transcriptPath: pathA }) }}
          contentRect={smallRect} focused
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('a message 19'), { timeout: WAIT_TIMEOUT });

    stdin.write('k'); // scroll up in session A — stops following A's tail
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('▼'), { timeout: WAIT_TIMEOUT });

    // Select session B. Without a remount, `useViewport`'s stale
    // followTail=false would carry over and pin B's view to the top.
    rerender(
      <MouseProvider>
        <DetailPane
          projectsDir="/tmp/p" assignmentsDir="/tmp/a"
          selection={{ kind: 'session', session: session({ sessionId: 'b', transcriptPath: pathB }) }}
          contentRect={smallRect} focused
        />
      </MouseProvider>,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('b message 19'), { timeout: WAIT_TIMEOUT });
    expect(lastFrame() ?? '').not.toContain('b message 0');
    unmount();
  }, 30000);
});
