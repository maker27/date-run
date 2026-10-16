import { defineConfig, devices } from '@playwright/test';

const appPort = 4173;
const controlPort = 4174;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${appPort}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: { args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--host-resolver-rules=MAP first.test 127.0.0.1,MAP second.test 127.0.0.1',
    ] },
  },
  webServer: {
    command: 'npm run test:e2e:server',
    url: `http://127.0.0.1:${controlPort}/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
