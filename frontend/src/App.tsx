import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authApi } from './api';
import { TOKEN_HINT_KEY } from './lib/supabase';
import { ensureActiveKb } from './lib/kb';

// Pages
import LoginPage from './pages/LoginPage';
import WikiPage from './pages/WikiPage';
import ChatPage from './pages/ChatPage';
import KnowledgeListPage from './pages/KnowledgeListPage';
import PromotionsPage from './pages/PromotionsPage';
import AdminUsersPage from './pages/admin/AdminUsersPage';
import AdminAnalyticsPage from './pages/admin/AdminAnalyticsPage';
import AdminAuditPage from './pages/admin/AdminAuditPage';
import AdminSlangPage from './pages/admin/AdminSlangPage';
import AdminTelegramPage from './pages/admin/AdminTelegramPage';
import AdminAiSettingsPage from './pages/admin/AdminAiSettingsPage';
import AdminKbPage from './pages/admin/AdminKbPage';
import AdminSystemPromptPage from './pages/admin/AdminSystemPromptPage';

// Layout
import AppLayout from './components/AppLayout';
import { ConfirmProvider } from './components/ConfirmModal';

interface User { id: string; email: string; role: 'super_admin' | 'admin' | 'user'; defaultKb: string; }

/**
 * `adminOnly` = Quản trị KB hoặc Quản trị hệ thống; `superAdminOnly` = chỉ Quản trị hệ thống.
 * Đây chỉ là lớp điều hướng cho đỡ vào nhầm trang — quyền thật chốt ở backend.
 */
function ProtectedRoute({
  children,
  adminOnly = false,
  superAdminOnly = false,
}: {
  children: React.ReactNode;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
}) {
  // Cờ đồng bộ để quyết định điều hướng ngay ở lần render đầu — token thật dùng gọi API do
  // api/client.ts lấy từ SDK Supabase (xem lib/supabase.ts).
  const token = localStorage.getItem(TOKEN_HINT_KEY);
  const { data: user, isLoading, isError } = useQuery<User>({
    queryKey: ['me'],
    queryFn: authApi.getMe,
    enabled: !!token,
    retry: false,
  });

  if (!token) return <Navigate to="/login" replace />;
  if (isLoading) return (
    <div className="d-flex justify-content-center align-items-center" style={{ height: '100vh' }}>
      <div className="spinner-custom" />
    </div>
  );
  if (isError) return <Navigate to="/login" replace />;

  // Lần đăng nhập đầu: mở đúng KB mặc định của tài khoản (không ghi đè nếu người dùng đã tự chọn)
  if (user?.defaultKb) ensureActiveKb(user.defaultKb);
  const laQuanTri = user?.role === 'super_admin' || user?.role === 'admin';
  if (adminOnly && !laQuanTri) return <Navigate to="/documents" replace />;
  if (superAdminOnly && user?.role !== 'super_admin') return <Navigate to="/documents" replace />;

  return <AppLayout user={user!}>{children}</AppLayout>;
}

// react-router không remount WikiPage khi chỉ đổi :id giữa 2 bài viết (cùng 1 Route) — nếu
// không có key này, state Chỉnh sửa (isEditing/editBlocks) của bài viết cũ sẽ rò rỉ sang bài
// viết mới khi điều hướng trực tiếp giữa 2 URL /wiki/:id. key={id} buộc remount đúng lúc.
function WikiPageRoute() {
  const { id } = useParams<{ id: string }>();
  return <WikiPage key={id} />;
}

export default function App() {
  return (
    <ConfirmProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          {/* Protected routes */}
          <Route path="/documents" element={<ProtectedRoute><KnowledgeListPage /></ProtectedRoute>} />
          <Route path="/wiki/:id" element={<ProtectedRoute><WikiPageRoute /></ProtectedRoute>} />
          <Route path="/chat" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
          <Route path="/promotions" element={<ProtectedRoute><PromotionsPage /></ProtectedRoute>} />

          {/* Admin routes */}
          <Route path="/admin/users" element={<ProtectedRoute adminOnly><AdminUsersPage /></ProtectedRoute>} />
          <Route path="/admin/kb" element={<ProtectedRoute superAdminOnly><AdminKbPage /></ProtectedRoute>} />
          <Route path="/admin/system-prompt" element={<ProtectedRoute adminOnly><AdminSystemPromptPage /></ProtectedRoute>} />
          <Route path="/admin/analytics" element={<ProtectedRoute adminOnly><AdminAnalyticsPage /></ProtectedRoute>} />
          <Route path="/admin/ai-settings" element={<ProtectedRoute superAdminOnly><AdminAiSettingsPage /></ProtectedRoute>} />
          <Route path="/admin/audit" element={<ProtectedRoute adminOnly><AdminAuditPage /></ProtectedRoute>} />
          <Route path="/admin/slang" element={<ProtectedRoute adminOnly><AdminSlangPage /></ProtectedRoute>} />
          <Route path="/admin/telegram" element={<ProtectedRoute superAdminOnly><AdminTelegramPage /></ProtectedRoute>} />

          <Route path="/" element={<Navigate to="/documents" replace />} />
          <Route path="*" element={<Navigate to="/documents" replace />} />
        </Routes>
      </BrowserRouter>
    </ConfirmProvider>
  );
}
