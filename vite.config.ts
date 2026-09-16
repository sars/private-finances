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
  // Recharts is imported only by components/charts/, and only through a lazy
  // import, so it splits into its own chunk on its own. A manual chunk group
  // was tried and dropped: Rolldown's CommonJS interop breaks when a group is
  // cut across a shared dependency (react-is, use-sync-external-store) —
  // "require_react_is is not a function" at runtime. scripts/check_frontend.py
  // walks the entry's static imports and fails if chart code is reachable.
  build: { outDir: '../dist/frontend', emptyOutDir: true },
});
