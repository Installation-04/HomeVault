import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'HomeVault',
        short_name: 'HomeVault',
        description: 'Self-hosted home document & maintenance manager',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        // iOS (17+) reads categories/description too, but the meta tags in
        // index.html are what actually drive the pre-17 "Add to Home
        // Screen" experience — Safari doesn't use most of this manifest.
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Never let the service worker serve a stale copy of the app shell
        // when the user is on the (uncacheable, ever-changing) API — only
        // static build assets go through the cache.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Libraries change far less often than the app: keeping them in their own
        // files lets browsers (and the service worker) reuse them across updates.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
          if (/node_modules\/(react-router|react-router-dom|@remix-run)\//.test(id)) return 'vendor-router';
          if (/node_modules\/(i18next|react-i18next)\//.test(id)) return 'vendor-i18n';
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
