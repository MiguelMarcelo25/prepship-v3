import { defineConfig } from '@playwright/test'

/**
 * PS-507 — config for persistence-proving specs.
 *
 * Separate from playwright.config.js on purpose. That config starts its own dev:web on
 * 5177 with a mocked anon key and a globalSetup that asserts 5177 is serving it; running
 * a PS-507 spec under it would boot the wrong app against the wrong API and still pass,
 * because the mocked suite never touches a database.
 *
 * Here the STACK owns every server. There is no `webServer` block and no globalSetup —
 * scripts/ps-507-qa-stack.mjs provisions the database, API and frontend, then runs
 * Playwright as a child with the PS507_* variables set. A spec started without the stack
 * fails fast in qaEnv() with the command to use, rather than quietly testing nothing.
 *
 *   NODE_ENV=test node scripts/ps-507-qa-stack.mjs -- \
 *     npx playwright test -c playwright.ps507.config.js
 */
export default defineConfig({
  testDir: './web/e2e',
  testMatch: /ps-507-.*\.spec\.js/,
  // The stack is provisioned once and shared, and PGlite serves a single connection, so
  // parallel workers would contend for it. Serial is a property of the design, not a
  // timidity setting — see the DB_POOL_MAX note in the stack.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Points at the stack's frontend, never 5177.
    baseURL: process.env.PS507_WEB_URL,
    trace: 'retain-on-failure',
  },
})
