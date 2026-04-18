import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import Login from './pages/Login';
import Orders from './pages/Orders';
import Packages from './pages/Packages';
import ComingSoon from './pages/ComingSoon';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route
          path="/"
          element={<Navigate to="/orders/awaiting_shipment" replace />}
        />
        <Route
          path="/orders"
          element={<Navigate to="/orders/awaiting_shipment" replace />}
        />
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
  );
}
