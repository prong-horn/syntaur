import { readConfig } from '../utils/config.js';
import { createDashboardServer } from '../dashboard/server.js';

export interface DashboardOptions {
  port: string;
  dev: boolean;
  open: boolean;
}

export async function dashboardCommand(options: DashboardOptions): Promise<void> {
  const config = await readConfig();
  const missionsDir = config.defaultMissionDir;
  const port = parseInt(options.port, 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${options.port}". Must be a number between 1 and 65535.`);
  }

  const server = createDashboardServer({
    port,
    missionsDir,
    devMode: options.dev,
  });

  await server.start();

  const url = `http://localhost:${port}`;
  console.log(`Syntaur Dashboard running at ${url}`);

  if (options.dev) {
    console.log('Dev mode: Start Vite dev server with "npm run dev:dashboard"');
    console.log(`Vite should proxy API requests to http://localhost:${port}`);
  }

  if (options.open && !options.dev) {
    try {
      const openModule = await import('open');
      await openModule.default(url);
    } catch {
      console.log(`Open ${url} in your browser to view the dashboard.`);
    }
  }

  // Keep the process running
  const shutdown = async () => {
    console.log('\nShutting down dashboard...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
