import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';

const Login = lazy(() => import('./pages/Login'));
const Orders = lazy(() => import('./pages/Orders'));
const Packages = lazy(() => import('./pages/Packages'));
const ComingSoon = lazy(() => import('./pages/ComingSoon'));

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
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Navigate to="/orders/awaiting_shipment" replace />} />
          <Route path="/orders" element={<Navigate to="/orders/awaiting_shipment" replace />} />
          <Route path="/orders/:status" element={<Orders />} />
          <Route path="/orders/:status/:orderId" element={<Orders />} />

          <Route path="/packages" element={<Packages />} />

          <Route path="/inventory" element={<ComingSoon title="Inventory" icon="📦" />} />
          <Route path="/locations" element={<ComingSoon title="Locations" icon="📍" />} />
          <Route path="/rates" element={<ComingSoon title="Rate Shop" icon="💰" />} />
          <Route path="/analysis" element={<ComingSoon title="Analysis" icon="📊" />} />
          <Route path="/settings" element={<ComingSoon title="Settings" icon="⚙️" />} />
          <Route path="/billing" element={<ComingSoon title="Billing" icon="🧾" />} />
          <Route path="/manifest" element={<ComingSoon title="Manifest" icon="📋" />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
