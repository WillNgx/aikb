import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: '../.env' });

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL phải là URL hợp lệ'),
  SUPABASE_URL: z.string().url('SUPABASE_URL phải là URL hợp lệ'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY bắt buộc'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY bắt buộc'),
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY bắt buộc'),
  // Key Gemini dự phòng — chỉ được dùng khi key chính trả 429/hết quota (xem gemini.provider.ts).
  // Optional: không có key này thì hệ thống vẫn chạy bình thường với 1 key.
  GEMINI_API_KEY_2: z.string().optional(),
  // Đã verify trực tiếp qua Gemini API (22/08/2026): 'gemini-3.6-flash' là model Flash ổn định
  // hiện hành (gemini-2.0-flash/gemini-2.5-flash đã bị Google retire, trả lỗi 404 khuyên dùng
  // đúng model này). Nếu Google tiếp tục nâng cấp, alias tự cập nhật 'gemini-flash-latest' cũng
  // hoạt động — nhưng Google khuyến cáo ghim version cụ thể cho production thay vì dùng "-latest".
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  // Bản Gemini NHẸ dùng khi model chính báo quá tải (503) kéo dài — xem gemini.provider.ts. Ghim
  // phiên bản cụ thể thay vì alias "-latest"; đã thử 21/09/2026: trả lời ~1s, không tốn token suy nghĩ.
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.5-flash-lite'),
  // Cổng trung chuyển (relay) tự chọn — hiện trỏ tới gateway.agents.ai.vn, một bản new-api gộp
  // nhiều nhà cung cấp sau một endpoint chuẩn OpenAI. Đặt tên CUSTOM_ thay vì tên cổng cụ thể để
  // đổi nhà cung cấp sau này chỉ phải sửa baseUrl, không phải đổi tên biến env.
  // LƯU Ý VỀ DỮ LIỆU: câu hỏi đi qua provider này thì toàn bộ context KB nằm trong prompt sẽ đi
  // qua máy chủ bên thứ ba, khác với gọi thẳng Google.
  CUSTOM_API_KEY: z.string().optional(),
  // Địa chỉ cổng và model mặc định để ở env cho Admin tự đổi khi chuyển nhà cung cấp, không phải
  // sửa code. Có .default() nên xoá khỏi .env cũng không làm backend chết — chỉ quay về giá trị
  // dưới đây. Thiếu CUSTOM_API_KEY thì provider tự bị bỏ qua, hai biến này thành vô nghĩa.
  CUSTOM_BASE_URL: z.string().url('CUSTOM_BASE_URL phải là URL hợp lệ').default('https://gateway.agents.ai.vn/v1'),
  // Giống quan hệ GEMINI_MODEL <-> app_settings.chat_model: đây chỉ là model MẶC ĐỊNH của
  // provider (dùng khi Admin chưa chọn, hoặc khi provider này chạy với vai trò dự phòng).
  // Model đang chạy thật do Admin chọn trong UI và lưu ở app_settings.chat_model.
  CUSTOM_MODEL: z.string().default('deepseek.v3.2'),
  // Telegram Bot — kênh hỏi đáp AI thứ 2 bên cạnh web (xem modules/telegram).
  // Optional: KHÔNG có token thì backend vẫn khởi động bình thường, chỉ là bot không chạy —
  // giữ như vậy để máy dev nào không cần bot vẫn chạy được toàn bộ phần còn lại.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  // Câu hướng dẫn hiện cho người đang chờ Admin duyệt, VD: "Liên hệ anh A (@a_telegram)".
  TELEGRAM_ADMIN_CONTACT: z.string().default('Vui lòng liên hệ quản trị viên để được cấp quyền.'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  // Địa chỉ công khai của service, do Render TỰ cấp khi chạy trên Render (không cần khai trong
  // .env). Có biến này thì job self-ping bật (xem jobs/selfPing.ts); máy dev không có nên tự bỏ qua.
  RENDER_EXTERNAL_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Lỗi cấu hình môi trường:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;
