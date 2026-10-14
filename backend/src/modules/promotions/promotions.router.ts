import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { providerOptions } from './promotionContent.util';
import {
  getPromotionDetail,
  listByMonth,
  listIncomplete,
  listMonths,
  listTagged,
  updateCodes,
} from './promotions.service';

const router = Router();

// Người dùng thường được XEM khuyến mãi (khác với cây tài liệu, khuyến mãi không có
// trạng thái Draft — đã nhập là hiển thị).
router.use(authenticate);

// ─── Route path TĨNH phải đứng TRƯỚC '/:id', nếu không Express khớp nhầm ─────────────────────

/** Danh sách năm/tháng + tổng số, dùng dựng cây bên trái và biết tháng nào cần nạp sẵn. */
router.get('/months', async (_req, res, next) => {
  try {
    res.json(await listMonths());
  } catch (err) {
    next(err);
  }
});

/** Danh sách sảnh cho ô chọn của Admin. */
router.get('/provider-options', (_req, res) => {
  res.json({ options: providerOptions() });
});

/** Danh sách khuyến mãi của MỘT tháng ('YYYY-MM' hoặc 'khong-han'). */
router.get('/', async (req, res, next) => {
  try {
    const month = String(req.query.month ?? '').trim();
    if (!month) {
      res.status(400).json({ error: 'Missing month parameter' });
      return;
    }
    res.json({ items: await listByMonth(month) });
  } catch (err) {
    next(err);
  }
});

/** Khuyến mãi được gắn tag ở đợt nhập gần nhất — mục 'New' trên trang Khuyến mãi. */
router.get('/new', async (_req, res, next) => {
  try {
    res.json({ items: await listTagged() });
  } catch (err) {
    next(err);
  }
});

/** Khuyến mãi còn thiếu Code hoặc Name Code — mục 'Chưa hoàn thiện'. */
router.get('/incomplete', async (_req, res, next) => {
  try {
    res.json({ items: await listIncomplete() });
  } catch (err) {
    next(err);
  }
});

const codesSchema = z.object({
  code: z.string().max(200).nullable(),
  codeName: z.string().max(300).nullable(),
});

/**
 * Sửa Code / Name Code. CỐ Ý không có `requireAdmin`: chủ dự án mở thao tác này cho mọi người
 * dùng đã đăng nhập (vẫn ghi audit_logs).
 */
router.patch('/:id/codes', validateBody(codesSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof codesSchema>;
    res.json(await updateCodes(String(req.params.id), body, req.user!));
  } catch (err) {
    next(err);
  }
});

/** Chi tiết 1 khuyến mãi; `versionId` để xem lại một phiên bản cũ. */
router.get('/:id', async (req, res, next) => {
  try {
    const versionId = req.query.versionId ? String(req.query.versionId) : undefined;
    res.json(await getPromotionDetail(req.params.id, versionId));
  } catch (err) {
    next(err);
  }
});

export default router;
