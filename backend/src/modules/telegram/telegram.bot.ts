import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { env } from '../../config/env';
import { chat, ClarificationOption } from '../ai/ai.service';
import { setBotInstance } from './telegram.notifier';
import { getDefaultKb, getKb } from '../kb/kb.registry';
import { runWithKb } from '../kb/kb.context';
import {
  MAX_QUESTION_LENGTH,
  checkRateLimit,
  formatAnswerForTelegram,
  logTelegramAnalytics,
  pruneRateLimitLog,
  resolveAccess,
  type TelegramIdentity,
} from './telegram.service';

/**
 * Bot Telegram — kênh hỏi đáp AI thứ 2 bên cạnh AI Chat trên web.
 *
 * Bot KHÔNG có pipeline riêng: nó gọi thẳng `chat()` của ai.service, nên mọi thứ (chuẩn hoá từ
 * lóng, ambiguity detection, ngưỡng relevance, adapter LLM + fallback, hàng rào chống prompt
 * injection) đều dùng chung với web. Đây là một KÊNH VÀO, không phải một pipeline mới.
 *
 * Khác biệt duy nhất so với web: bỏ citations/suggestions (yêu cầu nghiệp vụ — bot chỉ nhận câu
 * hỏi và trả câu trả lời).
 */

let bot: Bot | null = null;
let pruneTimer: NodeJS.Timeout | null = null;

// ─── Lưu tạm option làm rõ cho inline keyboard ───────────────────────────────

/**
 * callback_data của Telegram chỉ chứa tối đa 64 byte — không nhét nổi câu hỏi đầy đủ của
 * ClarificationOption. Nên lưu tạm option trong bộ nhớ và chỉ gửi đi một khoá ngắn.
 *
 * Mất dữ liệu này khi restart là chấp nhận được: người dùng chỉ cần hỏi lại. Có TTL để bộ nhớ
 * không phình theo số câu hỏi mơ hồ từng được đặt.
 */
const CLARIFICATION_TTL_MS = 10 * 60 * 1000; // 10 phút
interface ClarificationEntry {
  options: ClarificationOption[];
  expiresAt: number;
  /**
   * Bàn phím này đã được bấm chưa.
   *
   * BẮT BUỘC phải có: Telegram giữ nút inline trong lịch sử chat VĨNH VIỄN và cho bấm lại vô hạn
   * lần. Không có cờ này thì người dùng bấm lại một nút cũ (kể cả vài phút sau, khi đang hỏi
   * chuyện khác) là bot lại trả lời cho câu hỏi cũ — trông y như bot bị loạn. Đã tái hiện được
   * trong log thực tế: một bàn phím bị bấm 3 lần trong 3 phút.
   */
  used: boolean;
}
const clarificationStore = new Map<string, ClarificationEntry>();
let clarificationCounter = 0;

function saveClarification(options: ClarificationOption[]): string {
  const key = `c${Date.now().toString(36)}${(clarificationCounter++ % 1000).toString(36)}`;
  clarificationStore.set(key, { options, expiresAt: Date.now() + CLARIFICATION_TTL_MS, used: false });
  return key;
}

function pruneClarifications(): void {
  const now = Date.now();
  for (const [key, entry] of clarificationStore.entries()) {
    if (entry.expiresAt <= now) clarificationStore.delete(key);
  }
}

// ─── Tiện ích ─────────────────────────────────────────────────────────────────

function toIdentity(from: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): TelegramIdentity {
  return {
    // Ép sang chuỗi ngay tại biên: ID Telegram có thể vượt số nguyên an toàn của JavaScript
    telegramId: String(from.id),
    username: from.username ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
  };
}

/**
 * Gửi câu trả lời, cắt sẵn theo giới hạn 4096 ký tự của Telegram.
 *
 * Nếu Telegram từ chối vì parse HTML lỗi thì gửi lại dạng chữ thường — thà mất chữ đậm còn hơn
 * người dùng không nhận được câu trả lời nào.
 */
async function sendAnswer(
  ctx: { reply: (text: string, other?: Record<string, unknown>) => Promise<unknown> },
  answer: string,
  keyboard?: InlineKeyboard,
  replyToMessageId?: number
): Promise<void> {
  const parts = formatAnswerForTelegram(answer);

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const isFirst = i === 0;
    const options: Record<string, unknown> = { parse_mode: 'HTML' };
    // Bàn phím chỉ gắn vào tin nhắn cuối, nếu không sẽ hiện lặp lại ở mọi mảnh
    if (isLast && keyboard) options.reply_markup = keyboard;
    // Trích dẫn câu hỏi gốc để người dùng biết câu trả lời này thuộc về câu nào — bot xử lý
    // tuần tự nên khi hỏi dồn, các câu trả lời đến muộn và dồn cục, không có trích dẫn thì
    // không thể đối chiếu được. Chỉ gắn vào mảnh ĐẦU, các mảnh sau là phần tiếp theo của
    // cùng một câu trả lời nên trích dẫn lặp lại chỉ gây rối.
    // reply_to_message_id đã bị Bot API đánh dấu deprecated — dùng reply_parameters.
    if (isFirst && replyToMessageId) {
      options.reply_parameters = { message_id: replyToMessageId };
    }

    try {
      await ctx.reply(parts[i] as string, options);
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 400) {
        // 400 ở đây thường là parse HTML hỏng, nhưng cũng có thể do tin nhắn được trích dẫn đã
        // bị xoá. Bỏ cả parse_mode lẫn trích dẫn để câu trả lời vẫn tới được người dùng.
        const fallback: Record<string, unknown> = {};
        if (isLast && keyboard) fallback.reply_markup = keyboard;
        await ctx.reply(parts[i] as string, fallback);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Lấy KB của một tài khoản Telegram, có đường lùi về KB mặc định.
 *
 * Đây là ngoại lệ CÓ CHỦ Ý của nguyên tắc "không có KB thì ném lỗi": mã KB ở đây nằm trong DB do
 * Admin chọn, nếu KB đó bị xoá/tắt thì người dùng Telegram sẽ mất hẳn khả năng hỏi mà không hiểu
 * vì sao. Lùi về KB mặc định kèm cảnh báo trong log là cách hỏng nhẹ nhàng hơn — khác hẳn trường
 * hợp code quên mở ngữ cảnh, vốn phải sập ngay để lộ ra lúc chạy thử.
 */
async function getKbSafe(kbCode: string) {
  try {
    return await getKb(kbCode);
  } catch {
    console.warn(`[Telegram] KB "${kbCode}" không dùng được, tạm lùi về KB mặc định.`);
    return getDefaultKb();
  }
}

/** Dựng bàn phím cho Ambiguity Detection — mỗi lựa chọn Provider là một nút. */
function buildClarificationKeyboard(options: ClarificationOption[]): InlineKeyboard {
  const key = saveClarification(options);
  const keyboard = new InlineKeyboard();
  options.forEach((option, index) => {
    keyboard.text(option.label, `clr:${key}:${index}`).row();
  });
  return keyboard;
}

// ─── Xử lý một câu hỏi (dùng chung cho tin nhắn text và nút bấm) ─────────────

async function handleQuestion(
  ctx: {
    reply: (text: string, other?: Record<string, unknown>) => Promise<unknown>;
    replyWithChatAction?: (action: 'typing') => Promise<unknown>;
  },
  identity: TelegramIdentity,
  displayName: string,
  question: string,
  /** KB do Admin gán cho chính tài khoản Telegram này (telegram_users.kb_code). */
  kbCode: string,
  replyToMessageId?: number
): Promise<void> {
  const rate = await checkRateLimit(identity.telegramId);
  if (!rate.allowed) {
    await ctx.reply(
      `Bạn đang hỏi quá nhanh. Vui lòng thử lại sau ${rate.retryAfterSeconds} giây.`
    );
    return;
  }

  // Báo "đang soạn" để người dùng biết bot chưa treo — pipeline RAG mất vài giây
  await ctx.replyWithChatAction?.('typing').catch(() => undefined);

  // Bot chạy NGOÀI luồng HTTP nên không có middleware nào mở sẵn ngữ cảnh KB — phải tự mở,
  // nếu không `currentKb()` sẽ ném lỗi (cố ý: thà sập rõ ràng còn hơn âm thầm chạy nhầm KB).
  //
  // KB lấy theo TỪNG TÀI KHOẢN Telegram (Admin gán ở trang quản trị), nhờ vậy chỉ cần MỘT bot
  // token duy nhất phục vụ mọi ngôn ngữ — không phải tạo bot riêng cho từng KB.
  const kb = await getKbSafe(kbCode);
  const response = await runWithKb(kb, () => chat(question, undefined, identity.telegramId));

  // Ghi analytics SAU KHI gọi chat() xong — chat() tự đọc lịch sử gần đây của telegramId này để
  // ghép ngữ cảnh (Context Memory, xem ai.service.ts + contextHistory.service.ts). Ghi TRƯỚC sẽ
  // khiến chính câu hỏi đang hỏi lẫn vào "lịch sử" của chính nó.
  logTelegramAnalytics('ai_question', question, {
    telegramId: identity.telegramId,
    displayName,
    kbCode: kb.code,
  });

  // Câu hỏi mơ hồ (chưa rõ Provider) -> hiện nút cho người dùng chọn thay vì đoán bừa
  if (response.needsClarification && response.clarificationOptions?.length) {
    await sendAnswer(
      ctx,
      response.answer,
      buildClarificationKeyboard(response.clarificationOptions),
      replyToMessageId
    );
    return;
  }

  if (!response.hasAnswer) {
    logTelegramAnalytics('ai_no_answer', question, {
      telegramId: identity.telegramId,
      displayName,
      kbCode: kb.code,
    });
  }

  // CỐ Ý chỉ gửi `answer`: bỏ citations và suggestions theo yêu cầu nghiệp vụ.
  // `note` vẫn gửi kèm vì đó là CẢNH BÁO độ tin cậy (câu hỏi có Provider nhưng context không
  // khớp Provider đó), bỏ đi sẽ khiến người dùng tin nhầm một câu trả lời chỉ mang tính tham khảo.
  const text = response.note ? `${response.answer}\n\n⚠️ ${response.note}` : response.answer;
  await sendAnswer(ctx, text, undefined, replyToMessageId);
}

// ─── Khởi tạo bot ─────────────────────────────────────────────────────────────

export function startTelegramBot(): void {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log('ℹ️  Telegram bot: chưa cấu hình TELEGRAM_BOT_TOKEN — bỏ qua, backend vẫn chạy bình thường.');
    return;
  }

  bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  // Cho tầng service gửi được tin nhắn chủ động (VD: báo tài khoản vừa được duyệt) mà không
  // phải import ngược file này — xem giải thích trong telegram.notifier.ts.
  setBotInstance(bot);

  // ── /start ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    const identity = toIdentity(ctx.from);
    const access = await resolveAccess(identity);

    if (access.allowed) {
      await ctx.reply(
        'Xin chào! Bạn đã được cấp quyền tra cứu.\n\n' +
          'Hãy nhắn thẳng câu hỏi của bạn, tôi sẽ tìm trong Knowledge Base nội bộ và trả lời.'
      );
      return;
    }

    if (access.reason === 'rejected') {
      // Im lặng có chủ đích — xem giải thích ở handler tin nhắn text bên dưới
      return;
    }

    await ctx.reply(
      'Yêu cầu truy cập của bạn đã được gửi tới quản trị viên.\n\n' +
        `${env.TELEGRAM_ADMIN_CONTACT}\n\n` +
        'Sau khi được duyệt, bạn có thể nhắn câu hỏi trực tiếp cho tôi.'
    );
  });

  // ── Tin nhắn text ─────────────────────────────────────────────────────────
  bot.on('message:text', async (ctx) => {
    if (!ctx.from) return;

    const question = ctx.message.text.trim();
    if (!question || question.startsWith('/')) return; // lệnh khác đã có handler riêng

    const identity = toIdentity(ctx.from);
    const access = await resolveAccess(identity);

    if (!access.allowed) {
      // Người bị TỪ CHỐI: không trả lời gì cả. Trả lời "bạn bị từ chối" là xác nhận cho người
      // ngoài rằng bot có tồn tại và đang phục vụ ai đó — im lặng thì họ không biết gì thêm.
      if (access.reason === 'rejected') return;

      await ctx.reply(
        'Bạn chưa được cấp quyền sử dụng bot này.\n\n' +
          `Yêu cầu của bạn đang chờ quản trị viên duyệt. ${env.TELEGRAM_ADMIN_CONTACT}`
      );
      return;
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      await ctx.reply(`Câu hỏi quá dài (tối đa ${MAX_QUESTION_LENGTH} ký tự). Vui lòng rút gọn lại.`);
      return;
    }

    await handleQuestion(
      ctx,
      identity,
      access.record.displayName,
      question,
      access.record.kbCode,
      ctx.message.message_id
    );
  });

  // ── Nút bấm của Ambiguity Detection ───────────────────────────────────────
  bot.on('callback_query:data', async (ctx) => {
    const parts = ctx.callbackQuery.data.split(':');
    const entry = parts[0] === 'clr' && parts.length === 3 ? clarificationStore.get(parts[1] as string) : undefined;
    const option = entry?.options[Number(parts[2])];

    // Nút cũ: đã bấm rồi, hết hạn, hoặc bộ nhớ tạm đã mất sau khi restart server.
    // Báo bằng popup nhỏ chứ KHÔNG gửi tin nhắn mới — tránh làm rác khung chat.
    if (!ctx.from || !entry || entry.used || entry.expiresAt <= Date.now() || !option) {
      await ctx
        .answerCallbackQuery({
          text: 'Lựa chọn này không còn hiệu lực. Bạn hãy gửi lại câu hỏi nhé.',
          show_alert: true,
        })
        .catch(() => undefined);
      // Gỡ nốt bàn phím còn sót để không ai bấm được nữa
      await ctx.editMessageReplyMarkup().catch(() => undefined);
      return;
    }

    // Đánh dấu đã dùng NGAY, TRƯỚC mọi lệnh await. Bot xử lý update tuần tự nên cú bấm thứ hai
    // sẽ thấy cờ này và bị chặn — đây là chỗ vá lỗi bấm đúp sinh ra 2 câu trả lời giống hệt.
    entry.used = true;

    // Luôn phải trả lời callback, nếu không Telegram hiện vòng xoay mãi trên nút
    await ctx.answerCallbackQuery().catch(() => undefined);

    // Gỡ bàn phím và ghi lại lựa chọn vào chính tin nhắn đó: người dùng cuộn lại vẫn biết mình
    // đã chọn gì, thay vì thấy một tin nhắn cụt không còn nút nào.
    const originalText = ctx.callbackQuery.message?.text ?? '';
    await ctx
      .editMessageText(`${originalText}\n\n➡️ Bạn đã chọn: ${option.label}`)
      .catch(() => ctx.editMessageReplyMarkup().catch(() => undefined));

    const identity = toIdentity(ctx.from);
    // Kiểm tra quyền LẠI ở đây: quyền có thể đã bị thu hồi kể từ lúc bàn phím được gửi đi
    const access = await resolveAccess(identity);
    if (!access.allowed) return;

    await handleQuestion(
      ctx,
      identity,
      access.record.displayName,
      option.query,
      access.record.kbCode,
      ctx.callbackQuery.message?.message_id
    );
  });

  // ── Bắt lỗi tổng ──────────────────────────────────────────────────────────
  // Bot lỗi TUYỆT ĐỐI không được làm sập tiến trình Express đang phục vụ web.
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error('[Telegram] Telegram API từ chối:', e.description);
    } else if (e instanceof HttpError) {
      console.error('[Telegram] Không kết nối được tới Telegram:', e.message);
    } else {
      console.error('[Telegram] Lỗi không xác định:', e);
    }

    // Cố báo cho người dùng biết, nhưng nuốt lỗi nếu chính việc báo cũng thất bại
    err.ctx
      ?.reply('Đã có lỗi xảy ra khi xử lý câu hỏi của bạn. Vui lòng thử lại sau ít phút.')
      .catch(() => undefined);
  });

  // Dọn định kỳ 2 bộ nhớ tạm (rate limit + option làm rõ) để không rò rỉ bộ nhớ
  pruneTimer = setInterval(() => {
    pruneRateLimitLog();
    pruneClarifications();
  }, 5 * 60 * 1000);
  pruneTimer.unref();

  // drop_pending_updates: BỎ QUA tin nhắn tồn đọng lúc bot offline. Telegram giữ update chưa xử
  // lý tới ~24h — không bỏ thì mỗi lần bật server lại, bot trả lời dồn cả câu hỏi từ hôm trước
  // (vừa khó hiểu cho người dùng, vừa gọi Gemini hàng loạt cùng lúc làm cháy quota).
  bot
    .start({
      drop_pending_updates: true,
      onStart: (info) => console.log(`🤖 Telegram bot đang chạy: @${info.username}`),
    })
    .catch((err) => console.error('[Telegram] Không khởi động được bot:', err));
}

/** Dừng bot — dùng khi tắt server có kiểm soát. */
export async function stopTelegramBot(): Promise<void> {
  if (pruneTimer) clearInterval(pruneTimer);
  await bot?.stop();
}
