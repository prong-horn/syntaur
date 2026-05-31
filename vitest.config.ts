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
  },
});
