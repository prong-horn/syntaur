import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/dashboard/server.ts',
    'src/db/leases-db.ts',
    'src/launch/index.ts',
    'src/daemon/pty-host-main.ts',
  ],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  external: ['better-sqlite3', 'node-pty'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
