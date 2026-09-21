import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import { validateBody } from '../../middleware/validate';
import {
  commitImport,
  getImportProgress,
  parseImportPayload,
  previewImport,
  updateProvider,
} from './promotions.service';

const router = Router();

// Nhập dữ liệu và sửa sảnh đều là thao tác ghi — chốt chặn nằm ở BE, không phải chỉ ẩn nút bên FE.
router.use(authenticate, requireAdmin);

/**
 * Frontend đọc file bằng FileReader rồi gửi NỘI DUNG đã parse lên đây, không dùng multipart.
 * Lý do: trình duyệt không cho lấy đường dẫn thật của file trên máy người dùng, mà dự án cũng
 * chưa có sẵn tầng xử lý upload file cho JSON — gửi thẳng JSON là đường ngắn nhất và
 * `express.json` đã để limit 8mb, thừa cho file khuyến mãi (~120KB/đợt).
 */
const importSchema = z.object({
  payload: z.unknown(),
  sourceFile: z.string().max(500).optional(),
});

const providerSchema = z.object({
  provider: z.string().max(100).nullable(),
});

// ─── Route TĨNH khai báo trước route có tham số ──────────────────────────────────────────────

/** Tiến trình mirror + index của lượt nhập gần nhất (FE poll để vẽ thanh tiến trình). */
router.get('/import/progress', async (_req, res, next) => {
  try {
    res.json(await getImportProgress());
  } catch (err) {
    next(err);
  }
});

/** Đối chiếu file mới với dữ liệu đang có — KHÔNG ghi gì. */
router.post('/import/preview', validateBody(importSchema), async (req, res, next) => {
  try {
    const { payload } = req.body as { payload: unknown };
    res.json(await previewImport(parseImportPayload(payload)));
  } catch (err) {
    next(err);
  }
});

/** Ghi phần thay đổi rồi chạy nền việc mirror sang cây tài liệu + index cho AI. */
router.post('/import/commit', validateBody(importSchema), async (req, res, next) => {
  try {
    const { payload, sourceFile } = req.body as { payload: unknown; sourceFile?: string };
    const diff = await commitImport(parseImportPayload(payload), sourceFile ?? null, req.user!);
    res.json(diff);
  } catch (err) {
    next(err);
  }
});

/** Admin sửa sảnh áp dụng cho 1 khuyến mãi. */
router.patch('/:id/provider', validateBody(providerSchema), async (req, res, next) => {
  try {
    const { provider } = req.body as { provider: string | null };
    res.json(await updateProvider(String(req.params.id), provider, req.user!));
  } catch (err) {
    next(err);
  }
});

export default router;
