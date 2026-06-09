import { useEffect, type ReactElement } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ConnectWalletModal } from './components/ConnectWalletModal';
import { PortfolioPage } from './pages/PortfolioPage';
import { DepositPage } from './pages/DepositPage';
import { SendPage } from './pages/SendPage';
import { ReceivePage } from './pages/ReceivePage';
import { WithdrawPage } from './pages/WithdrawPage';
import { HistoryPage } from './pages/HistoryPage';
import { SetupPage } from './pages/SetupPage';
import { SettingsPage } from './pages/SettingsPage';
import { PayrollPage } from './pages/PayrollPage';
import { BlockedPage } from './pages/BlockedPage';
import { useWallet } from './hooks/WalletContext';
import { TokenProvider } from './hooks/TokenContext';
import { CurrencyProvider } from './hooks/CurrencyContext';
import { Toaster } from 'sonner';
import { DebugPanel } from './components/DebugPanel';
import { dbgEnabled } from './lib/debugLog';

function ProtectedRoute({ element }: { element: ReactElement }) {
  const w = useWallet();
  if (w.isRestoringSession) return null;
  if (!w.shieldedAddress) return <Navigate to="/setup" replace />;
  return element;
}

export function App() {
  const w = useWallet();
  const nav = useNavigate();

  useEffect(() => {
    if (w.stellarAddress && !w.shieldedAddress && !w.isInitializing) {
      nav('/setup', { replace: true });
    }
  }, [w.stellarAddress, w.shieldedAddress, w.isInitializing]);

  return (
    <>
      {dbgEnabled() && <DebugPanel />}
      <Toaster position="bottom-right" theme="light" duration={4000} />
      {!w.isRestoringSession && !w.stellarAddress && <ConnectWalletModal />}
      <CurrencyProvider>
      <TokenProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<PortfolioPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/deposit" element={<ProtectedRoute element={<DepositPage />} />} />
            <Route path="/send" element={<ProtectedRoute element={<SendPage />} />} />
            <Route path="/receive" element={<ProtectedRoute element={<ReceivePage />} />} />
            <Route path="/withdraw" element={<ProtectedRoute element={<WithdrawPage />} />} />
            <Route path="/history" element={<ProtectedRoute element={<HistoryPage />} />} />
            <Route path="/payroll" element={<ProtectedRoute element={<PayrollPage />} />} />
            <Route path="/settings" element={<ProtectedRoute element={<SettingsPage />} />} />
            <Route path="/blocked" element={<BlockedPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </TokenProvider>
      </CurrencyProvider>
    </>
  );
}
