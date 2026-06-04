import { Router } from 'express';
import {
  readConfig,
  getTerminal,
  TERMINAL_CHOICES,
  type TerminalChoice,
} from '../utils/config.js';
import { probeTerminalInstalled } from '../utils/terminal-probe.js';
import { isExistingDir } from '../launch/cwd.js';
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

  return router;
}
