import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Lifecycle modules live outside src/utils — explicit, more-specific-first.
      '@shared/derive': fileURLToPath(new URL('./src/lifecycle/derive.ts', import.meta.url)),
      '@shared/state-machine': fileURLToPath(new URL('./src/lifecycle/state-machine.ts', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/utils', import.meta.url)),
    },
  },
  test: {
    include: ['dashboard/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
