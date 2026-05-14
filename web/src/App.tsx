import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import PageSkeleton from './components/PageSkeleton';
// 2026-05-15: Catches React.lazy chunk-load failures during render.
// Required because Suspense converts lazy-import rejections into
// render-time throws that the window-level handler in main.tsx
// cannot intercept — without an error boundary above Suspense,
// React unmounts the entire tree (white screen). See the file
// header for the complete failure-mode analysis.
import ChunkErrorBoundary from './components/ChunkErrorBoundary';

const Login = lazy(() => import('./pages/Login'));
const Logout = lazy(() => import('./pages/Logout'));
const Signup = lazy(() => import('./pages/Signup'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const PromptLibrary = lazy(() => import('./pages/PromptLibrary'));
const Home = lazy(() => import('./Home'));
const Picklist = lazy(() => import('./pages/Picklist'));
// Clients is no longer a standalone route — Home.tsx lazy-imports
// ./pages/Clients itself and mounts it inside the app shell so the
// sidebar renders alongside. See the comment above the /clients
// fallthrough in the Routes block below.
const Products = lazy(() => import('./pages/Products'));
const Invoice = lazy(() => import('./pages/Invoice'));

export default function App() {
  return (
    // ChunkErrorBoundary wraps Suspense (NOT the other way around).
    // Suspense converts the lazy-import rejection into a render-time
    // throw that bubbles UP — so the boundary must sit ABOVE it to
    // catch the throw before React's reconciler unmounts the root.
    // Reversing the order would put the boundary inside the same
    // tree React just unmounted — no catch.
    <ChunkErrorBoundary>
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
        {/* Auth routes — the only public surface */}
        <Route path="/login" element={<Login />} />
        <Route path="/logout" element={<Logout />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/prompt-library" element={<PromptLibrary />} />

        {/* Protected app routes */}
        <Route
          path="/picklist"
          element={
            <ProtectedRoute>
              <Picklist />
            </ProtectedRoute>
          }
        />
        {/* /clients is intentionally NOT a standalone route. It falls
         * through to the /* catch-all below so Home.tsx mounts and the
         * sidebar renders alongside the Clients page. See Home.tsx's
         * displayView === 'clients' branch which renders <Clients />
         * (lazy-imported from ./pages/Clients) inside Home's content
         * area. Routing through the shell ensures consistent sidebar +
         * topbar chrome across every destination. */}
        <Route
          path="/products"
          element={
            <ProtectedRoute>
              <Products />
            </ProtectedRoute>
          }
        />
        <Route
          path="/invoice"
          element={
            <ProtectedRoute>
              <Invoice />
            </ProtectedRoute>
          }
        />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <Home />
            </ProtectedRoute>
          }
        />
        </Routes>
      </Suspense>
    </ChunkErrorBoundary>
  );
}
