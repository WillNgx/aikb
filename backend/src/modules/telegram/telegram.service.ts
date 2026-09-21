import { desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { analyticsEvents, auditLogs, telegramUsers } from '../../db/schema';
import type { TelegramUser } from '../../db/schema';
import { getRateLimitConfig, AI_CHAT_WINDOW_MS } from '../../middleware/rateLimiter';
import { notifyTelegramUser } from './telegram.notifier';
import { isValidKb } from '../kb/kb.registry';

/** Giới hạn cứng của Telegram cho 1 tin nhắn là 4096 ký tự — chừa biên an toàn. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 3900;

/** Câu hỏi dài tối đa — giữ BẰNG với chuẩn của web (ai.router.ts) để 2 kênh hành xử giống nhau. */
export const MAX_QUESTION_LENGTH = 2000;

export type TelegramAccessResult =
  | { allowed: true; record: TelegramUser }
  | { allowed: false; reason: 'pending' | 'rejected'; record: TelegramUser };

export interface TelegramIdentity {
  telegramId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}

// ─── Phân quyền ───────────────────────────────────────────────────────────────

/** Ghép first_name + last_name; Telegram luôn có first_name nhưng vẫn phòng trường hợp trống. */
function buildDisplayName(identity: TelegramIdentity): string {
  const name = [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim();
  return name || identity.username || `Telegram ${identity.telegramId}`;
}

/**
 * Xác định người gửi có được phép hỏi bot hay không.
 *
 * Người lạ nhắn lần đầu -> TỰ tạo bản ghi 'pending' với đầy đủ id/username/tên lấy từ payload
 * Telegram, để Admin chỉ việc bấm Duyệt mà không ai phải đọc/gõ tay con số telegram_id.
 *
 * Bản ghi 'rejected' được GIỮ LẠI (không xoá): người đã bị từ chối nhắn lại sẽ khớp vào bản ghi
 * cũ thay vì sinh ra một yêu cầu chờ duyệt mới, nếu không danh sách của Admin sẽ bị spam.
 */
export async function resolveAccess(identity: TelegramIdentity): Promise<TelegramAccessResult> {
  const [existing] = await db
    .select()
    .from(telegramUsers)
    .where(eq(telegramUsers.telegramId, identity.telegramId))
    .limit(1);

  if (existing) {
    // Tên/username trên Telegram đổi được bất cứ lúc nào — đồng bộ lại để Admin nhìn đúng người.
    // Phải dùng bản ghi SAU khi cập nhật cho phần trả về, nếu không analytics sẽ ghi tên cũ.
    let current = existing;
    const displayName = buildDisplayName(identity);
    if (existing.displayName !== displayName || existing.username !== identity.username) {
      const [updated] = await db
        .update(telegramUsers)
        .set({ displayName, username: identity.username, updatedAt: new Date() })
        .where(eq(telegramUsers.id, existing.id))
        .returning();
      if (updated) current = updated;
    }

    if (current.status === 'approved') return { allowed: true, record: current };
    return { allowed: false, reason: current.status, record: current };
  }

  const [created] = await db
    .insert(telegramUsers)
    .values({
      telegramId: identity.telegramId,
      username: identity.username,
      displayName: buildDisplayName(identity),
      status: 'pending',
    })
    .returning();

  return { allowed: false, reason: 'pending', record: created as TelegramUser };
}

// ─── Rate limit theo từng tài khoản Telegram ─────────────────────────────────

/**
 * Bộ đếm trong bộ nhớ, cửa sổ trượt 1 phút, tính riêng cho TỪNG telegram_id.
 *
 * CỐ Ý không dùng `aiChatLimiter` của express: bot gọi thẳng hàm chat() trong cùng tiến trình chứ
 * không đi qua HTTP, nên không có req/res cho middleware. Quan trọng hơn: limiter đó đếm theo IP,
 * mà mọi tin nhắn Telegram đều vào từ cùng một nguồn — một người spam sẽ khoá cả bot.
 *
 * Ngưỡng thì DÙNG CHUNG con số Admin đã đặt cho web (app_settings.ai_chat_rate_limit), nên mỗi
 * tài khoản Telegram được đối xử đúng như một người dùng web bình thường.
 */
const requestLog = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function checkRateLimit(telegramId: string): Promise<RateLimitResult> {
  const { aiChatLimit } = await getRateLimitConfig();
  const now = Date.now();
  const windowStart = now - AI_CHAT_WINDOW_MS;

  const recent = (requestLog.get(telegramId) ?? []).filter((t) => t > windowStart);

  if (recent.length >= aiChatLimit) {
    const oldest = recent[0] as number;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + AI_CHAT_WINDOW_MS - now) / 1000));
    requestLog.set(telegramId, recent);
    return { allowed: false, retryAfterSeconds };
  }

  recent.push(now);
  requestLog.set(telegramId, recent);
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Dọn các telegram_id không còn request nào trong cửa sổ — nếu không Map sẽ phình mãi theo số
 * người từng nhắn bot. Chạy định kỳ, gọi từ telegram.bot.ts.
 */
export function pruneRateLimitLog(): void {
  const windowStart = Date.now() - AI_CHAT_WINDOW_MS;
  for (const [key, times] of requestLog.entries()) {
    const recent = times.filter((t) => t > windowStart);
    if (recent.length === 0) requestLog.delete(key);
    else requestLog.set(key, recent);
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * Ghi analytics cho câu hỏi đến từ Telegram.
 *
 * chat() trong ai.service.ts chỉ ghi analytics KHI có userId (xem `if (userId)` ở đó). Bot gọi
 * chat() không kèm userId — vì telegram_users là bảng độc lập, không map sang users.id — nên
 * nếu không có hàm này thì câu hỏi qua Telegram sẽ hoàn toàn vô hình trên trang Thống kê.
 *
 * user_id để NULL (không có FK để điền), dấu vết kênh nằm ở cột meta.
 */
export function logTelegramAnalytics(
  eventType: 'ai_question' | 'ai_no_answer',
  question: string,
  // `kbCode` truyền TƯỜNG MINH chứ không lấy từ ngữ cảnh: hàm này được gọi sau khi khối
  // runWithKb(...) đã đóng, nên `currentKb()` ở đây sẽ ném lỗi. Và nó bắt buộc phải có — chính
  // cột này là thứ Context Memory của bot dùng để lọc lịch sử theo KB.
  identity: { telegramId: string; displayName: string; kbCode: string }
): void {
  db.insert(analyticsEvents)
    .values({
      eventType,
      query: question,
      userId: null,
      kbCode: identity.kbCode,
      meta: {
        channel: 'telegram',
        telegramId: identity.telegramId,
        displayName: identity.displayName,
      },
    })
    .catch((err) => console.error('[Telegram] Không ghi được analytics:', err));
}

// ─── Định dạng câu trả lời cho Telegram ──────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Chuẩn bị câu trả lời để gửi qua Telegram, trả về danh sách tin nhắn (đã cắt theo giới hạn).
 *
 * [SECURITY] Escape HTML TRƯỚC rồi mới bọc thẻ <b> — nội dung lấy từ Knowledge Base là dữ liệu
 * không tin cậy, làm ngược lại sẽ cho phép nội dung bài viết chèn thẻ HTML vào tin nhắn bot.
 *
 * Chỉ chuyển **đậm** vì regex bắt theo CẶP nên thẻ <b> luôn cân bằng, và `.` không khớp xuống
 * dòng nên một cặp không bao giờ nằm vắt qua 2 tin nhắn — Telegram trả lỗi 400 nếu thẻ hở.
 */
export function formatAnswerForTelegram(answer: string): string[] {
  const messages: string[] = [];
  let current = '';

  for (const line of answer.split('\n')) {
    // Bỏ dấu ## của heading Markdown — Telegram không hiểu, để nguyên thì rác chữ
    const cleaned = line.replace(/^#{1,6}\s+/, '');
    const candidate = current ? `${current}\n${cleaned}` : cleaned;

    if (candidate.length > TELEGRAM_MAX_MESSAGE_LENGTH && current) {
      messages.push(current);
      current = cleaned;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) messages.push(current);

  return (messages.length > 0 ? messages : [answer]).map((msg) =>
    escapeHtml(msg).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  );
}

// ─── Quản trị: dành cho router Admin ─────────────────────────────────────────

export async function listTelegramUsers(status?: 'pending' | 'approved' | 'rejected') {
  const query = db.select().from(telegramUsers).$dynamic();
  const rows = status
    ? await query.where(eq(telegramUsers.status, status)).orderBy(desc(telegramUsers.requestedAt))
    : await query.orderBy(desc(telegramUsers.requestedAt));
  return rows;
}

/** Số yêu cầu đang chờ duyệt — FE dùng để hiện badge trên tab. */
export async function countPending(): Promise<number> {
  const rows = await db
    .select({ id: telegramUsers.id })
    .from(telegramUsers)
    .where(eq(telegramUsers.status, 'pending'));
  return rows.length;
}

export class TelegramUserNotFoundError extends Error {
  constructor() {
    super('Không tìm thấy tài khoản Telegram này');
    this.name = 'TelegramUserNotFoundError';
  }
}

export class TelegramUserStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramUserStateError';
  }
}

const AUDIT_ACTION = {
  approved: 'telegram_approve',
  rejected: 'telegram_reject',
  revoked: 'telegram_revoke',
} as const;

/**
 * Đổi trạng thái duyệt của một tài khoản Telegram.
 *
 * `revoke` khác `reject` ở chỗ nó áp lên người ĐANG được duyệt (thu hồi quyền đã cấp) — cùng dẫn
 * tới status 'rejected' nhưng ghi audit bằng action khác nhau, để sau này đọc log biết được đây
 * là "từ chối ngay từ đầu" hay "đã cho vào rồi mới đuổi ra".
 */
async function setStatus(
  id: string,
  next: 'approved' | 'rejected',
  auditAction: (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION],
  actor: { id: string; email: string }
): Promise<TelegramUser> {
  const [existing] = await db.select().from(telegramUsers).where(eq(telegramUsers.id, id)).limit(1);
  if (!existing) throw new TelegramUserNotFoundError();

  if (existing.status === next) {
    throw new TelegramUserStateError(
      next === 'approved' ? 'Tài khoản này đã được duyệt rồi' : 'Tài khoản này đã bị từ chối rồi'
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(telegramUsers)
    .set({ status: next, reviewedAt: now, reviewedBy: actor.id, updatedAt: now })
    .where(eq(telegramUsers.id, id))
    .returning();

  await db.insert(auditLogs).values({
    action: auditAction,
    actorId: actor.id,
    actorEmail: actor.email,
    targetId: id,
    targetType: 'telegram_user',
    meta: {
      telegramId: existing.telegramId,
      displayName: existing.displayName,
      from: existing.status,
      to: next,
    },
  });

  return updated as TelegramUser;
}

/** Nội dung báo cho người dùng biết họ vừa được cấp quyền. */
const APPROVED_MESSAGE =
  '🎉 Yêu cầu của bạn đã được duyệt!\n\n' +
  'Bạn có thể nhắn thẳng câu hỏi cho tôi, tôi sẽ tìm trong Knowledge Base nội bộ và trả lời.';

export async function approveTelegramUser(id: string, actor: { id: string; email: string }) {
  const updated = await setStatus(id, 'approved', AUDIT_ACTION.approved, actor);

  // Báo cho người dùng biết — CỐ Ý không `await`: việc duyệt phải thành công kể cả khi không gửi
  // được tin (người đó chặn bot, bot đang tắt...). notifyTelegramUser tự nuốt lỗi và ghi log,
  // Admin không nhận được lỗi từ đây.
  void notifyTelegramUser(updated.telegramId, APPROVED_MESSAGE);

  return updated;
}

export function rejectTelegramUser(id: string, actor: { id: string; email: string }) {
  return setStatus(id, 'rejected', AUDIT_ACTION.rejected, actor);
}

/** Thu hồi quyền của người ĐANG được duyệt. */
export async function revokeTelegramUser(id: string, actor: { id: string; email: string }) {
  const [existing] = await db.select().from(telegramUsers).where(eq(telegramUsers.id, id)).limit(1);
  if (!existing) throw new TelegramUserNotFoundError();
  if (existing.status !== 'approved') {
    throw new TelegramUserStateError('Chỉ thu hồi được quyền của tài khoản đang được duyệt');
  }
  return setStatus(id, 'rejected', AUDIT_ACTION.revoked, actor);
}

/**
 * Gán KB cho một tài khoản Telegram.
 *
 * Bot tra cột này để biết phải trả lời bằng dữ liệu của KB nào, nhờ vậy chỉ cần MỘT bot token
 * duy nhất phục vụ mọi ngôn ngữ thay vì tạo bot riêng cho từng KB.
 */
export async function setTelegramUserKb(
  id: string,
  kbCode: string,
  actor: { id: string; email: string }
) {
  const [existing] = await db.select().from(telegramUsers).where(eq(telegramUsers.id, id)).limit(1);
  if (!existing) throw new TelegramUserNotFoundError();
  if (!(await isValidKb(kbCode))) {
    throw new TelegramUserStateError(`Knowledge Base "${kbCode}" không tồn tại hoặc đã tắt`);
  }

  const [updated] = await db
    .update(telegramUsers)
    .set({ kbCode, updatedAt: new Date() })
    .where(eq(telegramUsers.id, id))
    .returning();

  await db.insert(auditLogs).values({
    action: 'telegram_approve', // dùng lại action sẵn có — chi tiết nằm ở `meta`
    actorId: actor.id,
    actorEmail: actor.email,
    targetId: id,
    targetType: 'telegram_user',
    kbCode,
    meta: { change: 'kb', displayName: existing.displayName, from: existing.kbCode, to: kbCode },
  });

  return updated;
}

/**
 * Xoá hẳn bản ghi.
 *
 * [LƯU Ý] Xoá một bản ghi 'rejected' đồng nghĩa với việc người đó nhắn bot lần sau sẽ tạo lại một
 * yêu cầu chờ duyệt mới. Đây là hành vi mong muốn (dùng để "làm lại từ đầu"), không phải bug.
 */
export async function deleteTelegramUser(id: string, actor: { id: string; email: string }) {
  const [existing] = await db.select().from(telegramUsers).where(eq(telegramUsers.id, id)).limit(1);
  if (!existing) throw new TelegramUserNotFoundError();

  await db.delete(telegramUsers).where(eq(telegramUsers.id, id));

  await db.insert(auditLogs).values({
    action: 'telegram_delete',
    actorId: actor.id,
    actorEmail: actor.email,
    targetId: id,
    targetType: 'telegram_user',
    meta: { telegramId: existing.telegramId, displayName: existing.displayName },
  });
}
