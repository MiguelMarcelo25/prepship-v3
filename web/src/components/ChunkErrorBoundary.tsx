// 2026-05-15: React Error Boundary that auto-recovers from stale-bundle
// chunk-load failures after a Vercel deploy.
//
// Why this exists (boss-reported via screenshot 2026-05-15: "we are
// still getting lots of white screens"):
//
// React.lazy() chunk-load failures are reported as Promise rejections
// from the import() call. In ideal conditions Vite dispatches a
// `vite:preloadError` event the window handler in main.tsx catches.
// BUT — when a lazy chunk fails INSIDE React's rendering cycle, React
// + Suspense converts the rejection into a render-time throw and
// catches it BEFORE the rejection reaches the window. Without an
// error boundary above the Suspense, React then unmounts the entire
// subtree (including the root in our case) → blank white page.
//
// The window-level handler in main.tsx covers escaped rejections; this
// boundary covers the React-side render-throw path. Together they
// catch ~100% of stale-bundle scenarios. They share the same
// sessionStorage gate so we don't double-reload or infinite-loop.
//
// What "stale bundle" means here: Vite generates content-hashed
// chunk filenames (e.g. Home-CsPzIM7L.js). When a deploy ships,
// hashes change and the old chunks are deleted from the CDN. Any
// browser tab with the OLD index.html cached still tries to fetch
// the OLD filenames → 404 → React.lazy throws → without this
// boundary, white screen.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import MaintenanceModePage from './MaintenanceModePage';

const RELOAD_FLAG = 'prepship.preloadErrorReload';

// Same pattern as main.tsx's unhandledrejection guard. Kept in sync
// deliberately — both layers should have identical detection logic so
// neither over- nor under-fires relative to the other.
function isChunkLoadError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? '');
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Loading chunk \S+ failed/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    // Some browsers report the failure with the literal asset URL
    // wrapped in a less-helpful TypeError. Match the asset path
    // shape as a last-ditch heuristic — if we see a 404-shaped URL
    // ending in a hashed .js filename, treat it as a chunk error.
    /\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.js/i.test(message)
  );
}

interface State {
  // We don't store the error itself when reloading; we just need a
  // boolean to switch between "render children" and "show fallback".
  // Storing the error would tempt us into rendering it on screen,
  // which leaks build internals to operators.
  hasError: boolean;
  // Set when we determine the error is a stale bundle and we're
  // about to call window.location.reload(). Used to render a brief
  // "Reloading…" placeholder instead of a flash of fallback UI.
  isReloading: boolean;
  // Captured once per crash so the user-visible fallback can show
  // the message without us holding on to the full Error object.
  errorMessage: string | null;
}

interface Props {
  children: ReactNode;
}

export default class ChunkErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    isReloading: false,
    errorMessage: null,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Capture the error so render() knows what to do. We DON'T
    // call sessionStorage / location.reload here — that side effect
    // belongs in componentDidCatch, where it's safe per React docs.
    return {
      hasError: true,
      errorMessage: error.message,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Always log so the operator's debug console has the full
    // error + component stack. Future incident triage relies on this.
    console.error('[ChunkErrorBoundary] caught render error:', error, info);

    if (isChunkLoadError(error)) {
      // Stale-bundle path. Reload once per session, then surface the
      // fallback if the reload itself also crashes (Vercel deploy
      // mid-flight = new index.html not yet live).
      if (sessionStorage.getItem(RELOAD_FLAG)) {
        console.warn(
          '[ChunkErrorBoundary] stale-bundle reload already attempted this session — surfacing fallback UI'
        );
        return;
      }
      console.info(
        '[ChunkErrorBoundary] stale bundle detected during render — reloading to pick up the new deploy'
      );
      sessionStorage.setItem(RELOAD_FLAG, '1');
      this.setState({ isReloading: true });
      // Defer the reload one tick so React has a chance to commit
      // the isReloading state — otherwise the user sees a flash of
      // the fallback UI before the reload kicks in.
      setTimeout(() => {
        window.location.reload();
      }, 0);
    }
    // Non-chunk errors fall through to the fallback UI in render().
    // We could plug in Sentry / error reporting here once that's
    // wired up — for now the console log is the primary signal.
  }

  // Operator-facing reload button on the fallback UI. Bypasses the
  // sessionStorage gate because the operator clicked it explicitly —
  // they're aware of what they're doing and we don't want to lock
  // them out of retrying. Clearing the flag also re-enables the
  // automatic auto-recovery for whatever chunk error happens next.
  handleManualReload = (): void => {
    sessionStorage.removeItem(RELOAD_FLAG);
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.isReloading) {
      // Brief "Reloading…" sliver shown for the ~50-100 ms between
      // setState and window.location.reload(). Pure surface color
      // so it reads as "we're moving, not crashed."
      return (
        <div className="min-h-screen bg-page flex items-center justify-center">
          <div className="text-[13px] text-ink-3 animate-pulse">
            Reloading to pick up the latest version…
          </div>
        </div>
      );
    }

    if (this.state.hasError) {
      const isChunk = isChunkLoadError({ message: this.state.errorMessage ?? '' });
      // Two messages depending on the error class:
      //   • Chunk error that already retried → "still failing, please
      //     refresh manually". Operator gets the explicit cause.
      //   • Other render error → generic "something went wrong" with
      //     the message detail beneath. Don't pretend it was a
      //     deploy issue if it wasn't — that misleads incident triage.
      return (
        <MaintenanceModePage
          mode={isChunk ? 'frontend' : 'checking'}
          detail={
            isChunk
              ? 'This tab is holding an older frontend bundle while a new deployment is publishing.'
              : this.state.errorMessage
          }
          onRetry={this.handleManualReload}
        />
      );
    }

    return this.props.children;
  }
}
