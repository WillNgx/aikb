import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import { startReindexAll, retryFailedReindex, getReindexProgress } from './indexing.service';

const router = Router();

/**
 * POST /api/admin/reindex
 * Re-index toàn bộ Article đã Published — dùng khi cần backfill lại chunk số lượng lớn (vd sau
 * khi gắn Provider mới cho 1 Folder, hoặc đổi cách chunk/gắn heading index). Chạy tuần tự từng
 * bài ở nền (xem startReindexAll) để tránh vượt quota Gemini — FE poll GET /reindex/status để
 * hiện thanh tiến trình.
 */
router.post('/', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { started, total } = await startReindexAll();

    if (!started) {
      return res.status(409).json({
        message: 'Another re-index run is in progress, please wait until it finishes',
        total,
      });
    }

    res.json({
      message: `Re-index started for ${total} articles`,
      count: total,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/reindex/retry-failed
 * Chỉ re-index lại đúng các bài lỗi ở lượt gần nhất (vd bị dính rate limit Gemini giữa chừng) —
 * không chạy lại toàn bộ.
 */
router.post('/retry-failed', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const { started, total } = await retryFailedReindex();

    if (!started) {
      return res.status(409).json({
        message: total === 0 ? 'No failed articles to retry' : 'Another re-index run is in progress',
        total,
      });
    }

    res.json({ message: `Started retrying ${total} failed articles`, count: total });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/reindex/status
 * Tiến trình lượt re-index toàn bộ gần nhất (đang chạy / đã xong / chưa từng chạy).
 */
router.get('/status', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const progress = await getReindexProgress();
    res.json(progress);
  } catch (err) {
    next(err);
  }
});

export default router;
