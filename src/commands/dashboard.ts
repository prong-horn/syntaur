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
  autoPort?: boolean;
}

export type DashboardRuntimeMode = 'static' | 'dev' | 'server-only';

export function didUserSpecifyDashboardPort(argv: string[] = process.argv): boolean {
  return argv.some((arg) => arg === '--port' || arg.startsWith('--port='));
}

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

    tester.listen(port);
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
  const requestedPort = parseInt(options.port, 10);

  if (isNaN(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    throw new Error(`Invalid port "${options.port}". Must be a number between 1 and 65535.`);
  }

  const mode = resolveDashboardMode(options);
  let port = requestedPort;

  if (options.autoPort) {
    const availablePort = await findAvailablePort(requestedPort);
    if (availablePort === null) {
      throw new Error(
        `Could not find an available dashboard port starting at ${requestedPort}. Run "syntaur dashboard --port <number>" to choose one manually.`,
      );
    }
    if (availablePort !== requestedPort) {
      console.log(`Port ${requestedPort} is busy. Launching the dashboard on port ${availablePort} instead.`);
    }
    port = availablePort;
  }

  // Compute the dashboard dist path relative to this file's location.
  // After tsup bundling, import.meta.url resolves to dist/index.js so we
  // go one level up to the package root, then into dashboard/dist.
  const thisFile = fileURLToPath(import.meta.url);
  const packageRoot = resolve(dirname(thisFile), '..');
  const dashboardDist = resolve(packageRoot, 'dashboard', 'dist');

  const server = createDashboardServer({
    port,
    missionsDir,
    serversDir: getServersDir(),
    playbooksDir: getPlaybooksDir(),
    todosDir: getTodosDir(),
    serveStaticUi: mode === 'static',
    dashboardDistPath: dashboardDist,
  });

  await server.start();

  let viteProcess: ChildProcess | null = null;

  if (mode === 'dev') {
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
  let shuttingDown = false;
  const forceExit = () => {
    console.log('\nForce exit.');
    if (viteProcess) {
      try { viteProcess.kill('SIGKILL'); } catch {}
    }
    process.exit(1);
  };
  const shutdown = async () => {
    if (shuttingDown) {
      forceExit();
      return;
    }
    shuttingDown = true;
    console.log('\nShutting down dashboard... (press Ctrl+C again to force)');
    if (viteProcess) {
      viteProcess.kill();
    }
    try {
      await server.stop();
    } catch (err) {
      console.error('Error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
