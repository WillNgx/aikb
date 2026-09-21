import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import { startPublishAll, getPublishAllProgress } from './nodes.service';

const router = Router();

/**
 * POST /api/admin/publish-all
 * Đăng toàn bộ Article đang ở trạng thái Draft (đã từng Lưu) — chạy tuần tự ở nền (xem
 * startPublishAll trong nodes.service.ts) vì mỗi lượt Đăng cũng gọi Gemini để tạo embedding,
 * cần tránh dồn request vượt quota giống lý do "Re-index toàn bộ" đã tuần tự hoá trước đó.
 */
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { started, total } = await startPublishAll(req.user!);

    if (!started) {
      return res.status(409).json({
        message: total === 0 ? 'Không có bài Draft nào để Đăng' : 'Đang có 1 lượt Đăng toàn bộ khác chạy dở',
        total,
      });
    }

    res.json({ message: `Đăng toàn bộ đã khởi động cho ${total} bài viết`, count: total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/publish-all/status
 * Tiến trình lượt "Đăng toàn bộ" gần nhất + số lượng Draft/Article hiện tại (đếm sống).
 */
router.get('/status', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const progress = await getPublishAllProgress();
    res.json(progress);
  } catch (err) {
    next(err);
  }
});

export default router;
