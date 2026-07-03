import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { render } from 'ink-testing-library';
import { Cockpit } from '../Cockpit.js';
import { buildActions } from '../actions.js';
import type { DetailSelection } from '../DetailPane.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

// vi.waitFor's own default (1000ms) proved too tight for these tests under
// full-suite parallel CPU contention (many concurrent test-file workers
// delay a click/keypress -> setState -> re-render round trip well past
// 1000ms even though it's near-instant in isolation) -- so every wait below
// uses this more generous budget explicitly instead of the default.
const WAIT_TIMEOUT = 45000;

// Hoisted so the vi.mock factories below (which run before this file's own
// top-level code, per ESM/vitest module-hoisting) can close over them.
const mocks = vi.hoisted(() => ({
  tmuxSessionExists: vi.fn(),
  runTmuxAttach: vi.fn(),
  buildLaunchPlan: vi.fn(),
  // Mutable box so tests can flip liveness between polls without redefining
  // the vi.mock factory.
  sessionLive: { value: true },
}));

vi.mock('../../tmux/launch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tmux/launch.js')>();
  return { ...actual, tmuxSessionExists: mocks.tmuxSessionExists };
});

vi.mock('../../tmux/attach.js', () => ({
  runTmuxAttach: mocks.runTmuxAttach,
}));

// Bypasses real workspace/cwd resolution so the test controls exactly which
// command gets spawned by the hand-off path (a real nonexistent binary path
// to exercise a genuine ENOENT from Node's child_process, or a real
// fast-exiting one for the clean-exit path) without needing a fully valid
// assignment workspace on disk.
vi.mock('../../../launch/build-launch.js', () => ({
  buildLaunchPlan: mocks.buildLaunchPlan,
}));

// A single fixed session whose `isLive` flag is re-read (from the hoisted
// mutable box) on every poll tick, so tests can simulate the live session
// the user selected dying out from under them.
vi.mock('../../sessions/feed.js', () => ({
  loadSessions: vi.fn(async () => [
    {
      sessionId: 's1',
      agent: 'claude',
      started: '2026-07-01T00:00:00Z',
      status: 'active',
      isLive: mocks.sessionLive.value,
      resumeSupported: true,
      forkSupported: false,
      projectSlug: 'proj',
      assignmentSlug: 'a1',
      path: '/tmp/s1',
    } as AgentSessionWithLiveness,
  ]),
}));

describe('Cockpit shell', () => {
  it('renders rail (Live Sessions + Projects) + detail + action bar', () => {
    const { lastFrame, unmount } = render(<Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" tmuxAvailable={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Live Sessions');
    expect(f).toContain('Projects');
    expect(f).toContain('Detail');
    // Action bar: Launch/Attach are context-sensitive (no selection yet ->
    // disabled), Quit is always available.
    expect(f).toContain('Launch');
    expect(f).toContain('Attach');
    expect(f).toContain('Quit');
    unmount();
  });

  it('graceful degradation: Attach is disabled when tmuxAvailable is false, even with a session selected', () => {
    // Restores the "no tmux" assertion dropped when ActionBar took over the
    // bottom row (it used to check for a literal "no tmux" status string,
    // which no longer renders). Re-expressed against the current structure:
    // `buildActions` is the exact function Cockpit calls to wire up the
    // action bar, so this exercises the real enable/disable rule, not just a
    // copy of it. Ink strips color from non-TTY `lastFrame()`, so rendering
    // Cockpit itself can't distinguish enabled vs disabled buttons -- see
    // actions.test.tsx for full render+keypress coverage of this rule.
    const selection: DetailSelection = {
      kind: 'session',
      session: { assignmentSlug: 'a1', projectSlug: 'proj', isLive: true } as AgentSessionWithLiveness,
    };
    const cb = { onLaunch: vi.fn(), onAttach: vi.fn(), onQuit: vi.fn() };

    const withTmux = buildActions(selection, { tmuxAvailable: true, claudeBgAvailable: false }, cb);
    const withoutTmux = buildActions(selection, { tmuxAvailable: false, claudeBgAvailable: false }, cb);

    expect(withTmux.find((a) => a.key === 'a')?.enabled).toBe(true);
    expect(withoutTmux.find((a) => a.key === 'a')?.enabled).toBe(false);
  });
});

describe('Cockpit selection freshness (selectedSessionId derives from the latest poll)', () => {
  beforeEach(() => {
    mocks.sessionLive.value = true;
    mocks.tmuxSessionExists.mockReset().mockResolvedValue(true);
    mocks.runTmuxAttach.mockReset().mockResolvedValue({ code: 0 });
  });

  it('re-derives the selected session from each poll, so Attach re-disables once the live session dies', async () => {
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" tmuxAvailable={true} />,
    );

    // Wait for the first poll to land the live session in the rail.
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('claude'), { timeout: WAIT_TIMEOUT });

    // Click the only session row (rail at x:0,y:0; header row 0; row 0 of the
    // list is 0-indexed y=1 -> 1-indexed SGR y=2, x=1).
    stdin.write('\x1b[<0;1;2M');

    // Selection is a LIVE session + tmux available ⇒ Attach enabled ⇒ 'a'
    // reaches handleAttach, which calls tmuxSessionExists. Re-send 'a' on
    // every retry tick (harmless once selection has landed — a second 'a'
    // dispatch just calls handleAttach again) instead of guessing a fixed
    // settle delay for the click's setState to flush, which flaked under
    // full-suite CPU contention.
    await vi.waitFor(
      () => {
        stdin.write('a');
        expect(mocks.tmuxSessionExists).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );

    // The session dies out from under the selection. Wait past the ~1.5s
    // poll interval so `sessions` refreshes with isLive:false for the same
    // sessionId.
    mocks.sessionLive.value = false;
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // If selection were a stale snapshot captured at click-time (the bug),
    // it would still report isLive:true and this second 'a' would fire a
    // second attach attempt. Re-deriving from the fresh `sessions` array
    // must gate it off instead. Give it a beat to (wrongly) fire before
    // asserting the negative.
    stdin.write('a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mocks.tmuxSessionExists).toHaveBeenCalledTimes(1);

    unmount();
  }, 90000);
});

describe('Cockpit handleAttach status reporting (surfaces child exit/error, C3)', () => {
  beforeEach(() => {
    mocks.sessionLive.value = true;
    mocks.tmuxSessionExists.mockReset().mockResolvedValue(true);
    mocks.runTmuxAttach.mockReset();
  });

  // A single render + single click, re-pressing 'a' for each of the four
  // code/error combinations below (the selection persists across presses).
  // Consolidated from four separate render+click round trips into one to
  // cut down on the number of async click -> setState -> re-render
  // boundaries this suite has to cross under full-suite parallel load,
  // where each such boundary is a (rare but real) source of flakiness.
  it('reports the outcome of each runTmuxAttach result via the shared classification (clean/null/error/non-zero)', async () => {
    mocks.runTmuxAttach.mockResolvedValue({ code: 0 });
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" tmuxAvailable={true} />,
    );

    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('claude'), { timeout: WAIT_TIMEOUT });
    stdin.write('\x1b[<0;1;2M');
    // Re-send 'a' on every retry tick until the click's setState has flushed
    // and Attach is enabled — avoids guessing a fixed settle delay, which
    // flaked under full-suite CPU contention.
    await vi.waitFor(
      () => {
        stdin.write('a');
        expect(mocks.tmuxSessionExists).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );

    // 1. Clean detach (exit code 0) -> "Detached from …".
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Detached from'), { timeout: WAIT_TIMEOUT });
    expect(lastFrame() ?? '').not.toContain('Attach failed');

    // 2. A null exit code (e.g. a real tmux detach-client) is ALSO a clean
    // detach -> "Detached from …" again.
    mocks.runTmuxAttach.mockResolvedValue({ code: null });
    mocks.tmuxSessionExists.mockClear();
    await vi.waitFor(
      () => {
        stdin.write('a');
        expect(mocks.tmuxSessionExists).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Detached from'), { timeout: WAIT_TIMEOUT });

    // 3. A spawn error surfaces as "Attach failed: <message>" instead of a
    // fake "Detached from …".
    mocks.runTmuxAttach.mockResolvedValue({ code: null, error: new Error('spawn tmux ENOENT') });
    mocks.tmuxSessionExists.mockClear();
    await vi.waitFor(
      () => {
        stdin.write('a');
        expect(mocks.tmuxSessionExists).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );
    await vi.waitFor(
      () => expect(lastFrame() ?? '').toContain('Attach failed: spawn tmux ENOENT'),
      { timeout: WAIT_TIMEOUT },
    );
    expect(lastFrame() ?? '').not.toContain('Detached from');

    // 4. A non-zero exit code surfaces as "Attach failed: exited with code N".
    mocks.runTmuxAttach.mockResolvedValue({ code: 1 });
    mocks.tmuxSessionExists.mockClear();
    await vi.waitFor(
      () => {
        stdin.write('a');
        expect(mocks.tmuxSessionExists).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );
    await vi.waitFor(
      () => expect(lastFrame() ?? '').toContain('Attach failed: exited with code 1'),
      { timeout: WAIT_TIMEOUT },
    );

    unmount();
  }, 90000);
});

describe('Cockpit handleLaunch hand-off (no tmux) does not silently exit on a failed spawn (C3)', () => {
  let testDir: string;
  let projectsDir: string;
  let assignmentsDir: string;

  async function writeProjectFixture(projectSlug: string, assignmentSlug: string): Promise<void> {
    const projectDir = resolve(projectsDir, projectSlug);
    const assignmentDir = resolve(projectDir, 'assignments', assignmentSlug);
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(projectDir, 'project.md'),
      [
        '---',
        `slug: ${projectSlug}`,
        `title: ${projectSlug}`,
        'status: in_progress',
        'created: "2026-01-01T00:00:00Z"',
        'updated: "2026-01-01T00:00:00Z"',
        '---',
        '',
        `# ${projectSlug}`,
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      [
        '---',
        'id: 22222222-2222-2222-2222-222222222222',
        `slug: ${assignmentSlug}`,
        `title: "${assignmentSlug}"`,
        `project: ${projectSlug}`,
        'type: feature',
        'status: in_progress',
        'priority: medium',
        'created: "2026-05-17T00:00:00Z"',
        'updated: "2026-05-17T00:00:00Z"',
        'assignee: null',
        'externalIds: []',
        'dependsOn: []',
        'links: []',
        'blockedReason: null',
        'workspace:',
        '  repository: null',
        '  worktreePath: null',
        '  branch: null',
        '  parentBranch: null',
        'tags: []',
        '---',
        '',
        `# ${assignmentSlug}`,
        '',
        '## Objective',
        'test',
        '',
      ].join('\n'),
    );
  }

  /** Expands the (only) project row and moves the tree cursor onto its
   * (only) assignment child, then presses Enter to select it — the same
   * keyboard path a real user takes through ProjectTree. */
  async function selectAssignmentViaTree(
    stdin: { write: (d: string) => void },
    lastFrame: () => string | undefined,
    projectSlug: string,
  ) {
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain(projectSlug), { timeout: WAIT_TIMEOUT });
    // Right arrow expands the project node; expandNode is idempotent, so
    // it's safe to re-send on every retry tick until the '▾' expanded
    // chevron actually renders (avoids guessing a fixed settle delay).
    await vi.waitFor(
      () => {
        stdin.write('\x1b[C');
        expect(lastFrame() ?? '').toContain('▾');
      },
      { timeout: WAIT_TIMEOUT },
    );
    // Down arrow moves the cursor and is NOT idempotent (each send advances
    // it further), so it can only be sent once — give the just-confirmed
    // expand render a beat to fully settle first.
    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write('\x1b[B'); // down arrow: move cursor onto the assignment child
    await new Promise((resolve) => setTimeout(resolve, 200));
    stdin.write('\r'); // enter: onSelectAssignment(projectSlug, assignmentSlug)
    // Wait for the assignment DetailPane (not just the tree row) to actually
    // render, so we know `selectedAssignment` has flushed before the caller
    // dispatches the Launch shortcut — a keypress sent right after 'enter'
    // could otherwise race the pending state update and be dispatched
    // against the stale ('none') selection.
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Status:'), { timeout: WAIT_TIMEOUT });
  }

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'syntaur-cockpit-handoff-'));
    projectsDir = resolve(testDir, 'projects');
    assignmentsDir = resolve(testDir, 'assignments');
    await mkdir(projectsDir, { recursive: true });
    mocks.buildLaunchPlan.mockReset();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('a spawn ENOENT does not exit the cockpit — it surfaces "Launch failed: command not found" and stays', async () => {
    await writeProjectFixture('demo', 'task');
    // Very short and NOT derived from the (long) mkdtemp path: the detail
    // pane is ~72 columns wide, and "Detail — Launch failed: command not
    // found (…)" alone is already ~45 of those, so a longer path here would
    // word-wrap mid-string and break a plain `.toContain()` on the frame.
    const badCommand = '/nope-xyz';
    mocks.buildLaunchPlan.mockResolvedValue({ command: badCommand, args: [], cwd: testDir });

    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir={projectsDir} assignmentsDir={assignmentsDir} tmuxAvailable={false} />,
    );

    await selectAssignmentViaTree(stdin, lastFrame, 'demo');
    stdin.write('l'); // Launch shortcut

    await vi.waitFor(
      () => expect(lastFrame() ?? '').toContain(`Launch failed: command not found (${badCommand})`),
      { timeout: WAIT_TIMEOUT },
    );
    // The cockpit is still alive and rendering its normal chrome — a
    // spawn failure must NOT have torn it down via `exit()`.
    expect(lastFrame() ?? '').toContain('Live Sessions');
    expect(lastFrame() ?? '').toContain('Detail');

    unmount();
  }, 90000);

  it('a clean (code 0) hand-off exit does not report a launch failure (the cockpit exits instead)', async () => {
    await writeProjectFixture('demo2', 'task2');
    mocks.buildLaunchPlan.mockResolvedValue({ command: '/usr/bin/true', args: [], cwd: testDir });

    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir={projectsDir} assignmentsDir={assignmentsDir} tmuxAvailable={false} />,
    );

    await selectAssignmentViaTree(stdin, lastFrame, 'demo2');
    stdin.write('l');

    // Give the real child process (a genuine /usr/bin/true spawn) time to
    // exit cleanly, then confirm no failure status ever got set — a clean
    // exit takes the exit() branch, not the setStatus('Launch failed…') one.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(lastFrame() ?? '').not.toContain('Launch failed');

    unmount();
  }, 90000);
});
