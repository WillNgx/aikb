import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { requireSuperAdmin } from '../../middleware/requireAdmin';
import {
  TelegramUserNotFoundError,
  TelegramUserStateError,
  approveTelegramUser,
  countPending,
  deleteTelegramUser,
  listTelegramUsers,
  rejectTelegramUser,
  revokeTelegramUser,
  setTelegramUserKb,
} from './telegram.service';

const router = Router();

// Toàn bộ endpoint quản lý tài khoản Telegram chỉ dành cho Quản trị HỆ THỐNG — chốt chặn nằm ở
// BE, KHÔNG phải chỉ ẩn nút bên FE.
//
// Vì sao không mở cho Quản trị KB: hệ thống dùng CHUNG một bot token cho mọi ngôn ngữ, và chính
// màn hình này là nơi gán một tài khoản Telegram vào KB nào. Cho Quản trị KB vào đây là cho họ
// kéo người dùng của KB khác về KB mình.
router.use(authenticate, requireSuperAdmin);

const VALID_STATUSES = ['pending', 'approved', 'rejected'] as const;
type TelegramStatus = (typeof VALID_STATUSES)[number];

/** Map lỗi nghiệp vụ của service sang HTTP status — router không chứa business logic. */
function handleError(err: unknown, next: (e?: unknown) => void, res: import('express').Response) {
  if (err instanceof TelegramUserNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof TelegramUserStateError) {
    res.status(409).json({ error: err.message });
    return;
  }
  next(err);
}

// ─── GET /api/admin/telegram/pending-count ──────────────────────────────────
// Route path TĨNH phải khai báo TRƯỚC các route có tham số, nếu không Express khớp nhầm.

router.get('/pending-count', async (_req, res, next) => {
  try {
    res.json({ count: await countPending() });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/admin/telegram — Danh sách, lọc theo trạng thái ───────────────

router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query as { status?: string };

    if (status && status !== 'all' && !VALID_STATUSES.includes(status as TelegramStatus)) {
      res.status(400).json({ error: 'Trạng thái lọc không hợp lệ' });
      return;
    }

    const filter = status && status !== 'all' ? (status as TelegramStatus) : undefined;
    res.json(await listTelegramUsers(filter));
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/admin/telegram/:id/approve — Duyệt ─────────────────────────

router.patch('/:id/approve', async (req, res, next) => {
  try {
    const actor = { id: req.user!.id, email: req.user!.email };
    res.json(await approveTelegramUser(req.params.id as string, actor));
  } catch (err) {
    handleError(err, next, res);
  }
});

// ─── PATCH /api/admin/telegram/:id/reject — Từ chối ────────────────────────

router.patch('/:id/reject', async (req, res, next) => {
  try {
    const actor = { id: req.user!.id, email: req.user!.email };
    res.json(await rejectTelegramUser(req.params.id as string, actor));
  } catch (err) {
    handleError(err, next, res);
  }
});

// ─── PATCH /api/admin/telegram/:id/kb — Gán KB cho tài khoản Telegram ──────
// Bot đọc cột này để biết trả lời bằng dữ liệu của KB nào.

router.patch('/:id/kb', async (req, res, next) => {
  try {
    const { kbCode } = req.body as { kbCode?: string };
    if (!kbCode) {
      res.status(400).json({ error: 'Thiếu kbCode' });
      return;
    }
    const actor = { id: req.user!.id, email: req.user!.email };
    res.json(await setTelegramUserKb(req.params.id as string, kbCode, actor));
  } catch (err) {
    handleError(err, next, res);
  }
});

// ─── PATCH /api/admin/telegram/:id/revoke — Thu hồi quyền đã cấp ───────────

router.patch('/:id/revoke', async (req, res, next) => {
  try {
    const actor = { id: req.user!.id, email: req.user!.email };
    res.json(await revokeTelegramUser(req.params.id as string, actor));
  } catch (err) {
    handleError(err, next, res);
  }
});

// ─── DELETE /api/admin/telegram/:id — Xoá hẳn bản ghi ──────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const actor = { id: req.user!.id, email: req.user!.email };
    await deleteTelegramUser(req.params.id as string, actor);
    res.json({ success: true });
  } catch (err) {
    handleError(err, next, res);
  }
});

export default router;
