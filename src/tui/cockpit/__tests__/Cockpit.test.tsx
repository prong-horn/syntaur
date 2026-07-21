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
  runClaudeAttach: vi.fn(),
  buildLaunchPlan: vi.fn(),
  runSyntaurdAttach: vi.fn(),
  launchSyntaurd: vi.fn(),
  appendSession: vi.fn(async () => undefined),
  // Lets a case pin exactly which agent the cockpit launches
  // (Cockpit picks `agents.find((a) => a.default) ?? agents[0]`).
  getAgentsOverride: null as (() => unknown[]) | null,
  // Ordered log proving the attach child runs INSIDE the mouse sandwich and
  // that the sandwich always exits (re-arming mouse tracking) — see the
  // tracking.js mock, which calls through to the real implementation.
  sandwichLog: [] as string[],
  // Mutable box so tests can flip liveness between polls without redefining
  // the vi.mock factory.
  sessionLive: { value: true },
  // Mutable box controlling whether the mocked session carries native/daemon
  // overlay fields — null/undefined (the default) leaves the row with no
  // overlay (not attachable); a describe block below flips it on to exercise
  // handleAttach's native/syntaurd dispatch.
  sessionNative: {
    agentShortId: null as string | null,
    state: null as 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | null,
    syntaurdShortId: null as string | null,
    hostedBy: null as 'syntaurd' | 'claude-bg' | null,
  },
}));

vi.mock('../../claude-agents/attach.js', () => ({
  runClaudeAttach: mocks.runClaudeAttach,
}));

vi.mock('../../syntaurd/attach.js', () => ({
  runSyntaurdAttach: mocks.runSyntaurdAttach,
}));

// Calls through to the REAL runWithMouseSuspended (so every pre-existing test
// keeps its exact behavior, mouse writes included) while recording entry/exit.
// Lets a test prove the attach child is wrapped in the sandwich and that the
// `finally` re-arm still runs on failure — assertions that would otherwise
// pass even if the branch dropped the sandwich entirely.
vi.mock('../../mouse/tracking.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mouse/tracking.js')>();
  return {
    ...actual,
    runWithMouseSuspended: async (write: Parameters<typeof actual.runWithMouseSuspended>[0], fn: Parameters<typeof actual.runWithMouseSuspended>[1]) => {
      mocks.sandwichLog.push('mouse-suspend:enter');
      try {
        return await actual.runWithMouseSuspended(write, fn);
      } finally {
        mocks.sandwichLog.push('mouse-suspend:exit');
      }
    },
  };
});

vi.mock('../../syntaurd/launch.js', async (importOriginal) => ({
  // Spread the REAL module so any other export Cockpit.tsx pulls from here
  // still resolves; only launchSyntaurd is stubbed.
  ...(await importOriginal<typeof import('../../syntaurd/launch.js')>()),
  launchSyntaurd: mocks.launchSyntaurd,
}));

vi.mock('../../../dashboard/agent-sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../dashboard/agent-sessions.js')>()),
  appendSession: mocks.appendSession,
}));

// Delegates to the REAL getAgents unless a case sets the override, so every
// pre-existing test keeps its exact behavior.
vi.mock('../../../utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/config.js')>();
  return {
    ...actual,
    getAgents: ((...a) =>
      mocks.getAgentsOverride
        ? mocks.getAgentsOverride()
        : actual.getAgents(...(a as Parameters<typeof actual.getAgents>))) as typeof actual.getAgents,
  };
});

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
      agentShortId: mocks.sessionNative.agentShortId,
      state: mocks.sessionNative.state,
      syntaurdShortId: mocks.sessionNative.syntaurdShortId,
      hostedBy: mocks.sessionNative.hostedBy,
    } as AgentSessionWithLiveness,
  ]),
}));

describe('Cockpit shell', () => {
  it('renders bordered Sessions + Projects + Detail panes + action bar', () => {
    const { lastFrame, unmount } = render(<Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={false} syntaurdAvailable={false} />);
    const f = lastFrame() ?? '';
    expect(f).toContain('Sessions');
    expect(f).toContain('Projects');
    expect(f).toContain('Detail');
    // Action bar: Launch/Attach are context-sensitive (no selection yet ->
    // disabled), Quit is always available.
    expect(f).toContain('Launch');
    expect(f).toContain('Attach');
    expect(f).toContain('Quit');
    unmount();
  });

  it('Attach is disabled for a session with no daemon/native overlay', () => {
    // `buildActions` is the exact function Cockpit calls to wire up the
    // action bar, so this exercises the real enable/disable rule, not just a
    // copy of it. Ink strips color from non-TTY `lastFrame()`, so rendering
    // Cockpit itself can't distinguish enabled vs disabled buttons -- see
    // actions.test.tsx for full render+keypress coverage of this rule.
    // Post-Phase-C there is no tmux tier: a session reachable by neither
    // daemon backend is not attachable; a daemon-reachable one is.
    const cb = { onLaunch: vi.fn(), onAttach: vi.fn(), onQuit: vi.fn() };
    const noOverlay: DetailSelection = {
      kind: 'session',
      session: { assignmentSlug: 'a1', projectSlug: 'proj', isLive: true } as AgentSessionWithLiveness,
    };
    const daemonReachable: DetailSelection = {
      kind: 'session',
      session: { assignmentSlug: 'a1', projectSlug: 'proj', isLive: true, syntaurdShortId: 'sd1', state: 'working' } as AgentSessionWithLiveness,
    };

    expect(buildActions(noOverlay, cb).find((a) => a.key === 'a')?.enabled).toBe(false);
    expect(buildActions(daemonReachable, cb).find((a) => a.key === 'a')?.enabled).toBe(true);
  });
});

describe('Cockpit selection freshness (selectedSessionId derives from the latest poll)', () => {
  beforeEach(() => {
    mocks.sessionLive.value = true;
    mocks.sessionNative.syntaurdShortId = 'sd12ab34';
    mocks.sessionNative.state = 'working';
    mocks.runSyntaurdAttach.mockReset().mockResolvedValue({ code: 0 });
  });

  afterEach(() => {
    mocks.sessionNative.syntaurdShortId = null;
    mocks.sessionNative.state = null;
  });

  it('re-derives the selected session from each poll, so Attach re-disables once the session goes terminal', async () => {
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={false} syntaurdAvailable={true} />,
    );

    // Wait for the first poll to land the session in the rail (human label
    // "proj/a1", not the raw agent id — see railTypes.ts's label resolution).
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });

    // Click the only session row. Layout: col 0 is the pane's left border
    // (content starts at x:1), row 0 is the top border, row 1 the "Sessions"
    // title, row 2 the "LIVE (1)" group header, row 3 the one session row ->
    // 0-indexed (x:1, y:3) -> 1-indexed SGR (x:2, y:4). Selecting a row is
    // idempotent (repeated identical selection), so it's safe to resend on
    // every retry tick alongside 'a' — this covers BOTH the click's setState
    // flush AND the mouse region's post-mount registration under full-suite
    // CPU contention, instead of guessing a fixed settle delay for either.
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        stdin.write('a');
        expect(mocks.runSyntaurdAttach).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );

    // The session goes terminal out from under the selection. Wait past the
    // ~1.5s poll interval so `sessions` refreshes with state:'done' for the
    // same sessionId.
    mocks.sessionNative.state = 'done';
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // If selection were a stale snapshot captured at click-time (the bug),
    // it would still report state:'working' and this second 'a' would fire a
    // second attach attempt. Re-deriving from the fresh `sessions` array must
    // gate it off (a terminal daemon state is not attachable) instead. Give
    // it a beat to (wrongly) fire before asserting the negative.
    stdin.write('a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mocks.runSyntaurdAttach).toHaveBeenCalledTimes(1);

    unmount();
  }, 90000);
});

describe('Cockpit handleLaunch hand-off does not silently exit on a failed spawn (C3)', () => {
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
    // The 3-way focus cycle (rail -> tree -> detail) starts on 'rail' — the
    // tree's keyboard handling is gated on `active` (focus === 'tree'), so a
    // single Tab must land before arrow keys reach it. Tab is NOT idempotent
    // (each press advances the cycle), so send it exactly once, then give it
    // a beat to settle before the retry loop below.
    stdin.write('\t');
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    // Very short and NOT derived from the (long) mkdtemp path: the status
    // row shows "Launch failed: command not found (…)" verbatim, and a
    // longer path here would word-wrap mid-string and break a plain
    // `.toContain()` on the frame.
    const badCommand = '/nope-xyz';
    mocks.buildLaunchPlan.mockResolvedValue({ command: badCommand, args: [], cwd: testDir });

    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir={projectsDir} assignmentsDir={assignmentsDir} claudeBgAvailable={false} syntaurdAvailable={false} />,
    );

    await selectAssignmentViaTree(stdin, lastFrame, 'demo');
    stdin.write('l'); // Launch shortcut

    await vi.waitFor(
      () => expect(lastFrame() ?? '').toContain(`Launch failed: command not found (${badCommand})`),
      { timeout: WAIT_TIMEOUT },
    );
    // The cockpit is still alive and rendering its normal chrome — a
    // spawn failure must NOT have torn it down via `exit()`.
    expect(lastFrame() ?? '').toContain('Sessions');
    expect(lastFrame() ?? '').toContain('Detail');

    unmount();
  }, 90000);

  it('a clean (code 0) hand-off exit does not report a launch failure (the cockpit exits instead)', async () => {
    await writeProjectFixture('demo2', 'task2');
    mocks.buildLaunchPlan.mockResolvedValue({ command: '/usr/bin/true', args: [], cwd: testDir });

    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir={projectsDir} assignmentsDir={assignmentsDir} claudeBgAvailable={false} syntaurdAvailable={false} />,
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

  it('Launch dispatches via the daemon and the cockpit stays resident', async () => {
    await writeProjectFixture('demo', 'task');
    mocks.launchSyntaurd.mockReset().mockResolvedValue({ short: 'sd12ab34', sessionId: 'uuid-1', registered: true });
    mocks.buildLaunchPlan.mockResolvedValue({ command: 'codex', args: ['hi'], cwd: testDir });

    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir={projectsDir} assignmentsDir={assignmentsDir} claudeBgAvailable={true} syntaurdAvailable={true} />,
    );
    await selectAssignmentViaTree(stdin, lastFrame, 'demo');
    stdin.write('l');

    await vi.waitFor(() => expect(mocks.launchSyntaurd).toHaveBeenCalledTimes(1), { timeout: WAIT_TIMEOUT });
    expect(mocks.launchSyntaurd).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: { command: 'codex', args: ['hi'], cwd: testDir },
        name: 'demo/task',
        projectSlug: 'demo',
        assignmentSlug: 'task',
      }),
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Launched via daemon (demo/task)'), { timeout: WAIT_TIMEOUT });
    expect(lastFrame() ?? '').toContain('Sessions'); // resident — no exit()
    unmount();
  }, 90000);

  it('a failed daemon dispatch degrades down the ladder instead of aborting the launch', async () => {
    await writeProjectFixture('demo', 'task');
    mocks.launchSyntaurd.mockReset().mockRejectedValue(new Error('daemon start timeout'));
    const badCommand = '/nope-xyz';
    mocks.buildLaunchPlan.mockResolvedValue({ command: badCommand, args: [], cwd: testDir });

    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir={projectsDir} assignmentsDir={assignmentsDir} claudeBgAvailable={false} syntaurdAvailable={true} />,
    );
    await selectAssignmentViaTree(stdin, lastFrame, 'demo');
    stdin.write('l');

    await vi.waitFor(
      () => expect(lastFrame() ?? '').toContain(`Launch failed: command not found (${badCommand})`),
      { timeout: WAIT_TIMEOUT },
    );
    expect(mocks.launchSyntaurd).toHaveBeenCalledTimes(1); // syntaurd tried FIRST, then degraded to hand-off
    expect(lastFrame() ?? '').toContain('Sessions');
    unmount();
  }, 90000);

  it('a daemon-unavailable launch with no claude-bg degrades to hand-off (no tmux provenance row)', async () => {
    await writeProjectFixture('demo', 'task');
    mocks.launchSyntaurd.mockReset().mockRejectedValue(new Error('daemon start timeout'));
    mocks.appendSession.mockReset().mockResolvedValue(undefined);
    // Deterministic non-claude selection: pre-Phase-C this exact case (daemon
    // down, no claude-bg) landed in a detached tmux session and wrote a
    // hostedBy=tmux provenance row. With the tmux tier gone it lands in
    // in-process hand-off instead and writes NO provenance row.
    mocks.getAgentsOverride = () => [{ id: 'codex', command: 'codex', default: true }];
    const badCommand = '/nope-xyz';
    mocks.buildLaunchPlan.mockResolvedValue({ command: badCommand, args: [], cwd: testDir });
    try {
      const { lastFrame, stdin, unmount } = render(
        <Cockpit projectsDir={projectsDir} assignmentsDir={assignmentsDir} claudeBgAvailable={false} syntaurdAvailable={true} />,
      );
      await selectAssignmentViaTree(stdin, lastFrame, 'demo');
      stdin.write('l');

      // The hand-off spawns the (bad) command directly; a genuine ENOENT
      // surfaces as a launch failure and the cockpit stays resident.
      await vi.waitFor(
        () => expect(lastFrame() ?? '').toContain(`Launch failed: command not found (${badCommand})`),
        { timeout: WAIT_TIMEOUT },
      );
      expect(mocks.launchSyntaurd).toHaveBeenCalledTimes(1); // syntaurd tried FIRST, then degraded
      expect(mocks.appendSession).not.toHaveBeenCalled(); // no tmux provenance row is written
      expect(lastFrame() ?? '').toContain('Sessions');
      unmount();
    } finally {
      mocks.getAgentsOverride = null;
    }
  }, 90000);
});

describe('Cockpit handleAttach native dispatch (task 14 wiring)', () => {
  beforeEach(() => {
    mocks.sessionLive.value = true;
    mocks.sessionNative.agentShortId = 'ab12cd34';
    mocks.sessionNative.state = 'working';
    mocks.runClaudeAttach.mockReset().mockResolvedValue({ code: 0 });
  });

  afterEach(() => {
    mocks.sessionNative.agentShortId = null;
    mocks.sessionNative.state = null;
  });

  it('picks runClaudeAttach for a native-reachable session', async () => {
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={true} syntaurdAvailable={false} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
    // Coordinate + idempotent-resend pattern matches the other rail-row
    // clicks in this file (col 1 clears the pane's left border, row 3 is the
    // one session row).
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        stdin.write('a');
        expect(mocks.runClaudeAttach).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );
    expect(mocks.runClaudeAttach).toHaveBeenCalledWith('ab12cd34');
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Detached from ab12cd34'), { timeout: WAIT_TIMEOUT });

    unmount();
  }, 30000);

  it('a terminal native state disables Attach entirely', async () => {
    mocks.sessionNative.state = 'done';
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={true} syntaurdAvailable={false} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
    // Confirm the click actually landed (Detail pane switches off its
    // no-selection placeholder) before asserting the negative below —
    // otherwise a click that silently missed would make this pass for the
    // wrong reason. The click is idempotent, so resending it is safe.
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        expect(lastFrame() ?? '').toContain('(no transcript available)');
      },
      { timeout: WAIT_TIMEOUT },
    );

    stdin.write('a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mocks.runClaudeAttach).not.toHaveBeenCalled();

    unmount();
  }, 30000);
});

describe('Cockpit handleAttach syntaurd dispatch (Phase B wiring)', () => {
  beforeEach(() => {
    mocks.sessionLive.value = true;
    mocks.sessionNative.agentShortId = 'cc12dd34'; // native ALSO reachable — syntaurd must win
    mocks.sessionNative.state = 'working';
    mocks.sessionNative.syntaurdShortId = 'sd12ab34';
    mocks.runClaudeAttach.mockReset().mockResolvedValue({ code: 0 });
    mocks.sandwichLog.length = 0;
    // Records its own position in the sandwich log so ordering is provable.
    mocks.runSyntaurdAttach.mockReset().mockImplementation(async () => {
      mocks.sandwichLog.push('syntaurd-attach');
      return { code: 0 };
    });
  });

  afterEach(() => {
    mocks.sessionNative.agentShortId = null;
    mocks.sessionNative.state = null;
    mocks.sessionNative.syntaurdShortId = null;
    mocks.sessionNative.hostedBy = null;
  });

  it('a claude-bg row whose native overlay is live still attaches natively (the backend guard must not preempt it)', async () => {
    // Regression: the backend-aware guard sat ABOVE the native branch, so a
    // correctly-stamped claude-bg row with a live agentShortId had Attach
    // ENABLED by buildActions but refused by handleAttach — the enable check
    // and the dispatch disagreed. The guard only exists to block tmux
    // fall-through, so it must sit below native.
    mocks.sessionNative.syntaurdShortId = null; // no daemon overlay
    mocks.sessionNative.agentShortId = 'cc12dd34'; // but the native join IS answering
    mocks.sessionNative.state = 'working';
    mocks.sessionNative.hostedBy = 'claude-bg';
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={true} syntaurdAvailable={true} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        stdin.write('a');
        expect(mocks.runClaudeAttach).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );
    expect(mocks.runClaudeAttach).toHaveBeenCalledWith('cc12dd34');
    expect(mocks.runSyntaurdAttach).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Detached from cc12dd34'), { timeout: WAIT_TIMEOUT });
    expect(lastFrame() ?? '').not.toContain('Daemon unavailable');
    unmount();
  }, 30000);

  it('a daemon-hosted row with NO overlay is not attachable', async () => {
    // Daemon down past the grace window: no overlay fields, but a lingering pid
    // keeps isLive true. `attachEnabled`'s backend-aware guard disables the
    // action, so pressing 'a' must do NOTHING — the row is not attachable.
    // (handleAttach's own mirror of the guard is defence-in-depth for
    // non-button dispatch paths; via the action bar this row is unreachable.)
    mocks.sessionNative.syntaurdShortId = null;
    mocks.sessionNative.agentShortId = null;
    mocks.sessionNative.state = null;
    mocks.sessionNative.hostedBy = 'syntaurd';
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={true} syntaurdAvailable={true} />,
    );
    try {
      await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
      stdin.write('\x1b[<0;2;4M'); // select the session row
      stdin.write('a');
      // Give any (incorrect) dispatch a real chance to fire before asserting.
      await new Promise((r) => setTimeout(r, 500));
      expect(mocks.runSyntaurdAttach).not.toHaveBeenCalled();
      expect(mocks.runClaudeAttach).not.toHaveBeenCalled();
    } finally {
      unmount(); // never leak a polling instance into the next case
    }
  }, 30000);

  it('picks runSyntaurdAttach over native for a daemon-hosted session', async () => {
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={true} syntaurdAvailable={true} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        stdin.write('a');
        expect(mocks.runSyntaurdAttach).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );
    expect(mocks.runSyntaurdAttach).toHaveBeenCalledWith('sd12ab34');
    expect(mocks.runClaudeAttach).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Detached from sd12ab34'), { timeout: WAIT_TIMEOUT });
    unmount();
  }, 30000);

  it('runs the attach child INSIDE the mouse-suspend sandwich', async () => {
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={true} syntaurdAvailable={true} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        stdin.write('a');
        expect(mocks.runSyntaurdAttach).toHaveBeenCalledTimes(1);
      },
      { timeout: WAIT_TIMEOUT },
    );
    // The child must run between mouse-off and the finally that re-arms it —
    // dropping runWithMouseSuspended would leave the cockpit mouse-dead.
    await vi.waitFor(
      () => expect(mocks.sandwichLog).toEqual(['mouse-suspend:enter', 'syntaurd-attach', 'mouse-suspend:exit']),
      { timeout: WAIT_TIMEOUT },
    );
    unmount();
  }, 30000);

  it('re-arms mouse tracking even when the attach child fails', async () => {
    mocks.runSyntaurdAttach.mockReset().mockImplementation(async () => {
      mocks.sandwichLog.push('syntaurd-attach');
      return { code: 1 };
    });
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={false} syntaurdAvailable={true} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        stdin.write('a');
        expect(mocks.runSyntaurdAttach).toHaveBeenCalled();
      },
      { timeout: WAIT_TIMEOUT },
    );
    // The sandwich's `finally` must still fire on a failed attach.
    await vi.waitFor(() => expect(mocks.sandwichLog).toContain('mouse-suspend:exit'), { timeout: WAIT_TIMEOUT });
    expect(mocks.sandwichLog.at(-1)).toBe('mouse-suspend:exit');
    unmount();
  }, 30000);

  it('surfaces a failed syntaurd attach without leaving the cockpit', async () => {
    mocks.runSyntaurdAttach.mockReset().mockResolvedValue({ code: 1 });
    const { lastFrame, stdin, unmount } = render(
      <Cockpit projectsDir="/tmp/p" assignmentsDir="/tmp/a" claudeBgAvailable={false} syntaurdAvailable={true} />,
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('proj/a1'), { timeout: WAIT_TIMEOUT });
    await vi.waitFor(
      () => {
        stdin.write('\x1b[<0;2;4M');
        stdin.write('a');
        expect(mocks.runSyntaurdAttach).toHaveBeenCalled();
      },
      { timeout: WAIT_TIMEOUT },
    );
    await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Attach failed: exited with code 1'), { timeout: WAIT_TIMEOUT });
    expect(lastFrame() ?? '').toContain('Sessions');
    unmount();
  }, 30000);
});
