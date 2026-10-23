-- Gỡ tính năng "cổng AI tự thêm" (custom) theo yêu cầu: lỗ hổng lưu API key plaintext trong DB.
--
-- DỮ LIỆU MẤT: bảng `custom_ai_gateways` (kiểm tra ngày 23/10/2026: 0 dòng) bị xoá hẳn.
-- Provider `custom` đọc từ .env cũng đã gỡ khỏi code, nên mọi giá trị `chat_provider` bắt đầu bằng
-- `custom` trong app_settings không còn hợp lệ -> xoá để AI Chat quay về provider mặc định (Gemini),
-- khỏi phụ thuộc vào việc code bỏ qua giá trị lạ. (Hiện chat_provider = 'claude' nên câu này không
-- đụng dòng nào.)
--
-- Bảng thống kê token `ai_token_usage` GIỮ NGUYÊN: các dòng provider `custom...` là lịch sử đã dùng.
--
-- Đảo ngược: tạo lại bảng như migration 0015 (cột id, name, base_url, api_key, default_model,
-- suggested_models, is_active, created_at, updated_at + index is_active). Dữ liệu đã xoá không khôi
-- phục được.

-- chat_model đi cùng chat_provider nên xoá trước (còn điều kiện provider để tra cứu).
DELETE FROM "app_settings" WHERE "key" = 'chat_model'
  AND EXISTS (SELECT 1 FROM "app_settings" p WHERE p."key" = 'chat_provider' AND p."value" LIKE 'custom%');--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'chat_provider' AND "value" LIKE 'custom%';--> statement-breakpoint
DROP TABLE "custom_ai_gateways" CASCADE;
