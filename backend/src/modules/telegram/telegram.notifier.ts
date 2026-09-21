import type { Bot } from 'grammy';

/**
 * Cầu nối một chiều để tầng service gửi tin nhắn chủ động cho người dùng Telegram.
 *
 * LÝ DO TỒN TẠI FILE NÀY: `telegram.bot.ts` đã import `telegram.service.ts`. Nếu service import
 * ngược lại bot để gọi hàm gửi tin thì thành nhập vòng (circular import) — Node vẫn chạy được
 * nhưng một trong hai module sẽ thấy phía kia là `undefined` tuỳ thứ tự nạp, sinh lỗi rất khó
 * truy vết. File này KHÔNG import gì từ 2 file kia nên cắt đứt được vòng đó.
 *
 * Luồng: telegram.bot.ts khởi tạo bot -> setBotInstance() -> telegram.service.ts gọi
 * notifyTelegramUser() mà không cần biết bot được dựng ở đâu.
 */

let botInstance: Bot | null = null;

export function setBotInstance(bot: Bot): void {
  botInstance = bot;
}

/**
 * Gửi tin nhắn chủ động tới một người dùng Telegram.
 *
 * KHÔNG BAO GIỜ ném lỗi ra ngoài — hàm gọi nó (duyệt tài khoản) phải thành công kể cả khi không
 * gửi được tin. Các trường hợp thất bại hợp lệ, không phải bug:
 *   - Backend chạy mà chưa cấu hình TELEGRAM_BOT_TOKEN  -> chưa có bot
 *   - Người dùng đã chặn bot                             -> Telegram trả 403
 *   - Người dùng chưa từng bấm Start                     -> Telegram trả 400
 *
 * @returns true nếu Telegram xác nhận đã gửi, false nếu không (đã ghi log lý do).
 */
export async function notifyTelegramUser(telegramId: string, text: string): Promise<boolean> {
  if (!botInstance) {
    console.warn('[Telegram] Bỏ qua thông báo: bot chưa khởi động (thiếu TELEGRAM_BOT_TOKEN).');
    return false;
  }

  try {
    // chat_id của Bot API nhận cả Integer lẫn String; truyền thẳng chuỗi để giữ nguyên giá trị
    // đã lưu trong DB, không phải ép kiểu số.
    await botInstance.api.sendMessage(telegramId, text);
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram] Không gửi được thông báo tới ${telegramId}: ${reason}`);
    return false;
  }
}
