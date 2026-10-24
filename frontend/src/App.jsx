import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthProvider, useAuth } from './auth/AuthContext.jsx';
import { PropertyProvider } from './property/PropertyContext.jsx';
import { ConfirmProvider } from './components/ConfirmDialog.jsx';
import PropertyGate from './components/PropertyGate.jsx';
import Layout from './components/Layout.jsx';

// Every page is its own chunk: the first paint only downloads the shell, and a
// page's code (QR codes, calendar grid, settings panels...) arrives when visited.
const Login = lazy(() => import('./pages/Login.jsx'));
const ForcePasswordChange = lazy(() => import('./pages/ForcePasswordChange.jsx'));
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Documents = lazy(() => import('./pages/Documents.jsx'));
const DocumentDetail = lazy(() => import('./pages/DocumentDetail.jsx'));
const Equipment = lazy(() => import('./pages/Equipment.jsx'));
const EquipmentDetail = lazy(() => import('./pages/EquipmentDetail.jsx'));
const Calendar = lazy(() => import('./pages/Calendar.jsx'));
const Expenses = lazy(() => import('./pages/Expenses.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="p-8 text-center text-gray-500" role="status">
      {t('common.loading')}
    </div>
  );
}

function Private({ children }) {
  const { user, loading, signedOut } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" state={signedOut ? null : { from: location }} replace />;
  // An admin-issued temporary password has to be replaced before anything else.
  if (user.must_change_password) return <ForcePasswordChange />;
  return children;
}

// Pages that act on the currently selected property.
const gated = (page) => <PropertyGate>{page}</PropertyGate>;

function AppRoutes() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <Private>
              <PropertyProvider>
                <Layout>
                  <Suspense fallback={<Loading />}>
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
                  </Suspense>
                </Layout>
              </PropertyProvider>
            </Private>
          }
        />
      </Routes>
    </Suspense>
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
