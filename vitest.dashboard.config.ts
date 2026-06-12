import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/utils', import.meta.url)),
    },
  },
  test: {
    include: ['dashboard/src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
