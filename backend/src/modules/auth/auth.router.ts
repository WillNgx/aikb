import { Router } from 'express';
import { authenticate } from '../../middleware/auth';

const router = Router();

/**
 * GET /api/auth/me
 * Trả về thông tin user đang đăng nhập (từ token JWT Supabase).
 * Client dùng để check session còn hợp lệ không.
 */
router.get('/me', authenticate, (req, res) => {
  res.json({
    id: req.user!.id,
    email: req.user!.email,
    role: req.user!.role,
    // KB mở mặc định — frontend dùng để chọn KB lúc mới đăng nhập rồi gửi kèm header `X-KB`.
    // CHỈ là mặc định, không phải giới hạn quyền: mọi tài khoản đọc và ghi được trên mọi KB.
    defaultKb: req.user!.defaultKb,
  });
});

export default router;
