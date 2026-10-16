import { defineConfig } from 'vite';

export default defineConfig({
  root: 'art/preview',
  base: '/date-run-art/',
  server: { port: 5174, strictPort: true },
  build: { outDir: '../../dist/art-preview', emptyOutDir: true },
});
