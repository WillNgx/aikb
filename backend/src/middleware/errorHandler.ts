import { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/AppError';

/**
 * Global error handler — phải đặt CUỐI cùng trong Express app.
 * Bắt mọi lỗi chưa được xử lý, trả response nhất quán.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  // Không lộ stack trace ra client trong production
  const isDev = process.env.NODE_ENV !== 'production';

  // Lỗi nghiệp vụ đã tự khai báo status (404/409/422...) — trả đúng status và message thật cho
  // client. Message của AppError là câu tiếng Anh viết cho người dùng đọc nên trả thẳng được,
  // khác với lỗi không lường trước bên dưới (có thể lộ chi tiết nội bộ nên phải che).
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.code && { code: err.code }),
    });
    return;
  }

  // aiName được service gắn vào lỗi khi provider AI hết quota (429/RESOURCE_EXHAUSTED) — cho phép
  // frontend nhận diện đúng loại lỗi này để log riêng, không lẫn với lỗi server khác.
  const aiName = (err as Error & { aiName?: string }).aiName;

  // code = 'ALL_PROVIDERS_EXHAUSTED' khi TOÀN BỘ provider AI đều không dùng được (xem
  // llm.service.ts) — frontend log cảnh báo riêng ra console để Admin biết phải xử lý quota.
  const code = (err as Error & { code?: string }).code;

  res.status(500).json({
    error: 'Internal server error',
    ...(aiName && { aiName }),
    ...(code && { code }),
    ...(isDev && { detail: err.message, stack: err.stack }),
  });
}
