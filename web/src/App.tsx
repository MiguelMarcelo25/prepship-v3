import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Orders from './pages/Orders';
import Shipments from './pages/Shipments';
import Packages from './pages/Packages';
import Clients from './pages/Clients';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/orders" replace />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/shipments" element={<Shipments />} />
        <Route path="/packages" element={<Packages />} />
        <Route path="/clients" element={<Clients />} />
      </Route>
    </Routes>
  );
}
