import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './web/e2e',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  webServer: {
    command: 'npm run dev:web -- --host 127.0.0.1 --port 5177',
    url: 'http://127.0.0.1:5177',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
