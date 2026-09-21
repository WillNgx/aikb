import { createClient } from '@supabase/supabase-js';

/**
 * Client Supabase DÙNG CHUNG cho toàn app.
 *
 * Trước đây client được tạo ngay trong LoginPage và chỉ `access_token` được lưu tay vào
 * localStorage — không có refresh token, nên khi token hết hạn (mặc định ~1 giờ) là người dùng
 * bị đá về /login giữa chừng, kể cả đang soạn bài. Ở đây bật `persistSession` +
 * `autoRefreshToken` để SDK tự giữ và làm mới phiên.
 *
 * QUAN TRỌNG: chỉ được tạo client ở đúng file này. Tạo nhiều instance sẽ khiến mỗi instance
 * giữ một bản session riêng, làm việc làm mới token chạy chồng lên nhau.
 */

/**
 * Cờ ĐỒNG BỘ "đang có phiên hay không", dùng cho những chỗ phải quyết định ngay lúc render đầu
 * tiên (ProtectedRoute trong App.tsx, useAuthUser) — `supabase.auth.getSession()` là hàm async
 * nên không dùng trực tiếp ở đó được.
 *
 * Đây CHỈ là gợi ý cho việc điều hướng. Token thật để gọi API luôn phải lấy từ
 * `getAccessToken()` bên dưới, vì cờ này có thể cũ hơn phiên thật sau khi SDK làm mới token.
 */
export const TOKEN_HINT_KEY = 'sb_access_token';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // App không dùng OAuth redirect/magic link — tắt để SDK không cố parse hash trên URL
      detectSessionInUrl: false,
    },
  }
);

// Giữ cờ hint khớp với phiên thật: SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT đều đi qua đây.
supabase.auth.onAuthStateChange((_event, session) => {
  if (session?.access_token) {
    localStorage.setItem(TOKEN_HINT_KEY, session.access_token);
  } else {
    localStorage.removeItem(TOKEN_HINT_KEY);
  }
});

/** Access token hiện hành. SDK tự làm mới nếu token sắp/đã hết hạn. */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Đăng xuất: xoá phiên trong SDK lẫn cờ hint. */
export async function signOut(): Promise<void> {
  await supabase.auth.signOut().catch(() => {
    // Mất mạng thì signOut trên server có thể lỗi — vẫn phải dọn phiên phía client
  });
  localStorage.removeItem(TOKEN_HINT_KEY);
}
