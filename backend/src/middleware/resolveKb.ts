import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_KB_CODE } from '../db/schema';
import { getKb, isValidKb } from '../modules/kb/kb.registry';
import { runWithKb } from '../modules/kb/kb.context';

/** Header do frontend gửi kèm mọi request để báo đang xem KB nào. */
export const KB_HEADER = 'x-kb';

/**
 * Xác định KB của request và mở ngữ cảnh cho toàn bộ chuỗi xử lý phía sau.
 *
 * Thứ tự ưu tiên:
 *   1. Header `X-KB` — người dùng đang bấm xem KB nào thì gửi mã đó.
 *   2. `users.default_kb` nếu request đã qua `authenticate` trước đó.
 *   3. KB mặc định của hệ thống.
 *
 * Mã KB không hợp lệ thì trả 400 chứ KHÔNG lặng lẽ lùi về KB mặc định: client gửi sai mã là
 * lỗi lập trình, che đi sẽ thành "đọc nhầm KB" mà không ai phát hiện.
 *
 * Middleware này mắc TOÀN CỤC trong `index.ts`, tức chạy TRƯỚC `authenticate` (vốn gắn ở từng
 * router) — nên bình thường nó lấy KB từ header. Đó là chủ ý: việc "mở KB nào trước" là quyết
 * định của giao diện, frontend đọc `default_kb` từ `/api/auth/me` rồi tự gửi header tương ứng.
 * Nhánh `req.user?.defaultKb` chỉ còn là lưới an toàn cho client cũ chưa gửi header.
 */
export async function resolveKb(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const fromHeader = req.header(KB_HEADER)?.trim();
    const code = fromHeader || req.user?.defaultKb || DEFAULT_KB_CODE;

    if (fromHeader && !(await isValidKb(fromHeader))) {
      res.status(400).json({ error: `Knowledge Base "${fromHeader}" does not exist or is disabled` });
      return;
    }

    const kb = await getKb(code);
    // Bọc `next()` trong ngữ cảnh: mọi handler phía sau (kể cả async nhiều tầng) đều thấy KB này.
    runWithKb(kb, () => next());
  } catch (err) {
    next(err);
  }
}
