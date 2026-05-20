import { Router } from 'express';
import {
  readConfig,
  writeTerminalConfig,
  deleteTerminalConfig,
  getTerminal,
  TERMINAL_CHOICES,
  type TerminalChoice,
} from '../utils/config.js';

export function createTerminalConfigRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const config = await readConfig();
      res.json({
        terminal: getTerminal(config),
        custom: config.terminal !== null,
      });
    } catch (error) {
      console.error('Error getting terminal config:', error);
      res.status(500).json({ error: 'Failed to get terminal config' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { terminal } = req.body ?? {};
      if (
        typeof terminal !== 'string' ||
        !(TERMINAL_CHOICES as readonly string[]).includes(terminal)
      ) {
        res.status(400).json({
          error: `terminal must be one of: ${TERMINAL_CHOICES.join(', ')}`,
        });
        return;
      }
      await writeTerminalConfig(terminal as TerminalChoice);
      res.json({ terminal, custom: true });
    } catch (error) {
      console.error('Error saving terminal config:', error);
      res.status(500).json({ error: 'Failed to save terminal config' });
    }
  });

  router.delete('/', async (_req, res) => {
    try {
      await deleteTerminalConfig();
      const config = await readConfig();
      res.json({ terminal: getTerminal(config), custom: false });
    } catch (error) {
      console.error('Error resetting terminal config:', error);
      res.status(500).json({ error: 'Failed to reset terminal config' });
    }
  });

  return router;
}
