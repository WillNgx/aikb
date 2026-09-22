import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { requireSuperAdmin } from '../../middleware/requireAdmin';
import { validateQuery } from '../../middleware/validate';
import { db } from '../../db';
import { auditLogs } from '../../db/schema';
import { AppError } from '../../lib/AppError';
import {
  TOKEN_USAGE_RETENTION_MONTHS,
  deleteAllUsage,
  deleteUsageByDate,
  deleteUsageByMonth,
  getTokenUsageReport,
} from './tokenUsage.service';

/**
 * API thống kê token AI Chat cho trang AI Settings (chỉ Admin).
 * Toàn bộ business logic nằm ở tokenUsage.service — router chỉ lo validate + map lỗi + audit log.
 */

const router = Router();

/** Khoảng xem tối đa: 366 ngày và 12 tháng, khớp với hạn lưu trữ dữ liệu. */
const MAX_DAY_RANGE = 366;

const reportQuerySchema = z.object({
  granularity: z.enum(['day', 'month']).default('day'),
  range: z.coerce.number().int().min(1).max(MAX_DAY_RANGE).default(30),
});

/** GET /api/admin/token-usage?granularity=day|month&range=N */
router.get(
  '/',
  authenticate,
  requireSuperAdmin,
  validateQuery(reportQuerySchema),
  async (req, res, next) => {
    try {
      const { granularity, range } = (req as any).validatedQuery as z.infer<typeof reportQuerySchema>;

      // Biểu đồ tháng không được vượt hạn lưu trữ — xin nhiều hơn cũng chỉ có dữ liệu tới đó
      const effectiveRange =
        granularity === 'month' ? Math.min(range, TOKEN_USAGE_RETENTION_MONTHS) : range;

      const report = await getTokenUsageReport(granularity, effectiveRange);
      res.json({ ...report, granularity, range: effectiveRange, retentionMonths: TOKEN_USAGE_RETENTION_MONTHS });
    } catch (err) {
      next(err);
    }
  },
);

const deleteQuerySchema = z
  .object({
    /** Ngày cụ thể 'YYYY-MM-DD'. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format').optional(),
    /** Tháng cụ thể 'YYYY-MM'. */
    month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in YYYY-MM format').optional(),
    /** Bắt buộc gõ đúng 'all' để xoá sạch — tránh xoá nhầm toàn bộ khi thiếu tham số. */
    scope: z.literal('all').optional(),
  })
  .refine((v) => !(v.date && v.month), {
    message: 'Choose only one: date or month',
  });

/**
 * DELETE /api/admin/token-usage?date=YYYY-MM-DD | ?month=YYYY-MM | ?scope=all
 *
 * Xoá ĐỘC LẬP với nút "Xoá dữ liệu thống kê" (DELETE /api/admin/analytics) — hai bên dùng hai
 * bảng khác nhau, xoá bên này không ảnh hưởng bên kia.
 */
router.delete(
  '/',
  authenticate,
  requireSuperAdmin,
  validateQuery(deleteQuerySchema),
  async (req, res, next) => {
    try {
      const { date, month, scope } = (req as any).validatedQuery as z.infer<typeof deleteQuerySchema>;

      let deleted: number;
      let target: string;

      if (date) {
        deleted = await deleteUsageByDate(date);
        target = date;
      } else if (month) {
        deleted = await deleteUsageByMonth(month);
        target = month;
      } else if (scope === 'all') {
        deleted = await deleteAllUsage();
        target = 'all';
      } else {
        throw new AppError(400, 'Specify date, month or scope=all');
      }

      // targetId để null vì dữ liệu thống kê không gắn với entity UUID nào
      await db.insert(auditLogs).values({
        action: 'content_delete',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: null,
        targetType: 'token_usage',
        meta: { target, deletedRows: deleted },
      });

      res.json({ success: true, deleted, target });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
