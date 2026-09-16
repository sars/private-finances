import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'frontend',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./frontend/src', import.meta.url)) },
  },
  build: {
    outDir: '../dist/frontend',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Recharts and the packages only it uses form one chunk that loads on
        // the screens that draw a chart, so the entry never carries it.
        // scripts/check_frontend.py fails the build if chart code reaches the entry.
        advancedChunks: {
          // Only the matched packages; without this Rolldown also drags their
          // dependencies (React itself) into the chunk and the entry then
          // imports it eagerly.
          includeDependenciesRecursively: false,
          groups: [
            {
              name: 'charts',
              test: /node_modules\/(recharts|victory-vendor|d3-[a-z-]+|react-smooth|recharts-scale|@reduxjs\/toolkit|redux|immer|reselect|es-toolkit|decimal\.js-light|internmap|fast-equals|eventemitter3)\//,
            },
          ],
        },
      },
    },
  },
});
