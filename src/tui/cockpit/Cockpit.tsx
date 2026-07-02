import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useApp, useWindowSize } from 'ink';
import { MouseProvider } from '../mouse/MouseContext.js';
import { isMouseSequence } from '../mouse/parse.js';
import { computeLayout, type FocusTarget } from './layout.js';
import { LeftRail } from './LeftRail.js';
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

  useInput((input, key) => {
    if (isMouseSequence(input)) return; // mouse bytes also reach Ink input
    if (input === 'q' || key.escape) exit();
    if (key.tab) setFocus((f) => (f === 'rail' ? 'detail' : 'rail'));
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
              onSelectSession={setSelectedSession}
              onSelectAssignment={(projectSlug, assignmentSlug) =>
                setSelectedAssignment({ projectSlug, assignmentSlug })
              }
            />
          </Box>
          <Box width={detail.width} height={detail.height} flexDirection="column">
            <Text bold color={focus === 'detail' ? 'cyan' : undefined}>{`Detail (assignmentsDir=${assignmentsDir})`}</Text>
            {selectedSession && (
              <Text dimColor>session: {selectedSession.agent} {selectedSession.sessionId.slice(0, 8)}</Text>
            )}
            {selectedAssignment && (
              <Text dimColor>
                assignment: {selectedAssignment.projectSlug ?? '(standalone)'}/{selectedAssignment.assignmentSlug}
              </Text>
            )}
          </Box>
        </Box>
        <Box height={actionBar.height}>
          <Text dimColor>
            {`q quit · tab focus · ${tmuxAvailable ? 'tmux ready' : 'no tmux (launch/attach limited)'}`}
          </Text>
        </Box>
      </Box>
    </MouseProvider>
  );
};
