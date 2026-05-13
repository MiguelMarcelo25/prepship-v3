import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './contexts/ToastContext';
import { MarkupsProvider } from './contexts/MarkupsContext';
import { ThemeProvider } from './lib/ThemeProvider';
// 2026-05-13: DesignPicker (floating "Design" widget bottom-right)
// removed per operator decision to lock the app to one look:
//   • Theme:   "Sky Blue" (DEFAULT_THEME_ID = 'indigo')
//   • Sidebar: "Clean Linear" (variant 'A')
// The picker component file stays on disk in case we want to
// re-enable it later. To restore: re-add the import below and the
// <DesignPicker /> mount inside <BrowserRouter>.
// import DesignPicker from './components/DesignPicker';
import './index.css';
import './app-shell.css';
import './App.css';
import './mobile.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ToastProvider>
            <MarkupsProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </MarkupsProvider>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>
);
