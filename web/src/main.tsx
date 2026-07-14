import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './contexts/ToastContext';
import { MarkupsProvider } from './contexts/MarkupsContext';
import { ThemeProvider } from './lib/ThemeProvider';
import { runUiCacheVersionMigration } from './lib/ui-cache-version';
import { queryClient } from './lib/query-client';
// 2026-05-13: DesignPicker (floating "Design" widget bottom-right)
// removed per operator decision to lock the app to one look:
//   • Theme:   "Sky Blue" (DEFAULT_THEME_ID = 'indigo')
//   • Sidebar: "Clean Linear" (variant 'A')
// The picker component file stays on disk in case we want to
// re-enable it later. To restore: re-add the import below and the
// <DesignPicker /> mount inside <BrowserRouter>.
// import DesignPicker from './components/DesignPicker';
import './index.css';
import './app-shell.css';
import './App.css';
import './mobile.css';

runUiCacheVersionMigration();

// 2026-05-15: Stale-bundle auto-recovery after a Vercel deploy.
//
// The bug this fixes (boss-reported via screenshot 2026-05-15):
//   1. User has prepshipv4.vercel.app open in a tab. Browser has the
//      OLD index.html cached, which references chunk filenames like
//      `Home-BewFyFVE.js` (Vite uses content-based hashing).
//   2. We deploy. Vercel publishes the NEW build with new chunk
//      hashes (e.g. `Home-CDykrWnl.js`) and DELETES the old chunks
//      from the CDN — Vercel only retains the latest deploy's
//      assets at the static URLs.
//   3. User's stale tab navigates to a route that lazy-loads Home
//      → browser fetches `Home-BewFyFVE.js` → 404.
//   4. React's lazy-import promise rejects → app crashes mid-route
//      → blank page or stuck spinner. Symptom in the boss's
//      screenshot: "Loading inventory…" forever, console showing
//      `Failed to fetch dynamically imported module`.
//
// Vite fires a `vite:preloadError` event for exactly this case —
// it's the documented escape hatch. We catch it (and the matching
// unhandled rejection as defense-in-depth, since not every browser/
// router config dispatches the event) and force a hard reload. The
// reload pulls down the new index.html which references the new
// chunk filenames, and the user is back in business — usually
// within 1-2 seconds, transparently.
//
// The sessionStorage gate prevents an infinite reload loop in the
// rare case where the reload ITSELF also 404s (e.g. a Vercel deploy
// is mid-flight and the new index.html isn't yet live). After one
// failed retry per session we let the error bubble so the operator
// sees something — still bad, but not a reload-loop denial-of-self.
const RELOAD_FLAG = 'prepship.preloadErrorReload';

function reloadOnceForStaleBundle(reason: string): void {
  if (sessionStorage.getItem(RELOAD_FLAG)) {
    console.warn(`[main] stale-bundle reload already attempted this session (${reason}); letting error surface to avoid loop`);
    return;
  }
  console.info(`[main] stale-bundle detected (${reason}) — reloading to pick up the new deploy`);
  sessionStorage.setItem(RELOAD_FLAG, '1');
  window.location.reload();
}

window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  reloadOnceForStaleBundle('vite:preloadError event');
});

// Defense-in-depth: some bundler / browser combinations don't
// dispatch the event. Match the rejection by message instead. The
// regex covers the modern Vite message AND the legacy "Loading
// chunk N failed" / "Importing a module script failed" variants
// from older toolchains/polyfills, in case the build pipeline
// ever changes.
window.addEventListener('unhandledrejection', (event) => {
  const message = String(
    (event.reason as { message?: unknown } | null)?.message ?? event.reason ?? ''
  );
  const isChunkError =
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Loading chunk \S+ failed/i.test(message) ||
    /Importing a module script failed/i.test(message);
  if (!isChunkError) return;
  event.preventDefault();
  reloadOnceForStaleBundle('unhandledrejection / chunk-load');
});

// Once the page has successfully booted (no chunk failures during
// initial render), clear the gate so the NEXT deploy gets a fresh
// retry budget. The 5-second delay gives any deferred lazy imports
// (route prefetch, etc.) a chance to either succeed or fail loudly
// before we drop the safety net.
window.addEventListener('load', () => {
  setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5_000);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <MarkupsProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </MarkupsProvider>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>
);
