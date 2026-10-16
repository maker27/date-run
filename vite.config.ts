import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/date-run/',
  plugins: [preact()],
  build: {
    outDir: 'dist/client',
    sourcemap: false,
  },
  server: {
    proxy: {
      '/date-run/ws': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
      '/date-run/api': 'http://127.0.0.1:3000',
    },
  },
});
