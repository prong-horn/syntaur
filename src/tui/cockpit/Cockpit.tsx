import React, { useEffect, useState } from 'react';
import { spawn } from 'node:child_process';
import { Box, Text, useInput, useApp, useWindowSize } from 'ink';
import { MouseProvider } from '../mouse/MouseContext.js';
import { isMouseSequence } from '../mouse/parse.js';
import { computeLayout, type FocusTarget } from './layout.js';
import { LeftRail } from './LeftRail.js';
import { DetailPane, type DetailSelection } from './DetailPane.js';
import { ActionBar, type Action } from './ActionBar.js';
import { buildActions, dispatchActionKey, runLaunch } from './actions.js';
import { loadSessions } from '../sessions/feed.js';
import { readConfig, getAgents, type AgentConfig } from '../../utils/config.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';
import { buildLaunchPlan } from '../../launch/build-launch.js';
import { launchInTmux, tmuxSessionExists, tmuxSessionName } from '../tmux/launch.js';
import { runTmuxAttach } from '../tmux/attach.js';

const SESSION_POLL_INTERVAL_MS = 1500;
const STATUS_CLEAR_MS = 4000;

export interface SelectedAssignment {
  projectSlug: string | null;
  assignmentSlug: string;
}

export const Cockpit: React.FC<{ projectsDir: string; assignmentsDir: string; tmuxAvailable: boolean }> = ({
  projectsDir,
  assignmentsDir,
  tmuxAvailable,
}) => {
  const { exit, suspendTerminal } = useApp();
  const size = useWindowSize();
  const columns = size.columns || 80;
  const rows = size.rows || 24;
  const layout = computeLayout(columns, rows);
  const [focus, setFocus] = useState<FocusTarget>('rail');

  const [agents, setAgents] = useState<AgentConfig[] | null>(null);
  const [sessions, setSessions] = useState<AgentSessionWithLiveness[]>([]);
  const [selectedSession, setSelectedSession] = useState<AgentSessionWithLiveness | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<SelectedAssignment | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Transient status line (launch/attach outcome) — self-clears so it never
  // becomes a stale, misleading banner.
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_CLEAR_MS);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, [status]);

  // Load the agent list once at mount; session polling waits for it so
  // `loadSessions` can resolve each session's resume/fork support.
  useEffect(() => {
    let cancelled = false;
    readConfig()
      .then((config) => {
        if (!cancelled) setAgents(getAgents(config));
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (agents === null) return;
    let cancelled = false;

    const poll = () => {
      loadSessions({ projectsDir, agents })
        .then((next) => {
          if (!cancelled) setSessions(next);
        })
        .catch(() => {
          // Transient read failure (e.g. DB mid-write) - keep last-known sessions.
        });
    };

    poll();
    const timer = setInterval(poll, SESSION_POLL_INTERVAL_MS);
    timer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectsDir, agents]);

  // Session wins over assignment when both are set (e.g. a session was
  // selected after an assignment, or vice versa) — the more recently
  // clicked/selected item should drive the detail pane.
  const selection: DetailSelection = selectedSession
    ? { kind: 'session', session: selectedSession }
    : selectedAssignment
      ? { kind: 'assignment', projectSlug: selectedAssignment.projectSlug, assignmentSlug: selectedAssignment.assignmentSlug }
      : { kind: 'none' };

  // Launch: build the plan (buildLaunchPlan — same path `launchAgent` uses)
  // then hand off to `runLaunch`'s tmux/hand-off degradation. `buildActions`
  // only enables this action for a project-nested assignment selection (see
  // guard below, duplicated defensively — mirrors the nullability guards in
  // actions.ts's doc comment). A directory-agent hand-off never touches the
  // real terminal until `suspendTerminal` grants it; the cockpit then exits
  // once the agent process exits (a hand-off launch REPLACES the cockpit
  // session, matching the CLI's non-tmux `launchAgent` behavior).
  const handleLaunch = async (): Promise<void> => {
    if (selection.kind !== 'assignment' || selection.projectSlug == null) return;
    const { projectSlug, assignmentSlug } = selection;
    const agent = agents?.find((a) => a.default) ?? agents?.[0];
    if (!agent) {
      setStatus('Launch failed: no agent configured');
      return;
    }
    try {
      const plan = await buildLaunchPlan({ projectsDir, projectSlug, assignmentSlug, agent });
      const sessionName = tmuxSessionName(projectSlug, assignmentSlug);
      const mode = await runLaunch(sessionName, plan, {
        tmuxAvailable,
        launchInTmux,
        handOff: async (p) => {
          await suspendTerminal(async () => {
            await new Promise<void>((resolveChild) => {
              const child = spawn(p.command, p.args, { cwd: p.cwd, stdio: 'inherit' });
              child.on('exit', () => resolveChild());
              child.on('error', () => resolveChild());
            });
          });
          exit();
        },
      });
      if (mode === 'tmux') setStatus(`Launched in tmux (${sessionName})`);
      // Hand-off mode never reaches here in practice — `exit()` above tears
      // down the cockpit as soon as the suspended agent process exits.
    } catch (err) {
      setStatus(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Attach: same tmux session-name derivation as launch. `buildActions` only
  // enables this for a live session with tmux available and a non-null
  // `assignmentSlug` — guarded again here defensively.
  const handleAttach = async (): Promise<void> => {
    if (selection.kind !== 'session') return;
    const { session } = selection;
    if (!tmuxAvailable || session.assignmentSlug == null) return;
    const sessionName = tmuxSessionName(session.projectSlug, session.assignmentSlug);
    try {
      if (!(await tmuxSessionExists(sessionName))) {
        setStatus('session window not found');
        return;
      }
      await suspendTerminal(async () => {
        await runTmuxAttach(sessionName);
      });
      setStatus(`Detached from ${sessionName}`);
    } catch (err) {
      setStatus(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Context-sensitive action set: enable/disable wiring lives in the pure,
  // unit-tested `buildActions` (see actions.ts).
  const actions: Action[] = buildActions(selection, tmuxAvailable, {
    onLaunch: () => {
      void handleLaunch();
    },
    onAttach: () => {
      void handleAttach();
    },
    onQuit: () => exit(),
  });

  useInput((input, key) => {
    if (isMouseSequence(input)) return; // mouse bytes also reach Ink input
    if (key.escape) exit();
    if (key.tab) setFocus((f) => (f === 'rail' ? 'detail' : 'rail'));
    dispatchActionKey(actions, input);
  });

  // CRITICAL: no borders on hit-tested regions and EXPLICIT width/height from
  // `layout.regions` (never flexGrow) — so each rendered Box occupies exactly
  // its layout rect and mouse (x,y) maps 1:1. Focus is shown via header color,
  // not a border (a border insets content by 1 cell and desyncs coordinates).
  const { rail, detail, actionBar } = layout.regions;
  return (
    <MouseProvider>
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection={layout.columns === 2 ? 'row' : 'column'} height={rows - actionBar.height}>
          <Box width={rail.width} height={rail.height} flexDirection="column">
            <LeftRail
              projectsDir={projectsDir}
              railRect={rail}
              sessions={sessions}
              focused={focus === 'rail'}
              active={focus === 'rail'}
              onSelectSession={(session) => {
                setSelectedSession(session);
                setSelectedAssignment(null);
              }}
              onSelectAssignment={(projectSlug, assignmentSlug) => {
                setSelectedAssignment({ projectSlug, assignmentSlug });
                setSelectedSession(null);
              }}
            />
          </Box>
          <Box width={detail.width} height={detail.height} flexDirection="column">
            <Text bold color={focus === 'detail' ? 'cyan' : undefined}>
              Detail{status ? <Text color="yellow"> — {status}</Text> : null}
            </Text>
            <DetailPane projectsDir={projectsDir} assignmentsDir={assignmentsDir} selection={selection} />
          </Box>
        </Box>
        <Box height={actionBar.height}>
          <ActionBar actions={actions} barRect={actionBar} />
        </Box>
      </Box>
    </MouseProvider>
  );
};
