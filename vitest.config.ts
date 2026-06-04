import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Dashboard libs import shared schema via `@shared/*` (mapped to src/utils
      // in the dashboard's own tsconfig/vite). Some of those imports are now
      // runtime (not just type-only), so node-env tests that pull in a dashboard
      // lib must resolve `@shared` too.
      '@shared': fileURLToPath(new URL('./src/utils', import.meta.url)),
    },
  },
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    // Many tests spawn the built CLI (bin/syntaur.js) as a subprocess; some run
    // several spawns in one test. The default 5s budget overruns on slower CI
    // boxes and intermittently failed releases (0.28–0.30 release runs failed at
    // the test step on status-cmd.test.ts). Raise the ceiling for the whole
    // subprocess-heavy suite.
    testTimeout: 30000,
  },
});
