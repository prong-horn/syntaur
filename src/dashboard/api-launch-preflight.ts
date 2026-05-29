import { Router } from 'express';
import {
  readConfig,
  getTerminal,
  TERMINAL_CHOICES,
  type TerminalChoice,
} from '../utils/config.js';
import { probeTerminalInstalled } from '../utils/terminal-probe.js';
import { getAssignmentDetailById } from './api.js';
import { resolveWorkspaceCwd } from '../launch/cwd.js';

export interface PreflightResponse {
  ok: boolean;
  terminal: TerminalChoice;
  reason?: 'not-installed' | 'workspace-path-invalid';
  /** Human-readable detail, set when `ok` is false. */
  message?: string;
  /** OS-aware default the dashboard can offer as a confirm-to-fallback. */
  suggestedFallback?: TerminalChoice;
}

interface PreflightBody {
  terminal?: unknown;
  /**
   * The thing being opened. When `kind === 'assignment'`, preflight also
   * validates that the assignment's workspace directory exists so a bad
   * workspace surfaces here instead of silently failing at launch time.
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

      // Terminal is installed. If the click targets an assignment, validate its
      // workspace directory now so the dashboard can show a clear error instead
      // of firing a deep link that opens in the wrong directory (or fails).
      const target = body.target;
      if (
        target &&
        target.kind === 'assignment' &&
        typeof target.id === 'string'
      ) {
        const detail = await getAssignmentDetailById(
          projectsDir,
          assignmentsDir,
          target.id,
        );
        if (detail) {
          const picked = resolveWorkspaceCwd({
            worktreePath: detail.workspace.worktreePath,
            repository: detail.workspace.repository,
            branch: detail.workspace.branch,
            assignmentSlug: detail.slug,
          });
          if (picked.cwd === null) {
            const response: PreflightResponse = {
              ok: false,
              terminal,
              reason: 'workspace-path-invalid',
              message:
                picked.invalidReason ??
                'This assignment has no valid workspace directory.',
            };
            res.json(response);
            return;
          }
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
