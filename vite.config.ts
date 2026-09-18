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
    // Installable on the phone. The worker precaches the built static files
    // only; nothing under /api is ever cached or served offline, so financial
    // data stays out of browser storage, and navigations always go to the
    // server, which serves the app for every screen route.
    VitePWA({
      // A new worker installs and then waits. `autoUpdate` was tried first and
      // is wrong for this app: it claims the open page the moment the new
      // worker activates and drops the old precache with it, after which the
      // next lazily loaded screen asks the server for a hashed file the release
      // has already removed. The household is asked instead, and nothing under
      // a screen in use changes until they say go — see lib/app-update.ts.
      registerType: 'prompt',
      // The app registers the worker itself. The script this would otherwise
      // inject registers on the document's `load` event and never again, and an
      // installed app is resumed rather than started, so it fires almost never
      // — which is why a new release used to need a reinstall to arrive.
      injectRegister: false,
      // Every route is behind HTTP Basic authentication. Without this the
      // browser fetches the manifest with credentials omitted, the server
      // answers 401 and the install prompt never appears.
      useCredentials: true,
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
        // No navigation is ever served from the cache, so the shell is not
        // precached either: html is left out of the patterns deliberately.
        // The server answers screen routes with index.html but has no
        // /index.html route of its own, so precaching it fails the whole
        // install with bad-precaching-response.
        navigateFallback: null,
        globPatterns: ['**/*.{js,css,woff2,svg,png}'],
        // With skipWaiting off, workbox gives the worker a message listener
        // instead, which is how the Update button hands the page over. The old
        // release's precache goes at that point and not before.
        skipWaiting: false,
        clientsClaim: false,
        cleanupOutdatedCaches: true,
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
