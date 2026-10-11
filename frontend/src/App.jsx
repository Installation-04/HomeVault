import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { PropertyProvider } from './property/PropertyContext.jsx';
import { ConfirmProvider } from './components/ConfirmDialog.jsx';
import PropertyGate from './components/PropertyGate.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Documents from './pages/Documents.jsx';
import DocumentDetail from './pages/DocumentDetail.jsx';
import Equipment from './pages/Equipment.jsx';
import EquipmentDetail from './pages/EquipmentDetail.jsx';
import Calendar from './pages/Calendar.jsx';
import Expenses from './pages/Expenses.jsx';
import Settings from './pages/Settings.jsx';

function Private({ children }) {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="p-8 text-center">{t('common.loading')}</div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
}

// Pages that act on the currently selected property.
const gated = (page) => <PropertyGate>{page}</PropertyGate>;

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <Private>
            <PropertyProvider>
              <Layout>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/documents" element={gated(<Documents />)} />
                  <Route path="/documents/:id" element={<DocumentDetail />} />
                  <Route path="/equipment" element={gated(<Equipment />)} />
                  <Route path="/equipment/:id" element={<EquipmentDetail />} />
                  <Route path="/calendar" element={gated(<Calendar />)} />
                  <Route path="/expenses" element={gated(<Expenses />)} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </Layout>
            </PropertyProvider>
          </Private>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ConfirmProvider>
        <AppRoutes />
      </ConfirmProvider>
    </AuthProvider>
  );
}
