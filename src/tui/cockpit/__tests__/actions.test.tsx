import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { buildActions, dispatchActionKey } from '../actions.js';
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
    const actions = buildActions(selection, true, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(true);
  });

  it('disables Launch when the assignment selection has a null projectSlug (standalone)', () => {
    const selection: DetailSelection = { kind: 'assignment', projectSlug: null, assignmentSlug: 'a1' };
    const actions = buildActions(selection, true, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(false);
  });

  it('disables Launch for a session selection (Launch only applies to assignments)', () => {
    const selection: DetailSelection = { kind: 'session', session: session() };
    const actions = buildActions(selection, true, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(false);
  });

  it('enables Attach for a session selection with tmux available and a non-null assignmentSlug', () => {
    const selection: DetailSelection = { kind: 'session', session: session() };
    const actions = buildActions(selection, true, callbacks());
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(true);
  });

  it('disables Attach when tmux is unavailable (graceful-degradation rule)', () => {
    const selection: DetailSelection = { kind: 'session', session: session() };
    const actions = buildActions(selection, false, callbacks());
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(false);
  });

  it('disables Attach when the selected session has no assignmentSlug', () => {
    const selection: DetailSelection = { kind: 'session', session: session({ assignmentSlug: null }) };
    const actions = buildActions(selection, true, callbacks());
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(false);
  });

  it('disables both Launch and Attach when nothing is selected', () => {
    const selection: DetailSelection = { kind: 'none' };
    const actions = buildActions(selection, true, callbacks());
    expect(actions.find((a) => a.key === 'l')?.enabled).toBe(false);
    expect(actions.find((a) => a.key === 'a')?.enabled).toBe(false);
  });

  it('Quit is always enabled, regardless of selection or tmux availability', () => {
    const selection: DetailSelection = { kind: 'none' };
    expect(buildActions(selection, false, callbacks()).find((a) => a.key === 'q')?.enabled).toBe(true);
    expect(buildActions(selection, true, callbacks()).find((a) => a.key === 'q')?.enabled).toBe(true);
  });

  it('wires each action to its corresponding callback', () => {
    const cb = callbacks();
    const selection: DetailSelection = { kind: 'assignment', projectSlug: 'proj', assignmentSlug: 'a1' };
    const actions = buildActions(selection, true, cb);
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

  it('behavioral: pressing a disabled Attach shortcut (no tmux) does not run it, via the same key-routing Cockpit uses', () => {
    // Reproduces Cockpit's useInput body (`dispatchActionKey(actions, input)`)
    // against a session-selected + tmuxAvailable=false action set, so this
    // exercises the exact wiring a keypress goes through in the real app.
    const cb = callbacks();
    const selection: DetailSelection = { kind: 'session', session: session() };
    const actions: Action[] = buildActions(selection, false, cb);

    function KeyHarness({ actions }: { actions: Action[] }) {
      useInput((input) => dispatchActionKey(actions, input));
      return <Text>ready</Text>;
    }

    const { stdin, unmount } = render(<KeyHarness actions={actions} />);
    stdin.write('a');
    expect(cb.onAttach).not.toHaveBeenCalled();
    unmount();
  });

  it('behavioral: pressing an enabled Attach shortcut (tmux available) runs it', () => {
    const cb = callbacks();
    const selection: DetailSelection = { kind: 'session', session: session() };
    const actions: Action[] = buildActions(selection, true, cb);

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
