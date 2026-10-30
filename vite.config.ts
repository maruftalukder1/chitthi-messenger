import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rolldownOptions: {
        output: {
          // Phase 5: vendor splitting (rolldown codeSplitting groups).
          // React and Firebase are split into their own long-lived
          // chunks so they cache independently of app code: an app-only
          // change no longer invalidates ~vendor bytes for returning
          // users, and the main app chunk shrinks to app code only.
          // Higher priority wins first: firebase's own transitive deps
          // live under @firebase/*, react's scheduler under its own name.
          codeSplitting: {
            groups: [
              {
                name: 'vendor-react',
                test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 20,
              },
              {
                name: 'vendor-firebase',
                test: /node_modules[\\/](firebase|@firebase)[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
    server: {
      // Dev-server host allowlist: Pinggy preview tunnels (production
      // serving does not use Vite, so this affects local previews only).
      allowedHosts: ['.free.pinggy.net', '.pinggy-free.link'],
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
