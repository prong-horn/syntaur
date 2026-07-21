import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { buildActions, dispatchActionKey, isCleanExit, describeChildFailure } from '../actions.js';
import type { DetailSelection } from '../DetailPane.js';
import type { Action } from '../actionBarLayout.js';
import type { AgentSessionWithLiveness } from '../../../dashboard/types.js';

function session(overrides: Partial<AgentSessionWithLiveness> = {}): AgentSessionWithLiveness {
  return {
    sessionId: 's1',
    agent: 'claude',
    started: '2026-07-01T00:00:00Z',
    status: 'active',
    isLive: true,
    resumeSupported: true,
    forkSupported: false,
    projectSlug: 'proj',
    assignmentSlug: 'a1',
    path: '/tmp/s1',
    ...overrides,
  } as AgentSessionWithLiveness;
}

function callbacks() {
  return { onLaunch: vi.fn(), onAttach: vi.fn(), onQuit: vi.fn() };
}

describe('buildActions', () => {
  it('enables Launch for an assignment selection with a non-null projectSlug', () => {
    const selection: DetailSelection = { kind: 'assignment', projectSlug: 'proj', assignmentSlug: 'a1' };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(true);
  });

  it('disables Launch when the assignment selection has a null projectSlug (standalone)', () => {
    const selection: DetailSelection = { kind: 'assignment', projectSlug: null, assignmentSlug: 'a1' };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(false);
  });

  it('disables Launch for a session selection (Launch only applies to assignments)', () => {
    const selection: DetailSelection = { kind: 'session', session: session() };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(false);
  });

  it('disables Attach for a session with no daemon or native overlay (tmux tier removed)', () => {
    // The strongest former-enable case: LIVE and a non-null assignmentSlug —
    // exactly what the deleted tmux gate used to enable. With no tmux tier and
    // no daemon/native overlay, a row reachable by neither backend is not
    // attachable (attachEnabled's final `return false`).
    const selection: DetailSelection = { kind: 'session', session: session({ isLive: true }) };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(false);
  });

  it('disables Attach for a dead session', () => {
    const selection: DetailSelection = { kind: 'session', session: session({ isLive: false }) };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(false);
  });

  it('a pre-existing hosted_by=tmux row is not attachable (tmux tier removed)', () => {
    // Legacy-degradation fixture: a pre-upgrade worker registered with
    // SYNTAUR_HOSTED_BY=tmux. Post-upgrade there is no tmux code at all; the
    // row still lists, but Attach must resolve to false (no daemon/native
    // overlay → the unconditional final `return false`).
    const selection: DetailSelection = {
      kind: 'session',
      session: session({ hostedBy: 'tmux', isLive: false, assignmentSlug: 'a1' }),
    };
    expect(buildActions(selection, callbacks()).find((a) => a.key === 'a')?.enabled).toBe(false);
  });

  it('disables both Launch and Attach when nothing is selected', () => {
    const selection: DetailSelection = { kind: 'none' };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(false);
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(false);
  });

  it('enables Attach for a native session with a non-terminal state', () => {
    const selection: DetailSelection = {
      kind: 'session',
      session: session({ agentShortId: 'ab12cd34', state: 'working', assignmentSlug: null, isLive: false }),
    };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(true);
  });

  it('enables Attach for a native session that is blocked on a permission prompt', () => {
    const selection: DetailSelection = { kind: 'session', session: session({ agentShortId: 'ab12cd34', state: 'blocked' }) };
    const actions = buildActions(selection, callbacks());
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(true);
  });

  it('disables Attach for a native session in a terminal state (done/failed/stopped)', () => {
    for (const state of ['done', 'failed', 'stopped'] as const) {
      const selection: DetailSelection = { kind: 'session', session: session({ agentShortId: 'ab12cd34', state }) };
      const actions = buildActions(selection, callbacks());
      expect(actions.find((a) => a.key === 'a')?.enabled).toBe(false);
    }
  });

  it('enables Attach for a syntaurd session with a non-terminal state', () => {
    const selection: DetailSelection = {
      kind: 'session',
      session: session({ syntaurdShortId: 'sd12ab34', state: 'working', agentShortId: undefined, assignmentSlug: null, isLive: false }),
    };
    expect(buildActions(selection, callbacks()).find((a) => a.key === 'a')?.enabled).toBe(true);
  });

  it('enables Attach for a blocked syntaurd session (state handled though Phase A never emits it)', () => {
    const selection: DetailSelection = { kind: 'session', session: session({ syntaurdShortId: 'sd12ab34', state: 'blocked' }) };
    expect(buildActions(selection, callbacks()).find((a) => a.key === 'a')?.enabled).toBe(true);
  });

  it('disables Attach for a terminal syntaurd session — authoritative, no daemon fall-through', () => {
    for (const state of ['done', 'failed', 'stopped'] as const) {
      const selection: DetailSelection = { kind: 'session', session: session({ syntaurdShortId: 'sd12ab34', state, isLive: true }) };
      expect(buildActions(selection, callbacks()).find((a) => a.key === 'a')?.enabled).toBe(false);
    }
  });

  it('syntaurd gate wins over the native gate when both short ids are present', () => {
    const selection: DetailSelection = {
      kind: 'session',
      session: session({ syntaurdShortId: 'sd12ab34', agentShortId: 'cc12dd34', state: 'working' }),
    };
    expect(buildActions(selection, callbacks()).find((a) => a.key === 'a')?.enabled).toBe(true);
  });

  it('daemon-hosted rows with NO overlay are not attachable (backend guard precedes the unconditional false)', () => {
    // daemon down past the grace window: no shortId/state overlay, but a
    // lingering pid keeps isLive true. The backend-aware guard disables Attach
    // for both daemon backends before the unconditional final `return false`
    // (there is no tmux tier below it to fall through to).
    for (const hostedBy of ['syntaurd', 'claude-bg'] as const) {
      const selection: DetailSelection = {
        kind: 'session',
        session: session({ hostedBy, syntaurdShortId: undefined, agentShortId: undefined, state: undefined, isLive: true, assignmentSlug: 'a' }),
      };
      expect(buildActions(selection, callbacks()).find((a) => a.key === 'a')?.enabled).toBe(false);
    }
  });

  it('Quit is always enabled, regardless of selection', () => {
    expect(buildActions({ kind: 'none' }, callbacks()).find((a) => a.key === 'q')?.enabled).toBe(true);
    expect(buildActions({ kind: 'session', session: session() }, callbacks()).find((a) => a.key === 'q')?.enabled).toBe(true);
  });

  it('wires each action to its corresponding callback', () => {
    const cb = callbacks();
    const selection: DetailSelection = { kind: 'assignment', projectSlug: 'proj', assignmentSlug: 'a1' };
    const actions = buildActions(selection, cb);
    actions.find((a) => a.key === 'l')!.onRun();
    actions.find((a) => a.key === 'q')!.onRun();
    expect(cb.onLaunch).toHaveBeenCalledTimes(1);
    expect(cb.onQuit).toHaveBeenCalledTimes(1);
    expect(cb.onAttach).not.toHaveBeenCalled();
  });
});

describe('dispatchActionKey', () => {
  it('invokes onRun for an enabled action matching the key', () => {
    const onRun = vi.fn();
    dispatchActionKey([{ key: 'l', label: 'Launch', enabled: true, onRun }], 'l');
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke onRun for a disabled action matching the key', () => {
    const onRun = vi.fn();
    dispatchActionKey([{ key: 'a', label: 'Attach', enabled: false, onRun }], 'a');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('does nothing when no action matches the key', () => {
    const onRun = vi.fn();
    dispatchActionKey([{ key: 'l', label: 'Launch', enabled: true, onRun }], 'x');
    expect(onRun).not.toHaveBeenCalled();
  });

  it('behavioral: pressing a disabled Attach shortcut (no daemon/native overlay) does not run it, via the same key-routing Cockpit uses', () => {
    // Reproduces Cockpit's useInput body (`dispatchActionKey(actions, input)`)
    // against a session-selected action set whose row has no daemon/native
    // overlay (Attach disabled), so this exercises the exact wiring a keypress
    // goes through in the real app.
    const cb = callbacks();
    const selection: DetailSelection = { kind: 'session', session: session() };
    const actions: Action[] = buildActions(selection, cb);

    function KeyHarness({ actions }: { actions: Action[] }) {
      useInput((input) => dispatchActionKey(actions, input));
      return <Text>ready</Text>;
    }

    const { stdin, unmount } = render(<KeyHarness actions={actions} />);
    stdin.write('a');
    expect(cb.onAttach).not.toHaveBeenCalled();
    unmount();
  });

  it('behavioral: pressing an enabled Attach shortcut (daemon-reachable) runs it', () => {
    const cb = callbacks();
    const selection: DetailSelection = { kind: 'session', session: session({ syntaurdShortId: 'sd1', state: 'working' }) };
    const actions: Action[] = buildActions(selection, cb);

    function KeyHarness({ actions }: { actions: Action[] }) {
      useInput((input) => dispatchActionKey(actions, input));
      return <Text>ready</Text>;
    }

    const { stdin, unmount } = render(<KeyHarness actions={actions} />);
    stdin.write('a');
    expect(cb.onAttach).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('isCleanExit', () => {
  it('is clean on code 0 with no error', () => {
    expect(isCleanExit({ code: 0 })).toBe(true);
  });

  it('is NOT clean on a non-zero code', () => {
    expect(isCleanExit({ code: 1 })).toBe(false);
  });

  it('is NOT clean on a null code by default (strict mode, e.g. a spawn hand-off)', () => {
    expect(isCleanExit({ code: null })).toBe(false);
  });

  it('treats a null code as clean when allowNullCode is set (e.g. a detach)', () => {
    expect(isCleanExit({ code: null }, { allowNullCode: true })).toBe(true);
  });

  it('is NOT clean whenever an error is present, even alongside code 0', () => {
    expect(isCleanExit({ code: 0, error: new Error('boom') })).toBe(false);
  });

  it('is NOT clean for an error with a null code, even with allowNullCode set', () => {
    expect(isCleanExit({ code: null, error: new Error('boom') }, { allowNullCode: true })).toBe(false);
  });
});

describe('describeChildFailure', () => {
  it('describes an ENOENT spawn error as "command not found"', () => {
    const err = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' });
    expect(describeChildFailure({ code: null, error: err }, 'nope')).toBe('command not found (nope)');
  });

  it('describes an EACCES spawn error as "permission denied"', () => {
    const err = Object.assign(new Error('spawn nope EACCES'), { code: 'EACCES' });
    expect(describeChildFailure({ code: null, error: err }, 'nope')).toBe('permission denied (nope)');
  });

  it('falls back to the raw error message for other spawn errors', () => {
    const err = Object.assign(new Error('boom'), { code: 'EWEIRD' });
    expect(describeChildFailure({ code: null, error: err }, 'nope')).toBe('boom');
  });

  it('describes a non-zero, error-free exit by its code', () => {
    expect(describeChildFailure({ code: 7 })).toBe('exited with code 7');
  });
});
