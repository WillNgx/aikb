import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { aiChatLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { AppError } from '../../lib/AppError';
import { chat } from './ai.service';

const router = Router();

const chatSchema = z.object({
  question: z.string().min(1, 'Câu hỏi bắt buộc').max(2000, 'Câu hỏi tối đa 2000 ký tự'),
  // Lịch sử hội thoại do client gửi (web lưu trong sessionStorage theo TỪNG TAB — xem
  // sanitizeClientHistory trong contextHistory.service). Cắt cứng 8 phần tử ở đây chỉ để chặn
  // payload rác; service vẫn lọc lại theo cửa sổ 15 phút rồi mới giữ 4 câu gần nhất.
  history: z
    .array(z.object({ q: z.string().max(2000), at: z.number() }))
    .max(8)
    .optional(),
});

/**
 * POST /api/ai/chat
 * RAG pipeline: retrieve → grounding → Gemini Flash → answer + citations
 * Rate limited: 10 req/min/IP
 */
router.post('/chat', authenticate, aiChatLimiter, validateBody(chatSchema), async (req, res, next) => {
  try {
    const { question, history } = req.body as { question: string; history?: unknown };
    const response = await chat(question, req.user?.id, undefined, undefined, history);
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/ai/chat/stream
 * Cùng pipeline với `/chat`, chỉ khác cách trả kết quả: Server-Sent Events, để người dùng thấy
 * hệ thống đang ở bước nào thay vì chờ 20-30 giây trước một ô "Đang xử lý..." đứng im.
 *
 * Ba loại event:
 *   - `progress`: mỗi bước của pipeline (xem ChatProgress trong ai.service)
 *   - `done`: payload y hệt response JSON của `/chat` — frontend xử lý giống hệt
 *   - `error`: lỗi xảy ra giữa chừng
 *
 * CỐ Ý chỉ stream TIẾN TRÌNH, không stream từng chữ của câu trả lời. Nhờ vậy `callChatModel()`
 * giữ nguyên, kéo theo lớp adapter LLM, cơ chế fallback provider và việc ghi `ai_token_usage`
 * đều không phải đụng tới — đó mới là những chỗ dễ vỡ nếu stream nội dung.
 *
 * Route `/chat` cũ ĐƯỢC GIỮ NGUYÊN, không thay thế: Telegram bot và các client không đọc được
 * stream vẫn dùng nó.
 */
router.post(
  '/chat/stream',
  authenticate,
  aiChatLimiter,
  validateBody(chatSchema),
  async (req, res) => {
    const { question, history } = req.body as { question: string; history?: unknown };

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Người dùng đóng tab/huỷ request giữa chừng: pipeline vẫn chạy nốt (không huỷ được lượt gọi
    // model đang bay), nhưng không được ghi tiếp vào response đã đóng.
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    const send = (event: string, data: unknown): void => {
      if (clientGone || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const response = await chat(
        question,
        req.user?.id,
        undefined,
        (progress) => send('progress', progress),
        history,
      );
      send('done', response);
    } catch (err) {
      // KHÔNG dùng next(err) được ở đây: header đã gửi đi từ trước nên errorHandler không còn
      // đổi được status hay trả JSON — nó sẽ ném tiếp lỗi "headers already sent". Vì vậy phải
      // tự map lỗi sang event `error` theo đúng hình dạng payload mà errorHandler vẫn trả.
      console.error(`[ERROR] POST ${req.path}:`, err instanceof Error ? err.message : err);

      const e = err as Error & { aiName?: string; code?: string };
      send('error', {
        error: err instanceof AppError ? err.message : 'Lỗi máy chủ nội bộ',
        ...(e.aiName && { aiName: e.aiName }),
        ...(e.code && { code: e.code }),
      });
    } finally {
      if (!res.writableEnded) res.end();
    }
  },
);

export default router;
