import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/dashboard/server.ts',
    'src/db/leases-db.ts',
  ],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  // `better-sqlite3` is a native module resolved at runtime, so it stays
  // external rather than being bundled.
  external: ['better-sqlite3'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
