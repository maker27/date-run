import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/date-run/',
  plugins: [
    {
      name: 'date-run-test-entry',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replace('/src/client/main.tsx', '/tests/fixtures/client-entry.ts');
        },
      },
    },
    preact(),
  ],
  build: {
    outDir: 'dist/test-client',
    sourcemap: false,
  },
});
