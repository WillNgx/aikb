import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { requireAdmin, requireSuperAdmin } from '../../middleware/requireAdmin';
import { validateBody } from '../../middleware/validate';
import { AppError } from '../../lib/AppError';
import { getKb, listActiveKbs } from './kb.registry';
import { createKb } from './kb.admin.service';
import { runWithKb } from './kb.context';
import { KB_SETTING_KEYS, getKbSetting, setKbSetting } from './kbSettings.service';

const router = Router();

// Ai đăng nhập cũng xem được danh sách KB: mọi tài khoản đều ĐỌC được trên mọi KB.
// Quyền GHI thì khác nhau theo vai trò — xem `middleware/requireAdmin.ts`.
router.use(authenticate);

/** GET /api/kb — danh sách KB đang bật, dùng cho nút chuyển KB ở giao diện. */
router.get('/', async (_req, res, next) => {
  try {
    const ds = await listActiveKbs();
    // KHÔNG trả `schemaName` ra ngoài: đó là chi tiết lưu trữ phía trong, client không cần biết
    // và cũng không nên biết tên schema Postgres của hệ thống.
    res.json({
      items: ds.map((k) => ({
        code: k.code,
        name: k.name,
        locale: k.locale,
        sortOrder: k.sortOrder,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const createKbSchema = z.object({
  code: z.string().min(4).max(24),
  name: z.string().min(1).max(60),
  systemPrompt: z.string().max(20_000).optional(),
});

/**
 * POST /api/kb — tạo Knowledge Base mới.
 *
 * Chỉ Quản trị hệ thống: KB mới là hạ tầng dùng chung (thêm schema vào DB, thêm một lựa chọn vào
 * nút chuyển KB của MỌI người), không phải việc nội bộ của một ngôn ngữ.
 */
router.post('/', requireSuperAdmin, validateBody(createKbSchema), async (req, res, next) => {
  try {
    const { code, name, systemPrompt } = req.body as z.infer<typeof createKbSchema>;
    const kb = await createKb(
      { code, name, systemPrompt },
      { id: req.user!.id, email: req.user!.email }
    );
    res.status(201).json({
      code: kb.code,
      name: kb.name,
      locale: kb.locale,
      sortOrder: kb.sortOrder,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/kb/system-prompts — system prompt của TẤT CẢ các KB.
 *
 * Mọi quản trị đều xem được toàn bộ (theo quyết định của chủ dự án: xem được KB khác, không sửa).
 * Cờ `canEdit` để giao diện biết mở hay khoá ô nhập — quyền thật vẫn chốt ở endpoint PUT bên dưới.
 */
router.get('/system-prompts', requireAdmin, async (req, res, next) => {
  try {
    const actor = req.user!;
    const ds = await listActiveKbs();

    const items = await Promise.all(
      ds.map(async (kb) => {
        // Đọc `kb_settings` của MỘT KB cụ thể nên phải tự mở ngữ cảnh KB đó, thay vì dùng KB
        // đang hiển thị trên giao diện.
        const value = await runWithKb(kb, () =>
          getKbSetting(KB_SETTING_KEYS.systemPrompt, '')
        );
        return {
          code: kb.code,
          name: kb.name,
          locale: kb.locale,
          systemPrompt: value,
          /** Chưa đặt riêng thì AI dùng prompt mặc định (tiếng Việt) — giao diện phải nói rõ. */
          isDefault: !value,
          canEdit: actor.role === 'super_admin' || actor.defaultKb === kb.code,
        };
      })
    );

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

const systemPromptSchema = z.object({ systemPrompt: z.string().max(20_000) });

/**
 * PUT /api/kb/:code/system-prompt — đổi system prompt của một KB.
 *
 * Quản trị KB chỉ sửa được KB mình phụ trách. Kiểm tra theo `:code` chứ KHÔNG dựa vào header
 * `X-KB`: trang này sửa prompt của nhiều KB trên cùng một màn hình, nên KB đang hiển thị và KB
 * bị sửa là hai thứ khác nhau.
 */
router.put(
  '/:code/system-prompt',
  requireAdmin,
  validateBody(systemPromptSchema),
  async (req, res, next) => {
    try {
      const actor = req.user!;
      const code = req.params.code as string;
      const { systemPrompt } = req.body as z.infer<typeof systemPromptSchema>;

      const kb = await getKb(code); // Ném 404 nếu mã sai hoặc KB đã tắt

      if (actor.role !== 'super_admin' && actor.defaultKb !== kb.code) {
        throw new AppError(
          403,
          `Bạn chỉ được sửa System prompt của Knowledge Base "${actor.defaultKb}"`
        );
      }

      await runWithKb(kb, () => setKbSetting(KB_SETTING_KEYS.systemPrompt, systemPrompt.trim()));

      res.json({ code: kb.code, systemPrompt: systemPrompt.trim() });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
