import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../utils/config.js';
import { createDashboardServer } from '../dashboard/server.js';
import { serversDir as getServersDir, playbooksDir as getPlaybooksDir, todosDir as getTodosDir } from '../utils/paths.js';
import { fileExists } from '../utils/fs.js';

export interface DashboardOptions {
  port: string;
  dev?: boolean;
  serverOnly?: boolean;
  apiOnly: boolean;
  open: boolean;
}

export type DashboardRuntimeMode = 'static' | 'dev' | 'server-only';

export function resolveDashboardMode(options: DashboardOptions): DashboardRuntimeMode {
  const devMode = Boolean(options.dev);
  const serverOnly = Boolean(options.serverOnly || options.apiOnly);

  if (devMode && serverOnly) {
    throw new Error('Use either --dev or --server-only, not both.');
  }

  if (devMode) {
    return 'dev';
  }

  if (serverOnly) {
    return 'server-only';
  }

  return 'static';
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolveAvailability) => {
    const tester = createNetServer();

    tester.once('error', () => {
      resolveAvailability(false);
    });

    tester.once('listening', () => {
      tester.close(() => resolveAvailability(true));
    });

    tester.listen(port, '127.0.0.1');
  });
}

export async function findAvailablePort(
  startPort: number,
  maxAttempts: number = 20,
): Promise<number | null> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidate = startPort + offset;
    if (candidate > 65535) {
      break;
    }
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const config = await readConfig();
  const missionsDir = config.defaultMissionDir;
  const port = parseInt(options.port, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${options.port}". Must be a number between 1 and 65535.`);
  }

  const mode = resolveDashboardMode(options);

  const server = createDashboardServer({
    port,
    missionsDir,
    serversDir: getServersDir(),
    playbooksDir: getPlaybooksDir(),
    todosDir: getTodosDir(),
    serveStaticUi: mode === 'static',
  });

  await server.start();

  let viteProcess: ChildProcess | null = null;

  if (mode === 'dev') {
    const thisFile = fileURLToPath(import.meta.url);
    const packageRoot = resolve(dirname(thisFile), '..');
    const dashboardDir = resolve(packageRoot, 'dashboard');
    const viteBin = resolve(dashboardDir, 'node_modules', '.bin', 'vite');

    if (!(await fileExists(viteBin))) {
      console.error(
        'Vite not found. Run "npm ci --prefix dashboard" first, or use the default bundled dashboard mode.',
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
  } else if (mode === 'server-only') {
    const url = `http://localhost:${port}`;
    console.log(`Syntaur Dashboard API running at ${url}`);
  } else {
    const url = `http://localhost:${port}`;
    console.log(`Syntaur Dashboard running at ${url}`);

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
