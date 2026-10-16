import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

const domTests = [
  'tests/smoke/project.test.ts',
  'src/client/**/*.test.tsx',
  'src/client/**/input.test.ts',
  'src/client/**/game-scene.lifecycle.test.ts',
  'src/client/**/game-session.test.ts',
];

export default defineConfig({
  plugins: [preact()],
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['tests/deploy/**', ...domTests],
        },
      },
      {
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: domTests,
        },
      },
    ],
  },
});
