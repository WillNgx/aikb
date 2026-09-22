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
import { AI_TEXT_KEYS, AI_TEXT_SETTING_KEYS, defaultAiTexts, getCustomAiTexts } from '../ai/aiTexts';
import { db } from '../../db';
import { auditLogs } from '../../db/schema';

const router = Router();

// Ai đăng nhập cũng xem được danh sách KB: mọi tài khoản đều ĐỌC được trên mọi KB.
// Quyền GHI thì khác nhau theo vai trò — xem `middleware/requireAdmin.ts`.
router.use(authenticate);

/**
 * GET /api/kb — danh sách KB đang bật, dùng cho nút chuyển KB và câu chào khung chat.
 *
 * Kèm `chatGreeting` ở đây (thay vì một endpoint riêng) vì khung chat vốn đã có sẵn danh sách này
 * trong cache — đổi KB là có ngay câu chào của KB mới, không tốn thêm request.
 */
router.get('/', async (_req, res, next) => {
  try {
    const ds = await listActiveKbs();
    // KHÔNG trả `schemaName` ra ngoài: đó là chi tiết lưu trữ phía trong, client không cần biết
    // và cũng không nên biết tên schema Postgres của hệ thống.
    const items = await Promise.all(
      ds.map(async (k) => ({
        code: k.code,
        name: k.name,
        locale: k.locale,
        sortOrder: k.sortOrder,
        chatGreeting: await runWithKb(k, () => getKbSetting(KB_SETTING_KEYS.chatGreeting, '')),
      }))
    );
    res.json({ items });
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
 * GET /api/kb/system-prompts — system prompt, câu chào và các câu AI trả lời sẵn của TẤT CẢ KB.
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
        const [value, chatGreeting, aiTexts] = await runWithKb(kb, () =>
          Promise.all([
            getKbSetting(KB_SETTING_KEYS.systemPrompt, ''),
            getKbSetting(KB_SETTING_KEYS.chatGreeting, ''),
            getCustomAiTexts(),
          ])
        );
        return {
          code: kb.code,
          name: kb.name,
          locale: kb.locale,
          systemPrompt: value,
          chatGreeting,
          /** Câu Admin đã đặt riêng (rỗng = chưa đặt) + câu mặc định để giao diện hiện làm gợi ý. */
          aiTexts,
          aiTextDefaults: defaultAiTexts(kb.locale),
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

const systemPromptSchema = z.object({
  systemPrompt: z.string().max(20_000),
  // Tuỳ chọn để frontend cũ (chỉ gửi systemPrompt) vẫn chạy được trong lúc hai bên deploy lệch nhau
  chatGreeting: z.string().max(1_000).optional(),
  // Khoá phải khớp AI_TEXT_KEYS (modules/ai/aiTexts.ts)
  aiTexts: z
    .object({
      noAnswer: z.string().max(1_000),
      clarify: z.string().max(1_000),
      compareAll: z.string().max(100),
      providerNote: z.string().max(1_000),
    })
    .partial()
    .optional(),
});

/**
 * PUT /api/kb/:code/system-prompt — đổi system prompt, câu chào và các câu AI trả lời sẵn của một KB.
 *
 * Chỉ ghi những ô THỰC SỰ đổi, và ghi audit_logs kèm danh sách ô đã đổi. Cố ý không chép nguyên
 * văn prompt vào audit (dài tới 20.000 ký tự) — nhật ký chỉ cần trả lời "ai sửa gì, lúc nào".
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
      const { systemPrompt, chatGreeting, aiTexts } = req.body as z.infer<typeof systemPromptSchema>;

      const kb = await getKb(code); // Ném 404 nếu mã sai hoặc KB đã tắt

      if (actor.role !== 'super_admin' && actor.defaultKb !== kb.code) {
        throw new AppError(
          403,
          `You can only edit the System prompt of Knowledge Base "${actor.defaultKb}"`
        );
      }

      // Khoá kb_settings → giá trị mới, chỉ gồm những ô client có gửi lên
      const updates: Record<string, string> = { [KB_SETTING_KEYS.systemPrompt]: systemPrompt.trim() };
      if (chatGreeting !== undefined) updates[KB_SETTING_KEYS.chatGreeting] = chatGreeting.trim();
      for (const k of AI_TEXT_KEYS) {
        const v = aiTexts?.[k];
        if (v !== undefined) updates[AI_TEXT_SETTING_KEYS[k]] = v.trim();
      }

      const changed = await runWithKb(kb, async () => {
        const doi: string[] = [];
        for (const [key, value] of Object.entries(updates)) {
          if ((await getKbSetting(key, '')) === value) continue;
          await setKbSetting(key, value);
          doi.push(key);
        }
        return doi;
      });

      if (changed.length) {
        await db.insert(auditLogs).values({
          action: 'system_prompt_edit',
          actorId: actor.id,
          actorEmail: actor.email,
          targetType: 'kb',
          kbCode: kb.code,
          meta: { changed },
        });
      }

      res.json({ code: kb.code, changed });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
