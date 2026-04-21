import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';

const Login = lazy(() => import('./pages/Login'));
const Home = lazy(() => import('./Home'));
const Picklist = lazy(() => import('./pages/Picklist'));
const Clients = lazy(() => import('./pages/Clients'));
const Products = lazy(() => import('./pages/Products'));
const Invoice = lazy(() => import('./pages/Invoice'));

function PageFallback() {
  return (
    <div className="h-full w-full flex items-center justify-center text-ink-3 text-sm2">
      Loading…
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<Login />} />
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
