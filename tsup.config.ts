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
  // tsup externalizes all `dependencies` by default. node-pty stays external
  // (native prebuild resolved at runtime), but the xterm packages are CJS whose
  // named exports (`Terminal`, `SerializeAddon`) are NOT resolvable by Node's
  // ESM loader from an `import { Terminal }` in our ESM output — so they must be
  // bundled (inlined) where esbuild handles the CJS→ESM interop at build time.
  noExternal: ['@xterm/headless', '@xterm/addon-serialize'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
