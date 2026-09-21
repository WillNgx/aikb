import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { applyTheme, getInitialTheme, saveTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';
import DocFolderTree from './DocFolderTree';
import AIChatWidget from './AIChatWidget';
import { signOut } from '../lib/supabase';
import KbSwitcher, { KbContextBanner } from './KbSwitcher';
import { useTranslation } from 'react-i18next';

interface User { id: string; email: string; role: 'super_admin' | 'admin' | 'user'; defaultKb: string; }

interface AdminNavItem {
  to: string;
  labelKey: string;
  icon: string;
  comingSoon?: boolean;
  /** Chỉ Quản trị hệ thống thấy — các việc ở tầm hệ thống, không thuộc riêng KB nào. */
  superAdminOnly?: boolean;
}

const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { to: '/admin/users', labelKey: 'layout.nav.users', icon: '👥' },
  { to: '/admin/kb', labelKey: 'layout.nav.kb', icon: '🗂', superAdminOnly: true },
  { to: '/admin/system-prompt', labelKey: 'layout.nav.systemPrompt', icon: '💬' },
  { to: '/admin/slang', labelKey: 'layout.nav.slang', icon: '🔤' },
  { to: '/admin/telegram', labelKey: 'layout.nav.telegram', icon: '✈️', superAdminOnly: true },
  { to: '/admin/analytics', labelKey: 'layout.nav.analytics', icon: '📊' },
  { to: '/admin/ai-settings', labelKey: 'layout.nav.aiSettings', icon: '⚙️', superAdminOnly: true },
  { to: '/admin/audit', labelKey: 'layout.nav.audit', icon: '🔒' },
];


export default function AppLayout({ children, user }: { children: React.ReactNode; user: User }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Theme đã được main.tsx áp dụng lúc khởi động (xem lib/theme.ts) — ở đây chỉ đọc lại để
  // biết đang ở chế độ nào mà hiển thị đúng biểu tượng nút.
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const toggleTheme = () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  };

  // Phải gọi signOut() của Supabase chứ không chỉ xoá cờ hint: nếu chỉ xoá cờ, phiên (kèm
  // refresh token) vẫn còn trong localStorage của SDK và lần vào lại sẽ tự đăng nhập lại.
  const handleLogout = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="app-shell">
      {/* Sidebar */}
      <nav className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-brand-row">
          <NavLink to="/documents" className="sidebar-brand">
            <span className="brand-icon">🧠</span>
            <div className="brand-text-block">
              <span className="brand-title">KnowledgeBase</span>
              <span className="brand-subtitle">{t("layout.brandSubtitle")}</span>
            </div>
          </NavLink>
          <button
            onClick={toggleTheme}
            title={t("layout.toggleTheme")}
            aria-label={t("layout.toggleTheme")}
            className="footer-btn theme-toggle-btn"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>

        {/* Chọn Knowledge Base (ngôn ngữ). Chỉ hiện khi có từ 2 KB trở lên. */}
        <KbSwitcher />

        {/* Chuyển qua lại giữa 2 khu vực: cây Tài liệu KB và trang Khuyến mãi. Khuyến mãi nằm
            ở bảng riêng với vòng đời riêng (nhập lại hàng tuần, có phiên bản) nên không gắn vào
            cây tài liệu được — người dùng chuyển bằng nút này. */}
        <div className="kb-switcher" role="tablist" aria-label={t("layout.switchArea")}>
          <NavLink
            to="/documents"
            role="tab"
            className={({ isActive }) => (isActive ? 'active' : '')}
            onClick={() => setSidebarOpen(false)}
          >
            📚 {t("layout.tabDocuments")}
          </NavLink>
          <NavLink
            to="/promotions"
            role="tab"
            className={({ isActive }) => (isActive ? 'active' : '')}
            onClick={() => setSidebarOpen(false)}
          >
            🎁 {t("layout.tabPromotions")}
          </NavLink>
        </div>

        <div className="sidebar-scrollable-content">
          {/* Main Section: TÀI LIỆU (Folder System Tree) */}
          <div className="sidebar-section">
            <div className="sidebar-section-header">
              <NavLink to="/documents" className="section-title-link">
                <span className="section-dot" /> {t("layout.internalDocs")}
              </NavLink>
            </div>
            {/* Tree Explorer */}
            <div className="sidebar-tree-wrapper">
              <DocFolderTree onItemSelect={() => setSidebarOpen(false)} />
            </div>
          </div>

          {/* Admin Section */}
          {(user.role === 'super_admin' || user.role === 'admin') && (
            <div className="sidebar-section admin-section">
              <div className="sidebar-section-header admin-header">
                <span className="admin-badge">{t("layout.administration")}</span>
              </div>
              <div className="admin-nav-list">
                {ADMIN_NAV_ITEMS.filter(
                  (item) => !item.superAdminOnly || user.role === 'super_admin'
                ).map((item) => {
                  if (item.comingSoon) {
                    return (
                      <div
                        key={item.to}
                        className="nav-link-custom disabled-nav-item"
                        title={t("layout.comingSoonTitle")}
                      >
                        <span className="nav-icon" style={{ filter: 'grayscale(1)' }}>{item.icon}</span>
                        <span className="nav-label" style={{ opacity: 0.6 }}>{t(item.labelKey)}</span>
                        <span className="coming-soon-badge">{t("layout.comingSoon")}</span>
                      </div>
                    );
                  }
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) => `nav-link-custom ${isActive ? 'active' : ''}`}
                      onClick={() => setSidebarOpen(false)}
                    >
                      <span className="nav-icon">{item.icon}</span>
                      <span className="nav-label">{t(item.labelKey)}</span>
                    </NavLink>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Bottom user section */}
        <div className="sidebar-user-footer">
          <div className="user-avatar-pill">
            {user.email[0].toUpperCase()}
          </div>
          <div className="user-meta-info">
            <div className="user-email-text" title={user.email}>
              {user.email}
            </div>
            <div className="user-role-badge">
              <span className={`role-dot ${user.role}`} />
              {user.role === 'admin' ? t("layout.roleAdmin") : t("layout.roleUser")}
            </div>
          </div>
          <div className="user-action-buttons">
            <button
              onClick={handleLogout}
              title={t("layout.logout")}
              aria-label={t("layout.logout")}
              className="footer-btn logout-btn"
            >
              🚪
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          className="mobile-backdrop"
        />
      )}

      {/* Main content */}
      <main className="main-content">
        {/* Mobile menu header */}
        <div className="mobile-top-bar d-md-none">
          <button
            className="mobile-toggle-btn"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            ☰ {t("layout.menu")}
          </button>
          <span className="mobile-brand-title">🧠 KnowledgeBase</span>
        </div>

        <div className="content-inner-wrapper">
          <KbContextBanner defaultKb={user.defaultKb} />
          {children}
        </div>
      </main>

      {/* Floating AI Chat Widget across all pages */}
      <AIChatWidget />
    </div>
  );
}
