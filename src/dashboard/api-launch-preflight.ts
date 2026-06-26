import { Router } from 'express';
import {
  readConfig,
  getTerminal,
  getAgents,
  TERMINAL_CHOICES,
  type TerminalChoice,
  type AgentConfig,
} from '../utils/config.js';
import { probeTerminalInstalled } from '../utils/terminal-probe.js';
import { isExistingDir } from '../launch/cwd.js';
import {
  resolveLaunchPlan,
  buildShellCommandLine,
  pickAgent,
  effectiveLaunchTemplate,
  LaunchError,
} from '../launch/index.js';
import { resolveAssignmentById } from '../utils/assignment-resolver.js';
import { listPlaybookSlugs } from '../utils/playbooks.js';
import { playbooksDir } from '../utils/paths.js';
import { resolveRecreateTarget } from './recreate-target.js';

/** Data the dashboard needs to offer a one-click recreate of a deleted worktree. */
export interface PreflightRecreate {
  kind: 'assignment' | 'session';
  id: string;
  projectSlug: string | null;
  assignmentSlug: string | null;
  /** The exact recorded worktree path that no longer exists. */
  deletedPath: string;
  repository: string | null;
  branch: string | null;
}

export interface PreflightResponse {
  ok: boolean;
  terminal: TerminalChoice;
  reason?: 'not-installed' | 'workspace-path-invalid';
  /** Human-readable detail, set when `ok` is false. */
  message?: string;
  /** OS-aware default the dashboard can offer as a confirm-to-fallback. */
  suggestedFallback?: TerminalChoice;
  /**
   * Present on a `workspace-path-invalid` response when the missing worktree
   * can be auto-recreated. Absent when there is nothing recreatable (e.g. no
   * repository on record), in which case the dashboard shows a read-only error.
   */
  recreate?: PreflightRecreate;
}

interface PreflightBody {
  terminal?: unknown;
  /**
   * The thing being opened. For `kind === 'assignment'` and `kind ===
   * 'session'`, preflight validates that the recorded worktree directory still
   * exists, so a deleted worktree surfaces here (as a recreate offer) instead
   * of silently failing at launch time.
   */
  target?: { kind?: unknown; id?: unknown };
}

export function createLaunchPreflightRouter(
  projectsDir: string,
  assignmentsDir: string,
): Router {
  const router = Router();

  router.post('/preflight', async (req, res) => {
    try {
      const body = (req.body ?? {}) as PreflightBody;
      if (
        body.terminal !== undefined &&
        (typeof body.terminal !== 'string' ||
          !(TERMINAL_CHOICES as readonly string[]).includes(body.terminal))
      ) {
        res.status(400).json({
          error: `terminal must be one of: ${TERMINAL_CHOICES.join(', ')}`,
        });
        return;
      }

      const config = await readConfig();
      const terminal: TerminalChoice =
        (body.terminal as TerminalChoice | undefined) ?? getTerminal(config);

      const probe = probeTerminalInstalled(terminal);
      if (!probe.ok) {
        const suggestedFallback = getTerminal({ ...config, terminal: null });
        const response: PreflightResponse = {
          ok: false,
          terminal,
          reason: 'not-installed',
          suggestedFallback,
        };
        res.json(response);
        return;
      }

      // Terminal is installed. If the click targets an assignment or a session,
      // validate the recorded worktree directory now: a deleted worktree
      // surfaces here as a one-click recreate offer instead of firing a deep
      // link that opens in the wrong directory (or silently fails `--resume`).
      const target = body.target;
      if (
        target &&
        (target.kind === 'assignment' || target.kind === 'session') &&
        typeof target.id === 'string'
      ) {
        const resolved = await resolveRecreateTarget(
          { projectsDir, assignmentsDir },
          target.kind === 'assignment'
            ? { kind: 'assignment', id: target.id }
            : { kind: 'session', id: target.id },
        );
        if (resolved && resolved.missing) {
          const response: PreflightResponse = resolved.recreatable
            ? {
                ok: false,
                terminal,
                reason: 'workspace-path-invalid',
                message: `Worktree ${resolved.worktreePath} was deleted.`,
                recreate: {
                  kind: resolved.kind,
                  id: resolved.id,
                  projectSlug: resolved.projectSlug,
                  assignmentSlug: resolved.assignmentSlug,
                  deletedPath: resolved.worktreePath,
                  repository: resolved.repository,
                  branch: resolved.branch,
                },
              }
            : {
                ok: false,
                terminal,
                reason: 'workspace-path-invalid',
                message:
                  `Worktree ${resolved.worktreePath} was deleted and can't be ` +
                  `auto-recreated (no repository on record). Set a valid ` +
                  `workspace for this assignment, then try again.`,
              };
          res.json(response);
          return;
        }
        // No recorded worktree at all and no usable repository — the launch
        // still cannot resolve a cwd. Preserve the legacy read-only error.
        if (
          resolved &&
          resolved.kind === 'assignment' &&
          resolved.worktreePath === '' &&
          !isExistingDir(resolved.repository)
        ) {
          const response: PreflightResponse = {
            ok: false,
            terminal,
            reason: 'workspace-path-invalid',
            message:
              'This assignment has no valid workspace directory. Set a ' +
              'repository or worktree, then try again.',
          };
          res.json(response);
          return;
        }
      }

      const response: PreflightResponse = { ok: true, terminal };
      res.json(response);
    } catch (error) {
      console.error('Error in launch preflight:', error);
      res.status(500).json({ error: 'preflight failed' });
    }
  });

  // Return the exact shell command the session's Resume/launch button would
  // run — `cd '<cwd>' && '<agent>' '--resume' '<id>'` — so the dashboard can
  // offer a "copy launch command" affordance. The command and cwd come from
  // the SAME `resolveLaunchPlan` the launcher uses (worktree-preferred, falling
  // back to the session's recorded path) and the SAME `buildShellCommandLine`
  // helper, so the copied command can never drift from what the button runs.
  // This deliberately does NOT run preflight/recreate — copying text is a
  // lighter contract than launching; the literal cwd is visible in the command.
  router.get('/command', async (req, res) => {
    const rawSession = req.query.session;
    if (typeof rawSession !== 'string' || rawSession.length === 0) {
      // typeof guard also rejects Express 5 duplicate params (?session=a&session=b → array).
      res.status(400).json({ error: 'session query param is required' });
      return;
    }

    const rawMode = req.query.mode;
    let mode: 'resume' | 'fork';
    if (rawMode === undefined) {
      mode = 'resume';
    } else if (rawMode === 'resume' || rawMode === 'fork') {
      mode = rawMode;
    } else {
      res.status(400).json({ error: 'mode must be one of: resume, fork' });
      return;
    }

    try {
      const config = await readConfig();
      const plan = await resolveLaunchPlan({
        kind: 'session',
        id: rawSession,
        mode,
        config,
        projectsDir,
        assignmentsDir,
      });
      const command = buildShellCommandLine(plan);
      res.json({
        command,
        cwd: plan.cwd,
        agentId: plan.agentId,
        mode,
        fallbackWarning: plan.fallbackWarning,
      });
    } catch (error) {
      if (error instanceof LaunchError) {
        // Explicit allowlist: a known client/config-shaped failure maps to a
        // 4xx; any OTHER LaunchError code (e.g. a future one, or one this
        // session path isn't expected to emit) is treated as a server fault
        // and falls through to the 500 below — never silently mislabeled 422.
        const status =
          error.code === 'session-not-found'
            ? 404
            : error.code === 'agent-not-configured' ||
                error.code === 'mode-not-supported' ||
                error.code === 'no-agents-configured' ||
                error.code === 'workspace-path-invalid'
              ? 422
              : null;
        if (status !== null) {
          res.status(status).json({ error: error.message });
          return;
        }
      }
      console.error('Error in launch command:', error);
      res.status(500).json({ error: 'launch command failed' });
    }
  });

  // Prefill source for the dashboard's editable "Open in agent" prompt box.
  // Returns the effective TEMPLATE (NOT resolved text — the box re-resolves the
  // edited value at launch) plus the authoritative installed-playbook slug set
  // (`listPlaybookSlugs`, incl. disabled — same set launch uses) for @-token
  // autocomplete + warning parity. Per-launch only; nothing is written.
  router.get('/prompt', async (req, res) => {
    const rawAssignment = req.query.assignment;
    if (typeof rawAssignment !== 'string' || rawAssignment.length === 0) {
      // typeof guard also rejects Express 5 duplicate params (array).
      res.status(400).json({ error: 'assignment query param is required' });
      return;
    }
    const rawAgent = req.query.agent;
    if (rawAgent !== undefined && typeof rawAgent !== 'string') {
      res.status(400).json({ error: 'agent query param must be a single value' });
      return;
    }

    try {
      const resolved = await resolveAssignmentById(projectsDir, assignmentsDir, rawAssignment);
      if (!resolved) {
        res.status(404).json({ error: `Assignment ${rawAssignment} not found` });
        return;
      }
      const config = await readConfig();
      let agent: AgentConfig;
      if (rawAgent !== undefined && rawAgent.length > 0) {
        const found = getAgents(config).find((a) => a.id === rawAgent);
        if (!found) {
          res.status(422).json({ error: `Agent "${rawAgent}" is not configured` });
          return;
        }
        agent = found;
      } else {
        agent = pickAgent(config); // throws LaunchError('no-agents-configured') if empty
      }
      const knownPlaybookSlugs = Array.from(await listPlaybookSlugs(playbooksDir()));
      const template = effectiveLaunchTemplate({
        launchPrompt: agent.launchPrompt,
        playbook: agent.playbook,
        projectSlug: resolved.projectSlug,
        assignmentSlug: resolved.assignmentSlug,
        id: resolved.id,
        workdir: agent.workdir,
      });
      res.json({ template, knownPlaybookSlugs });
    } catch (error) {
      if (error instanceof LaunchError) {
        const status =
          error.code === 'agent-not-configured' || error.code === 'no-agents-configured'
            ? 422
            : null;
        if (status !== null) {
          res.status(status).json({ error: error.message });
          return;
        }
      }
      console.error('Error in launch prompt prefill:', error);
      res.status(500).json({ error: 'launch prompt prefill failed' });
    }
  });

  return router;
}
