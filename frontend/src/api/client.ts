import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import { getAccessToken, signOut, supabase } from '../lib/supabase';
import { getActiveKb } from '../lib/kb';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

/** Cờ đánh dấu request đã được thử lại sau khi làm mới token — chặn vòng lặp refresh vô hạn. */
type RetriableConfig = InternalAxiosRequestConfig & { _retriedAfterRefresh?: boolean };

// Lấy token từ SDK Supabase (không đọc thẳng localStorage nữa): SDK tự làm mới token nếu nó sắp
// hoặc đã hết hạn, nên request luôn đi kèm token còn hiệu lực.
api.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // KB đang xem — backend khoá mọi truy vấn nội dung vào đúng KB này. Gửi ở MỌI request để
  // không có chỗ nào lặng lẽ rơi về KB mặc định.
  config.headers['X-KB'] = getActiveKb();
  return config;
});

// Xử lý 401 → thử làm mới phiên trước khi đăng xuất, và log ra console khi backend báo AI hết
// quota (field `aiName` được backend đính kèm khi provider AI trả 429/RESOURCE_EXHAUSTED —
// xem errorHandler.ts)
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const aiName = error.response?.data?.aiName;
    if (aiName) {
      console.log(`${aiName} - Đã hết quota`);
    }

    // Backend đã thử hết provider chính lẫn các provider dự phòng mà không cái nào trả lời được
    // → cảnh báo rõ cho Admin thấy trong console trình duyệt (xem llm.service.ts).
    if (error.response?.data?.code === 'ALL_PROVIDERS_EXHAUSTED') {
      console.error(
        '[AI Chat] TOÀN BỘ provider AI đã hết quota hoặc lỗi cấu hình — không còn provider nào để chuyển sang. ' +
          'Vui lòng kiểm tra tại Thống kê > Cấu hình AI Chat.'
      );
    }

    const originalConfig = error.config as RetriableConfig | undefined;

    if (error.response?.status === 401 && originalConfig && !originalConfig._retriedAfterRefresh) {
      // Thử làm mới phiên ĐÚNG MỘT LẦN rồi gọi lại request. Trước đây gặp 401 là đăng xuất
      // ngay, nên token hết hạn giữa chừng đồng nghĩa mất phiên làm việc.
      originalConfig._retriedAfterRefresh = true;

      const { data, error: refreshError } = await supabase.auth.refreshSession();
      if (!refreshError && data.session?.access_token) {
        originalConfig.headers.Authorization = `Bearer ${data.session.access_token}`;
        return api(originalConfig);
      }

      // Không làm mới được (refresh token cũng hết hạn / bị thu hồi) → đăng xuất thật
      await signOut();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
      return Promise.reject(error);
    }

    // 401 lần thứ hai (đã refresh mà vẫn bị từ chối — vd tài khoản bị vô hiệu hoá) → đăng xuất
    if (error.response?.status === 401) {
      await signOut();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

export default api;
