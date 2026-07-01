import { Router } from 'express';
import { readConfig, writeAgentDiscoveryConfig } from '../utils/config.js';

/**
 * GET/POST the agent-discovery settings (sources + roots) and the claude
 * standalone default cwd. Global config, so no workspace scoping. Mirrors
 * `createWorkspaceVisibilityConfigRouter`.
 */
export function createAgentDiscoveryConfigRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const config = await readConfig();
      res.json({
        agentDiscovery: config.agentDiscovery,
        standaloneDefaultCwd: config.standaloneDefaultCwd,
      });
    } catch (error) {
      console.error('Error getting agent-discovery config:', error);
      res.status(500).json({ error: 'Failed to get agent-discovery config' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const b = (req.body ?? {}) as {
        agentDiscovery?: {
          claudeGlobal?: unknown;
          claudeProject?: unknown;
          directory?: unknown;
          roots?: unknown;
        };
        standaloneDefaultCwd?: unknown;
      };
      const d = b.agentDiscovery ?? {};
      const roots = Array.isArray(d.roots)
        ? d.roots.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim())
        : [];
      const cfg = {
        // Default-true semantics: only an explicit `false` turns a source off.
        claudeGlobal: d.claudeGlobal !== false,
        claudeProject: d.claudeProject !== false,
        directory: d.directory !== false,
        roots: roots.length > 0 ? roots : ['~'],
      };
      const cwd =
        typeof b.standaloneDefaultCwd === 'string' && b.standaloneDefaultCwd.trim()
          ? b.standaloneDefaultCwd.trim()
          : null;
      await writeAgentDiscoveryConfig(cfg, cwd);
      res.json({ agentDiscovery: cfg, standaloneDefaultCwd: cwd });
    } catch (error) {
      console.error('Error saving agent-discovery config:', error);
      res.status(500).json({ error: 'Failed to save agent-discovery config' });
    }
  });

  return router;
}
