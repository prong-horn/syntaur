import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@shared/query-registry': fileURLToPath(new URL('./src/utils/query/registry.ts', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/utils', import.meta.url)),
    },
  },
  test: {
    include: ['dashboard/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30000,
  },
});
