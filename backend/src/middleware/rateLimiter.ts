import rateLimit from "express-rate-limit";
import { eq, inArray } from "drizzle-orm";
import { env } from "../config/env";
import { db } from "../db";
import { appSettings } from "../db/schema";

/**
 * Giới hạn số request được Admin chỉnh trong UI (Cấu hình AI > Giới hạn truy cập) thay vì hardcode,
 * lưu ở `app_settings` — cùng cơ chế với relevance_threshold/chat_provider.
 *
 * CỐ Ý chỉ cho chỉnh SỐ REQUEST, không cho chỉnh `windowMs`: express-rate-limit tính cửa sổ thời
 * gian ngay lúc khởi tạo limiter, đổi windowMs giữa chừng sẽ làm bộ đếm đang chạy trở nên vô
 * nghĩa (request cũ được tính theo cửa sổ cũ). Số request thì đọc lại được ở từng request qua
 * option `limit` dạng hàm, nên đổi có hiệu lực ngay mà không cần restart server.
 */

export const AI_CHAT_RATE_LIMIT_KEY = "ai_chat_rate_limit";
export const GENERAL_RATE_LIMIT_KEY = "general_rate_limit";

/** Cửa sổ thời gian cố định — hiển thị cho Admin biết giới hạn tính trên khoảng nào. */
export const AI_CHAT_WINDOW_MS = 60 * 1000; // 1 phút
export const GENERAL_WINDOW_MS = 15 * 60 * 1000; // 15 phút

export const DEFAULT_AI_CHAT_LIMIT = 20;
export const DEFAULT_GENERAL_LIMIT = 300;

/** Chặn Admin tự khoá chính mình bằng một con số quá nhỏ, hoặc vô hiệu hoá limiter bằng số quá lớn. */
export const AI_CHAT_LIMIT_RANGE = { min: 1, max: 200 } as const;
export const GENERAL_LIMIT_RANGE = { min: 10, max: 2000 } as const;

interface RateLimitConfig {
  aiChatLimit: number;
  generalLimit: number;
}

/**
 * Cache 60s để không phải query app_settings ở MỌI request (generalLimiter chạy trước mọi route).
 * Admin lưu cấu hình xong thì admin.router gọi invalidateRateLimitCache() để có hiệu lực ngay.
 */
let cachedConfig: { value: RateLimitConfig; expiresAt: number } | null = null;
const CONFIG_CACHE_MS = 60_000;

export function invalidateRateLimitCache(): void {
  cachedConfig = null;
}

function parseLimit(raw: string | undefined, fallback: number, range: { min: number; max: number }): number {
  const parsed = parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) return fallback;
  // Kẹp lại trong khoảng cho phép phòng trường hợp giá trị cũ/hỏng còn sót trong DB
  return Math.min(range.max, Math.max(range.min, parsed));
}

export async function getRateLimitConfig(): Promise<RateLimitConfig> {
  if (cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;

  let value: RateLimitConfig = {
    aiChatLimit: DEFAULT_AI_CHAT_LIMIT,
    generalLimit: DEFAULT_GENERAL_LIMIT,
  };

  try {
    const rows = await db
      .select()
      .from(appSettings)
      .where(inArray(appSettings.key, [AI_CHAT_RATE_LIMIT_KEY, GENERAL_RATE_LIMIT_KEY]));
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    value = {
      aiChatLimit: parseLimit(stored[AI_CHAT_RATE_LIMIT_KEY], DEFAULT_AI_CHAT_LIMIT, AI_CHAT_LIMIT_RANGE),
      generalLimit: parseLimit(stored[GENERAL_RATE_LIMIT_KEY], DEFAULT_GENERAL_LIMIT, GENERAL_LIMIT_RANGE),
    };
  } catch (err) {
    // DB lỗi thì vẫn phải chặn được spam — dùng mặc định thay vì bỏ giới hạn hoàn toàn
    console.error("[RateLimit] Không đọc được cấu hình, dùng mặc định:", err);
  }

  cachedConfig = { value, expiresAt: Date.now() + CONFIG_CACHE_MS };
  return value;
}

export async function saveRateLimitConfig(aiChatLimit: number, generalLimit: number): Promise<void> {
  const now = new Date();
  const rows = [
    { key: AI_CHAT_RATE_LIMIT_KEY, value: aiChatLimit.toString() },
    { key: GENERAL_RATE_LIMIT_KEY, value: generalLimit.toString() },
  ];

  for (const row of rows) {
    await db
      .insert(appSettings)
      .values({ ...row, updatedAt: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: row.value, updatedAt: now },
      });
  }

  invalidateRateLimitCache();
}

/** Xoá cấu hình khỏi app_settings — đưa cả 2 limiter về giá trị mặc định. */
export async function resetRateLimitConfig(): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, AI_CHAT_RATE_LIMIT_KEY));
  await db.delete(appSettings).where(eq(appSettings.key, GENERAL_RATE_LIMIT_KEY));
  invalidateRateLimitCache();
}

/**
 * Rate limiter cho AI Chat endpoint (quota Gemini free tier giới hạn RPM thấp).
 * Mặc định 20 request / phút / IP — Admin chỉnh được, LUÔN bật ở mọi môi trường.
 */
export const aiChatLimiter = rateLimit({
  windowMs: AI_CHAT_WINDOW_MS,
  limit: async () => (await getRateLimitConfig()).aiChatLimit,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Quá nhiều câu hỏi trong thời gian ngắn. Vui lòng thử lại sau 1 phút.",
  },
});

/**
 * Rate limiter chung cho API (bảo vệ khỏi spam chung).
 * Mặc định 300 request / 15 phút / IP — Admin chỉnh được.
 */
export const generalLimiter = rateLimit({
  windowMs: GENERAL_WINDOW_MS,
  limit: async () => (await getRateLimitConfig()).generalLimit,
  standardHeaders: true,
  legacyHeaders: false,
  // Tạm thời bỏ giới hạn ở môi trường development để không bị chặn khi đăng bài liên tục lúc dev/test.
  // Production vẫn giữ giới hạn như cấu hình Admin đặt.
  skip: () => env.NODE_ENV === "development",
  message: {
    error: "Quá nhiều yêu cầu. Vui lòng thử lại sau.",
  },
});
