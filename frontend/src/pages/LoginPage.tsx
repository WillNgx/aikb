import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useTranslation } from "react-i18next";
import { DEFAULT_UI_LOCALE } from "../lib/i18n";

export default function LoginPage() {
  // Trang Đăng nhập LUÔN tiếng Anh (quyết định của chủ dự án), không theo nút EN/VI — nút đó chỉ
  // có sau khi đăng nhập. Từ điển tiếng Anh luôn được nạp sẵn lúc khởi động (xem lib/i18n.ts).
  const { t } = useTranslation(undefined, { lng: DEFAULT_UI_LOCALE });
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword(
        { email, password },
      );

      if (authError) {
        setError(t("login.wrongCredentials"));
        return;
      }

      // Không tự lưu token nữa: client Supabase dùng chung đã bật persistSession và tự đồng bộ
      // cờ TOKEN_HINT_KEY qua onAuthStateChange (xem lib/supabase.ts).
      if (data.session?.access_token) {
        navigate("/documents");
      }
    } catch {
      setError(t("login.connectionError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-brand">
          <div className="login-logo" aria-hidden="true">
            🧠
          </div>
          <h1 className="login-title">KnowledgeBase AI</h1>
          <p className="login-subtitle">{t("login.subtitle")}</p>
        </div>

        <form onSubmit={handleLogin}>
          {/* role="alert" để trình đọc màn hình đọc lên ngay khi đăng nhập thất bại,
              thay vì người dùng phải tự dò lại xem có gì thay đổi trên trang */}
          {error && (
            <div className="alert-box alert-danger" role="alert" style={{ marginBottom: "1.25rem" }}>
              ⚠️ {error}
            </div>
          )}

          <div className="login-field">
            <label className="login-label" htmlFor="email">
              {t("login.email")}
            </label>
            <input
              id="email"
              className="login-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              autoComplete="email"
              required
              autoFocus
            />
          </div>

          <div className="login-field" style={{ marginBottom: "1.5rem" }}>
            <label className="login-label" htmlFor="password">
              {t("login.password")}
            </label>
            <div className="login-password-wrap">
              <input
                id="password"
                className="login-input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                title={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                aria-pressed={showPassword}
              >
                <i className={`fa ${showPassword ? "fa-eye-slash" : "fa-eye"}`} aria-hidden="true" />
              </button>
            </div>
          </div>

          <button
            id="btn-login"
            type="submit"
            disabled={loading}
            className="btn-primary-custom login-submit"
          >
            {loading ? (
              <>
                <span
                  className="spinner-custom"
                  style={{ width: 18, height: 18, borderWidth: 2 }}
                  aria-hidden="true"
                />
                {t("login.submitting")}
              </>
            ) : (
              t("login.submit")
            )}
          </button>
        </form>

        <p className="login-hint">
          {t("login.footer")}
        </p>
      </div>
    </div>
  );
}
