import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';

const Login = lazy(() => import('./pages/Login'));
const Logout = lazy(() => import('./pages/Logout'));
const Signup = lazy(() => import('./pages/Signup'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const PromptLibrary = lazy(() => import('./pages/PromptLibrary'));
const Home = lazy(() => import('./Home'));
const Picklist = lazy(() => import('./pages/Picklist'));
const Clients = lazy(() => import('./pages/Clients'));
const Products = lazy(() => import('./pages/Products'));
const Invoice = lazy(() => import('./pages/Invoice'));

function PageFallback() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-page animate-fadeIn">
      <div className="flex flex-col items-center gap-3">
        <div className="relative w-10 h-10">
          <div className="absolute inset-0 rounded-full border-2 border-line" />
          <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-brand animate-spinSlow" />
        </div>
        <div className="text-tiny text-ink-3 font-sans tracking-wide uppercase">
          Loading
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
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
        <Route
          path="/clients"
          element={
            <ProtectedRoute>
              <Clients />
            </ProtectedRoute>
          }
        />
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
  );
}
