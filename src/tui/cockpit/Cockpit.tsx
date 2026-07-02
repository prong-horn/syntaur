import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useApp, useWindowSize } from 'ink';
import { MouseProvider } from '../mouse/MouseContext.js';
import { isMouseSequence } from '../mouse/parse.js';
import { computeLayout, type FocusTarget } from './layout.js';
import { LeftRail } from './LeftRail.js';
import { DetailPane, type DetailSelection } from './DetailPane.js';
import { ActionBar, type Action } from './ActionBar.js';
import { buildActions, dispatchActionKey } from './actions.js';
import { loadSessions } from '../sessions/feed.js';
import { readConfig, getAgents, type AgentConfig } from '../../utils/config.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

const SESSION_POLL_INTERVAL_MS = 1500;

export interface SelectedAssignment {
  projectSlug: string | null;
  assignmentSlug: string;
}

export const Cockpit: React.FC<{ projectsDir: string; assignmentsDir: string; tmuxAvailable: boolean }> = ({
  projectsDir,
  assignmentsDir,
  tmuxAvailable,
}) => {
  const { exit } = useApp();
  const size = useWindowSize();
  const columns = size.columns || 80;
  const rows = size.rows || 24;
  const layout = computeLayout(columns, rows);
  const [focus, setFocus] = useState<FocusTarget>('rail');

  const [agents, setAgents] = useState<AgentConfig[] | null>(null);
  const [sessions, setSessions] = useState<AgentSessionWithLiveness[]>([]);
  const [selectedSession, setSelectedSession] = useState<AgentSessionWithLiveness | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<SelectedAssignment | null>(null);

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

  // Context-sensitive action set: enable/disable wiring lives in the pure,
  // unit-tested `buildActions` (see actions.ts). `onRun` is stubbed here —
  // Task 15 wires the real launch/attach behavior.
  const actions: Action[] = buildActions(selection, tmuxAvailable, {
    onLaunch: () => {
      // TODO(Task 15): buildLaunchPlan + runLaunch (tmux or hand-off).
    },
    onAttach: () => {
      // TODO(Task 15): tmuxSessionName + runTmuxAttach via suspendTerminal.
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
            <Text bold color={focus === 'detail' ? 'cyan' : undefined}>Detail</Text>
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
