import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: 'frontend',
  plugins: [
    react(),
    tailwindcss(),
    // Installable on the phone. The worker precaches only the built shell and
    // static files; nothing under /api is ever cached or served offline, so
    // financial data stays out of browser storage, and navigations always go
    // to the server, which serves the app for every screen route.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'fonts/*.woff2'],
      manifest: {
        name: 'Private Finances',
        short_name: 'Finances',
        description: 'Household spending, reviewed together.',
        start_url: '/',
        display: 'standalone',
        background_color: '#f9fafb',
        theme_color: '#3b82f6',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        navigateFallback: null,
        globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
      },
    }),
  ],
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
