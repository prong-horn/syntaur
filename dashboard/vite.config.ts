import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const apiPort = process.env.VITE_API_PORT ?? '4800';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared/hotkeys-catalog': resolve(__dirname, '../src/utils/hotkeysCatalog.ts'),
      '@shared/view-prefs-schema': resolve(__dirname, '../src/utils/view-prefs-schema.ts'),
      '@shared/saved-views-schema': resolve(__dirname, '../src/utils/saved-views-schema.ts'),
      '@shared/saved-view-builder': resolve(__dirname, '../src/utils/saved-view-builder.ts'),
      '@shared/agents-schema': resolve(__dirname, '../src/utils/agents-schema.ts'),
      '@shared/terminal-schema': resolve(__dirname, '../src/utils/terminal-schema.ts'),
      '@shared/branch-name': resolve(__dirname, '../src/utils/branch-name.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
