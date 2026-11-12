import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/organizer/',
  worker: {
    rolldownOptions: {
      output: {
        entryFileNames: 'gate/assets/[name]-[hash].js',
        chunkFileNames: 'gate/assets/[name]-[hash].js',
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/gate',
      filename: 'sw.ts',
      injectRegister: false,
      registerType: 'prompt',
      scope: '/organizer/gate/',
      manifest: {
        name: 'EventFlow — сканер билетов',
        short_name: 'EventFlow Gate',
        start_url: '/organizer/gate/',
        scope: '/organizer/gate/',
        display: 'standalone',
        theme_color: '#251a37',
        background_color: '#f7f4f2',
        icons: [
          { src: '/organizer/gate-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
      },
    }),
  ],
});
