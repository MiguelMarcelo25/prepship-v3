import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './web/e2e',
  // PS-317 (Hermes review-readiness): the dev server compiles the app on-demand on the FIRST
  // navigation, so the first test of a freshly-started (cold) server can exceed a tight timeout and
  // flake — which is exactly what a clean review worktree hits. Give the cold first-compile headroom.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  webServer: {
    command: 'npm run dev:web -- --host 127.0.0.1 --port 5177',
    url: 'http://127.0.0.1:5177',
    reuseExistingServer: true,
    timeout: 60_000,
    // PS-317 (Hermes review-readiness): pin the Supabase project ref the app derives its auth-token
    // localStorage key (sb-<ref>-auth-token) from, so the e2e specs' MOCKED session is recognised in a
    // CLEAN worktree with dummy env. Without this, a clean worktree derives a different ref, the app
    // can't find the seeded session, and every Orders e2e cert redirects to the sign-in page (which
    // failed orders-dom-parity + orders-ps317-workflow-proof in Hermes's review). Vite's loadEnv gives
    // process.env VITE_* precedence over .env files, so this overrides whatever the worktree's env holds.
    // No real Supabase calls happen — every e2e request is mocked via page.route + the anon key is a dummy.
    env: {
      VITE_SUPABASE_URL: 'https://fdkseckgfuvdczzqmnac.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'e2e-mock-anon-key-not-a-real-secret',
    },
  },
})
