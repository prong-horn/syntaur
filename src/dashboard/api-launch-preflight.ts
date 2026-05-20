import { Router } from 'express';
import {
  readConfig,
  getTerminal,
  TERMINAL_CHOICES,
  type TerminalChoice,
} from '../utils/config.js';
import { probeTerminalInstalled } from '../utils/terminal-probe.js';

export interface PreflightResponse {
  ok: boolean;
  terminal: TerminalChoice;
  reason?: 'not-installed';
  /** OS-aware default the dashboard can offer as a confirm-to-fallback. */
  suggestedFallback?: TerminalChoice;
}

export function createLaunchPreflightRouter(): Router {
  const router = Router();

  router.post('/preflight', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { terminal?: unknown };
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
      if (probe.ok) {
        const response: PreflightResponse = { ok: true, terminal };
        res.json(response);
        return;
      }

      const suggestedFallback = getTerminal({ ...config, terminal: null });
      const response: PreflightResponse = {
        ok: false,
        terminal,
        reason: 'not-installed',
        suggestedFallback,
      };
      res.json(response);
    } catch (error) {
      console.error('Error in launch preflight:', error);
      res.status(500).json({ error: 'preflight failed' });
    }
  });

  return router;
}
