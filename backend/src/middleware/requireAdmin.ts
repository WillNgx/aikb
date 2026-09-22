import { Request, Response, NextFunction } from 'express';
import { hasKbContext, currentKb } from '../modules/kb/kb.context';

/**
 * Hai chốt chặn quyền của hệ thống. Cả hai đều phải dùng SAU `authenticate`.
 *
 * Mô hình quyền (xem thêm `db/enums.ts`):
 *   - `super_admin` — Quản trị hệ thống: sửa được mọi KB, cộng các việc ở tầm hệ thống.
 *   - `admin`       — Quản trị KB: chỉ sửa được KB ghi ở `users.default_kb`.
 *   - `user`        — chỉ đọc.
 *
 * ⚠️ `requireAdmin` KHÔNG chỉ kiểm tra vai trò nữa mà kiểm tra luôn PHẠM VI KB. Làm ở đây chứ
 * không rải kiểm tra vào từng route là cố ý: hệ thống có hơn 50 điểm ghi dữ liệu, chỉ cần quên
 * một chỗ là Quản trị KB tiếng Việt sửa được nội dung tiếng Anh mà không có lỗi nào báo. Đặt
 * chốt ở đúng một chỗ thì route mới thêm sau này tự động được bảo vệ.
 */

/** Vai trò được xem là quản trị (ở mức nào đó). */
export function isAdminRole(role: string): boolean {
  return role === 'super_admin' || role === 'admin';
}

/**
 * Quản trị của KB đang phục vụ request.
 *
 * Quản trị hệ thống thì qua mọi KB. Quản trị KB chỉ GHI được khi KB trong ngữ cảnh (header
 * `X-KB`) đúng bằng KB họ phụ trách.
 *
 * ĐỌC (GET) thì không kiểm tra phạm vi KB — theo quyết định của chủ dự án, Quản trị KB xem được
 * thông tin của KB khác, chỉ không sửa. Nhờ vậy họ vẫn mở được trang Thống kê hay Nhật ký khi
 * đang xem KB khác, thay vì gặp màn hình lỗi khó hiểu.
 *
 * Không có ngữ cảnh KB thì CHẶN chứ không cho qua: `resolveKb` mắc toàn cục nên tình huống này
 * chỉ xảy ra khi có lỗi lắp ráp middleware, và im lặng cho qua sẽ thành lỗ thủng quyền.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  if (!isAdminRole(req.user.role)) {
    res.status(403).json({ error: 'You do not have access to Admin features' });
    return;
  }

  if (req.user.role === 'super_admin' || req.method === 'GET') {
    next();
    return;
  }

  if (!hasKbContext()) {
    res.status(500).json({ error: 'Could not determine the Knowledge Base of this request' });
    return;
  }

  const kbDangDung = currentKb().code;
  if (kbDangDung !== req.user.defaultKb) {
    res.status(403).json({
      error:
        `You can only edit Knowledge Base "${req.user.defaultKb}". ` +
        `This request targets "${kbDangDung}", where you only have read access.`,
    });
    return;
  }

  next();
}

/**
 * Chỉ Quản trị hệ thống. Dùng cho việc ở tầm hệ thống, không thuộc riêng KB nào: quản lý tài
 * khoản, tạo KB mới, cấu hình AI chung, giới hạn truy cập, Telegram, thống kê token.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  if (req.user.role !== 'super_admin') {
    res.status(403).json({ error: 'This feature is only available to System administrators' });
    return;
  }

  next();
}
