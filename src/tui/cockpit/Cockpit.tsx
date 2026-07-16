import React, { useEffect, useState } from 'react';
import { spawn } from 'node:child_process';
import { Box, Text, useInput, useApp, useWindowSize, useStdout } from 'ink';
import { MouseProvider } from '../mouse/MouseContext.js';
import { runWithMouseSuspended } from '../mouse/tracking.js';
import { isMouseSequence } from '../mouse/parse.js';
import { computeLayout, type FocusTarget, type FrameContent } from './layout.js';
import { LeftRail } from './LeftRail.js';
import { useLiveActivity } from './useLiveActivity.js';
import { ProjectTree } from './ProjectTree.js';
import { DetailPane, type DetailSelection } from './DetailPane.js';
import { ActionBar, type Action } from './ActionBar.js';
import {
  buildActions, dispatchActionKey, runLaunch, isCleanExit, describeChildFailure,
  isNativeAttachReachable, isSyntaurdAttachReachable, type ChildOutcome,
} from './actions.js';
import { loadSessions } from '../sessions/feed.js';
import { readConfig, getAgents, type AgentConfig } from '../../utils/config.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';
import { buildLaunchPlan } from '../../launch/build-launch.js';
import { tmuxSessionExists, tmuxSessionName } from '../tmux/launch.js';
import { runTmuxAttach } from '../tmux/attach.js';
import { launchClaudeBg } from '../claude-agents/launch.js';
import { runClaudeAttach } from '../claude-agents/attach.js';
import { randomUUID } from 'node:crypto';
import {
  launchSyntaurd as dispatchSyntaurd,
  canInjectClaudeSessionId,
  injectSessionIdArgs,
} from '../syntaurd/launch.js';
import { runSyntaurdAttach } from '../syntaurd/attach.js';
import { launchInTmuxWithPid } from '../tmux/launch.js';
import { appendSession } from '../../dashboard/agent-sessions.js';

const SESSION_POLL_INTERVAL_MS = 1500;
const STATUS_CLEAR_MS = 4000;

export interface SelectedAssignment {
  projectSlug: string | null;
  assignmentSlug: string;
}

const FOCUS_ORDER: FocusTarget[] = ['rail', 'tree', 'detail'];
function nextFocus(current: FocusTarget): FocusTarget {
  return FOCUS_ORDER[(FOCUS_ORDER.indexOf(current) + 1) % FOCUS_ORDER.length];
}

export interface CockpitProps {
  projectsDir: string;
  assignmentsDir: string;
  tmuxAvailable: boolean;
  claudeBgAvailable: boolean;
  syntaurdAvailable: boolean;
}

export const Cockpit: React.FC<CockpitProps> = ({
  projectsDir,
  assignmentsDir,
  tmuxAvailable,
  claudeBgAvailable,
  syntaurdAvailable,
}) => {
  const { exit, suspendTerminal } = useApp();
  const { write } = useStdout();
  const size = useWindowSize();
  const columns = size.columns || 80;
  const rows = size.rows || 24;
  const layout = computeLayout(columns, rows);
  const [focus, setFocus] = useState<FocusTarget>('rail');

  const [agents, setAgents] = useState<AgentConfig[] | null>(null);
  const [sessions, setSessions] = useState<AgentSessionWithLiveness[]>([]);
  // Only the id is stored as state; the session object itself is DERIVED
  // below from the freshest `sessions` on every render so a selection never
  // goes stale between ~1.5s polls (liveness, transcriptPath, etc. always
  // reflect the latest poll instead of a frozen click-time snapshot).
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
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

  // Transcript-derived "what's happening now" phrase per live session (task
  // 1's `lastActivity()`, otherwise unused) — the rail's activity column.
  const liveActivity = useLiveActivity(sessions);

  // Re-derive the selected session from the freshest `sessions` poll every
  // render, rather than trusting a snapshot captured at click-time — a
  // session's liveness/transcriptPath/etc. can change between the ~1.5s
  // polls, and a stale object would keep Attach enabled after the session
  // died (see actions.ts's isLive gate) and would tail an obsolete
  // transcriptPath. If the id no longer matches any row (session
  // disappeared), this correctly derives to null and `selection` below
  // falls through to the assignment (or none).
  const selectedSession: AgentSessionWithLiveness | null =
    selectedSessionId != null ? (sessions.find((s) => s.sessionId === selectedSessionId) ?? null) : null;

  // Session wins over assignment when both are set (e.g. a session was
  // selected after an assignment, or vice versa) — the more recently
  // clicked/selected item should drive the detail pane.
  const selection: DetailSelection = selectedSession
    ? { kind: 'session', session: selectedSession }
    : selectedAssignment
      ? { kind: 'assignment', projectSlug: selectedAssignment.projectSlug, assignmentSlug: selectedAssignment.assignmentSlug }
      : { kind: 'none' };

  // Launch: build the plan (buildLaunchPlan — same path `launchAgent` uses)
  // then hand off to `runLaunch`'s native/tmux/hand-off degradation.
  // `buildActions` only enables this action for a project-nested assignment
  // selection (see guard below, duplicated defensively — mirrors the
  // nullability guards in actions.ts's doc comment). A directory-agent
  // hand-off never touches the real terminal until `suspendTerminal` grants
  // it; the cockpit exits ONLY on a clean (code 0) child exit (a hand-off
  // launch REPLACES the cockpit session on success, matching the CLI's
  // non-tmux `launchAgent` behavior). A spawn error (e.g. ENOENT) or
  // non-zero exit must NOT silently tear down the cockpit — the user needs
  // to see the failure and stays put.
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
      const nativeName = `${projectSlug}/${assignmentSlug}`;
      let handOffFailure: string | null = null;
      let nativeLaunchFailure: string | null = null;
      let syntaurdLaunchFailure: string | null = null;
      let syntaurdRegistered = true;
      // Correlation id for the tmux fallback: planted in the agent's env (and,
      // for plain-claude plans, injected as --session-id) so a later hook
      // registration re-keys the provenance row we write below onto claude's
      // real session id instead of duplicating it.
      const fallbackLaunchId = randomUUID();
      let tmuxPanePid: number | null = null;
      const mode = await runLaunch(
        sessionName,
        plan,
        {
          tmuxAvailable,
          claudeBgAvailable,
          syntaurdAvailable,
          launchSyntaurd: async ({ plan: p, name, agent: launchAgent }) => {
            // Thin closure over the tier module: supplies the binding slugs
            // (rail attribution via the pre-inserted row's engagement) and the
            // cockpit's live window size so a later attach repaints at the
            // right geometry. The UUID sessionId is generated inside
            // dispatchSyntaurd and seeded to BOTH the daemon and session-db.
            // `registered` is closure-captured (same idiom as the failure
            // strings) so the status line can warn when the registry write
            // failed.
            const res = await dispatchSyntaurd({
              plan: p,
              name,
              agent: launchAgent,
              projectSlug,
              assignmentSlug,
              cols: columns,
              rows,
            });
            syntaurdRegistered = res.registered;
          },
          onSyntaurdLaunchFailure: (err) => {
            syntaurdLaunchFailure = err instanceof Error ? err.message : String(err);
          },
          launchInTmux: async (i) => {
            // Plain-claude plans also get the id injected into the argv (ids
            // equal from birth, belt-and-braces if hooks never fire); the env
            // correlation below covers shell-alias plans on every tmux version.
            const args = canInjectClaudeSessionId(agent) ? injectSessionIdArgs(i.args, fallbackLaunchId) : i.args;
            tmuxPanePid = await launchInTmuxWithPid({
              ...i,
              args,
              env: { SYNTAUR_LAUNCH_ID: fallbackLaunchId, SYNTAUR_HOSTED_BY: 'tmux' },
            });
          },
          launchClaudeBg,
          onNativeLaunchFailure: (err) => {
            nativeLaunchFailure = err instanceof Error ? err.message : String(err);
          },
          handOff: async (p) => {
            // Re-arm mouse tracking around the hand-off exactly like attach: the
            // spawned agent owns the real terminal via stdio:'inherit', so disable
            // the mouse DEC private modes first (otherwise clicks/drags leak raw
            // SGR bytes into the child's stdin) and re-enable in the helper's
            // `finally`. Mirrors handleAttach's suspend wrapping below.
            // `outcome` is captured by this closure because neither
            // `runWithMouseSuspended` nor Ink's `suspendTerminal` propagate
            // their callback's return value.
            let outcome: ChildOutcome = { code: null };
            await runWithMouseSuspended(write, () =>
              suspendTerminal(async () => {
                await new Promise<void>((resolveChild) => {
                  const child = spawn(p.command, p.args, { cwd: p.cwd, stdio: 'inherit' });
                  child.on('exit', (code) => {
                    outcome = { code: (code as number | null | undefined) ?? null };
                    resolveChild();
                  });
                  child.on('error', (err) => {
                    outcome = { code: null, error: err as Error };
                    resolveChild();
                  });
                });
              }),
            );
            if (isCleanExit(outcome)) {
              exit();
              return;
            }
            // Stay in the cockpit and surface why instead of silently tearing
            // it down (mirrors launchAgent's ENOENT/EACCES wording, ../launch.ts).
            handOffFailure = describeChildFailure(outcome, p.command);
          },
        },
        { agent, name: nativeName },
      );
      const syntaurdFailurePrefix = syntaurdLaunchFailure != null ? `Daemon launch failed (${syntaurdLaunchFailure}); ` : '';
      const nativeFailurePrefix = nativeLaunchFailure != null ? `Native launch failed (${nativeLaunchFailure}); ` : '';
      if (mode === 'syntaurd') {
        setStatus(
          syntaurdRegistered
            ? `Launched via daemon (${nativeName})`
            : `Launched via daemon (${nativeName}) — WARNING: not registered; session will not appear in the list`,
        );
      }
      else if (mode === 'claude-bg') setStatus(`${syntaurdFailurePrefix}Launched natively (${nativeName})`);
      else if (mode === 'tmux') setStatus(`${syntaurdFailurePrefix}${nativeFailurePrefix}Launched in tmux (${sessionName})`);
      else if (handOffFailure != null) setStatus(`Launch failed: ${handOffFailure}`);
      // Otherwise (hand-off + clean exit): `exit()` above tears down the
      // cockpit as soon as the agent process exits — nothing left to render.

      if (mode === 'tmux') {
        // Provenance for the fallback path: for non-claude agents this is their
        // FIRST-ever rail row (they never self-register); pane pid gives the
        // scanner a real sweep signal. For claude, the planted
        // SYNTAUR_LAUNCH_ID makes the hook's reconcile re-key this row onto the
        // real session id — no duplicate, hosted_by preserved. Best-effort: a
        // registry failure must never turn a successful launch into an error.
        try {
          await appendSession('', {
            sessionId: fallbackLaunchId,
            agent: agent.id,
            started: new Date().toISOString(),
            status: 'active',
            path: plan.cwd,
            pid: tmuxPanePid,
            projectSlug,
            assignmentSlug,
            hostedBy: 'tmux',
          });
        } catch {
          /* launch already succeeded — never surface a registry failure as a launch error */
        }
      }
    } catch (err) {
      setStatus(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Attach: native `claude attach <shortId>` when the session is native-
  // reachable (see `isNativeAttachReachable` — the SAME rule `buildActions`
  // gates the button on), else the existing tmux session-name derivation.
  const handleAttach = async (): Promise<void> => {
    if (selection.kind !== 'session') return;
    const { session } = selection;

    if (isSyntaurdAttachReachable(session)) {
      // syntaurd-hosted: spawn `syntaur attach <short>` as an inherit-stdio
      // child inside the identical mouse+suspend sandwich. The child
      // transitively gets ensureDaemon's respawn+adopt for free, and this
      // path needs no tmux at all. `result` is closure-captured because
      // neither suspend helper propagates its callback's value.
      let result: ChildOutcome = { code: null };
      await runWithMouseSuspended(write, () =>
        suspendTerminal(async () => {
          result = await runSyntaurdAttach(session.syntaurdShortId as string);
        }),
      );
      if (isCleanExit(result, { allowNullCode: true })) {
        setStatus(`Detached from ${session.syntaurdShortId}`);
      } else {
        setStatus(`Attach failed: ${describeChildFailure(result)}`);
      }
      return;
    }

    if (session.hostedBy === 'syntaurd' || session.hostedBy === 'claude-bg') {
      // Mirror of the backend-aware gate in actions.ts: a daemon-hosted row
      // with no live overlay must not reach the native or tmux branches below
      // — the tmux session it would name was never created. Defense-in-depth
      // for non-button dispatch paths.
      setStatus('Daemon unavailable — cannot attach; retry when the daemon is back');
      return;
    }

    if (isNativeAttachReachable(session)) {
      // Re-arm mouse tracking around the suspend exactly like the tmux path
      // below — `claude attach` owns the real terminal via stdio:'inherit'.
      let result: ChildOutcome = { code: null };
      await runWithMouseSuspended(write, () =>
        suspendTerminal(async () => {
          result = await runClaudeAttach(session.agentShortId as string);
        }),
      );
      if (isCleanExit(result, { allowNullCode: true })) {
        setStatus(`Detached from ${session.agentShortId}`);
      } else {
        setStatus(`Attach failed: ${describeChildFailure(result)}`);
      }
      return;
    }

    if (!tmuxAvailable || session.assignmentSlug == null) return;
    const sessionName = tmuxSessionName(session.projectSlug, session.assignmentSlug);
    try {
      if (!(await tmuxSessionExists(sessionName))) {
        setStatus('session window not found');
        return;
      }
      // Re-arm mouse tracking around the suspend: tmux resets the terminal's
      // mouse DEC private modes and Ink's resume does not re-run MouseProvider's
      // mount effect, so without this the cockpit returns mouse-dead. The helper
      // re-enables in a `finally`, so a failed attach never leaves mouse off.
      // `result` is captured by this closure for the same reason as
      // `outcome` above: the suspend helpers discard their callback's value.
      let result: ChildOutcome = { code: null };
      await runWithMouseSuspended(write, () =>
        suspendTerminal(async () => {
          result = await runTmuxAttach(sessionName);
        }),
      );
      if (isCleanExit(result, { allowNullCode: true })) {
        setStatus(`Detached from ${sessionName}`);
      } else {
        setStatus(`Attach failed: ${describeChildFailure(result)}`);
      }
    } catch (err) {
      setStatus(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Context-sensitive action set: enable/disable wiring lives in the pure,
  // unit-tested `buildActions` (see actions.ts).
  const actions: Action[] = buildActions(selection, { tmuxAvailable, claudeBgAvailable }, {
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
    if (key.tab) setFocus(nextFocus);
    dispatchActionKey(actions, input);
  });

  // CRITICAL: no borders on hit-tested regions and EXPLICIT width/height from
  // `layout.regions` (never flexGrow) — so each rendered Box occupies exactly
  // its layout rect and mouse (x,y) maps 1:1. Bordered panes render their
  // `frame` rect with `borderStyle="round"`; children/mouse regions use the
  // inset `content` rect — each region's OWN `borderless` flag (not the
  // top-level `layout.borderless`) skips the border below ~50 cols OR when
  // that specific pane is too short/narrow for the inset to apply, where
  // `content === frame` already (see layout.ts).
  const { sessions: sessionsRegion, tree: treeRegion, detail: detailRegion, statusRow, actionBar } = layout.regions;

  // Ink has no reliable "title cut into the border line" primitive, so the
  // title renders as its own content row instead (still structurally visible
  // focus + a human label, per AC4) — which means each child's actual
  // available rect is `content` MINUS that one row. This is the single place
  // that reconciles the two, so a child's contentRect prop and its rendered
  // position can never drift apart.
  const titledContent = (content: FrameContent['content']) => ({
    x: content.x,
    y: content.y + 1,
    width: content.width,
    height: Math.max(0, content.height - 1),
  });

  const pane = (region: FrameContent, title: string, isFocused: boolean, children: React.ReactNode) => (
    <Box
      flexDirection="column"
      width={region.frame.width}
      height={region.frame.height}
      borderStyle={region.borderless ? undefined : 'round'}
      borderColor={isFocused ? 'cyan' : undefined}
    >
      <Text color={isFocused ? 'cyan' : undefined} bold={isFocused}>{title}</Text>
      {children}
    </Box>
  );

  return (
    <MouseProvider>
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection={layout.columns === 2 ? 'row' : 'column'} height={rows - statusRow.height - actionBar.height}>
          <Box flexDirection="column" width={layout.railWidth}>
            {pane(
              sessionsRegion,
              'Sessions',
              focus === 'rail',
              <LeftRail
                contentRect={titledContent(sessionsRegion.content)}
                sessions={sessions}
                selectedSessionId={selectedSessionId}
                focused={focus === 'rail'}
                liveActivity={liveActivity}
                onSelectSession={(session) => {
                  setSelectedSessionId(session.sessionId);
                  setSelectedAssignment(null);
                }}
              />,
            )}
            {pane(
              treeRegion,
              'Projects',
              focus === 'tree',
              <ProjectTree
                projectsDir={projectsDir}
                contentRect={titledContent(treeRegion.content)}
                active={focus === 'tree'}
                onSelectAssignment={(projectSlug, assignmentSlug) => {
                  setSelectedAssignment({ projectSlug, assignmentSlug });
                  setSelectedSessionId(null);
                }}
              />,
            )}
          </Box>
          {pane(
            detailRegion,
            'Detail',
            focus === 'detail',
            <DetailPane
              projectsDir={projectsDir}
              assignmentsDir={assignmentsDir}
              selection={selection}
              contentRect={titledContent(detailRegion.content)}
              focused={focus === 'detail'}
            />,
          )}
        </Box>
        <Box height={statusRow.height}>
          <Text color="yellow">{status ?? ''}</Text>
        </Box>
        <Box height={actionBar.height}>
          <ActionBar actions={actions} barRect={actionBar} />
        </Box>
      </Box>
    </MouseProvider>
  );
};
