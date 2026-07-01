import { Router } from 'express';
import { readConfig, writeAgentDiscoveryConfig } from '../utils/config.js';
import { requireAbsolutePath } from '../targets/agent-authoring.js';

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
      // Validate each root is absolute (after ~ expansion) but store the original
      // string so `~` stays portable; discovery expands it at scan time.
      let roots: string[];
      try {
        roots = (Array.isArray(d.roots) ? d.roots : [])
          .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
          .map((r) => {
            requireAbsolutePath(r, 'root');
            return r.trim();
          });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'invalid root' });
        return;
      }
      const cfg = {
        // Default-true semantics: only an explicit `false` turns a source off.
        claudeGlobal: d.claudeGlobal !== false,
        claudeProject: d.claudeProject !== false,
        directory: d.directory !== false,
        roots: roots.length > 0 ? roots : ['~'],
      };
      // standaloneDefaultCwd must be absolute — readConfig drops a relative one,
      // so reject it up front instead of silently no-op'ing the save.
      let cwd: string | null = null;
      if (typeof b.standaloneDefaultCwd === 'string' && b.standaloneDefaultCwd.trim()) {
        try {
          cwd = requireAbsolutePath(b.standaloneDefaultCwd, 'standaloneDefaultCwd');
        } catch (err) {
          res.status(400).json({ error: err instanceof Error ? err.message : 'invalid cwd' });
          return;
        }
      }
      await writeAgentDiscoveryConfig(cfg, cwd);
      res.json({ agentDiscovery: cfg, standaloneDefaultCwd: cwd });
    } catch (error) {
      console.error('Error saving agent-discovery config:', error);
      res.status(500).json({ error: 'Failed to save agent-discovery config' });
    }
  });

  return router;
}
