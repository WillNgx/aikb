import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { applyTheme, getInitialTheme } from './lib/theme';
import { setupI18n } from './lib/i18n';
import './index.css';

// Áp theme TRƯỚC khi render để tránh nháy màu, và để trang Đăng nhập (nằm ngoài AppLayout)
// cũng nhận được đúng theme — xem lib/theme.ts.
applyTheme(getInitialTheme());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// Nạp từ điển ngôn ngữ TRƯỚC khi render, cùng lý do với theme: render trước rồi mới có bản dịch
// sẽ làm toàn bộ giao diện nháy một lượt chữ chưa dịch.
setupI18n().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>
  );
});
