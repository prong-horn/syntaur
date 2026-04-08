import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../utils/config.js';
import { createDashboardServer } from '../dashboard/server.js';
import { serversDir as getServersDir, playbooksDir as getPlaybooksDir, todosDir as getTodosDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';

export interface DashboardOptions {
  port: string;
  apiOnly: boolean;
  open: boolean;
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const config = await readConfig();
  const missionsDir = config.defaultMissionDir;
  const port = parseInt(options.port, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${options.port}". Must be a number between 1 and 65535.`);
  }

  // Always run Express in dev mode (API only) — Vite serves the UI.
  // With --api-only, skip the Vite dev server (useful for custom setups).
  const server = createDashboardServer({
    port,
    missionsDir,
    serversDir: getServersDir(),
    playbooksDir: getPlaybooksDir(),
    todosDir: getTodosDir(),
    devMode: !options.apiOnly,
  });

  await server.start();

  let viteProcess: ChildProcess | null = null;

  if (!options.apiOnly) {
    const thisFile = fileURLToPath(import.meta.url);
    const packageRoot = resolve(dirname(thisFile), '..');
    const dashboardDir = resolve(packageRoot, 'dashboard');
    const viteBin = resolve(dashboardDir, 'node_modules', '.bin', 'vite');

    if (!(await fileExists(viteBin))) {
      console.error(
        'Vite not found. Run "cd dashboard && npm install" first, or use --api-only.',
      );
      await server.stop();
      process.exit(1);
    }

    console.log(`API server running on http://localhost:${port}`);
    console.log('Starting Vite dev server...');

    viteProcess = spawn(viteBin, [], {
      cwd: dashboardDir,
      env: {
        ...process.env,
        VITE_API_PORT: String(port),
      },
      stdio: 'inherit',
    });

    viteProcess.on('error', (err) => {
      console.error('Failed to start Vite dev server:', err.message);
    });
  } else {
    const url = `http://localhost:${port}`;
    console.log(`Syntaur Dashboard API running at ${url}`);

    if (options.open) {
      try {
        const openModule = await import('open');
        await openModule.default(url);
      } catch {
        console.log(`Open ${url} in your browser to view the dashboard.`);
      }
    }
  }

  // Keep the process running
  const shutdown = async () => {
    console.log('\nShutting down dashboard...');
    if (viteProcess) {
      viteProcess.kill();
    }
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
