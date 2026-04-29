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
