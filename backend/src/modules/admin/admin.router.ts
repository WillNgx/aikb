import { Router } from 'express';
import { z } from 'zod';
import { authenticate, type AuthUser } from '../../middleware/auth';
import { requireAdmin, requireSuperAdmin } from '../../middleware/requireAdmin';
import { validateBody } from '../../middleware/validate';
import { db } from '../../db';
import { users, auditLogs, analyticsEvents, appSettings } from '../../db/schema';
import { eq, desc, gte, sql, and, ne } from 'drizzle-orm';
import { AppError, businessRuleViolation, notFound } from '../../lib/AppError';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import {
  getChatProviderSettings,
  saveChatConfig,
  testChatProvider,
  fetchProviderModels,
  isChatProviderId,
  listCustomGateways,
  createCustomGateway,
  updateCustomGateway,
  deleteCustomGateway,
  testDirectGateway,
  listDirectGatewayModels,
} from '../llm/llm.service';
import type { ChatProviderId } from '../llm/llm.types';
import { KB_SETTING_KEYS, getKbNumberSetting, setKbSetting } from '../kb/kbSettings.service';
import { isValidKb } from '../kb/kb.registry';
import {
  AI_CHAT_LIMIT_RANGE,
  AI_CHAT_WINDOW_MS,
  GENERAL_LIMIT_RANGE,
  GENERAL_WINDOW_MS,
  getRateLimitConfig,
  saveRateLimitConfig,
} from '../../middleware/rateLimiter';

const router = Router();
const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ─── User Management ─────────────────────────────────────────────────────────

/**
 * Đếm số Quản trị HỆ THỐNG còn hoạt động khác ngoài `excludeUserId`.
 *
 * Dùng để chặn thao tác làm hệ thống không còn ai quản trị được: khoá, xoá hoặc hạ cấp mất
 * Quản trị hệ thống cuối cùng là mất luôn quyền quản lý tài khoản, tạo KB, đổi cấu hình — và
 * không có đường tự phục hồi từ giao diện, phải vào thẳng DB sửa tay.
 *
 * Quản trị KB KHÔNG được tính vào đây: họ không làm được những việc kể trên nên còn bao nhiêu
 * Quản trị KB cũng không cứu được hệ thống.
 */
async function countOtherEnabledSuperAdmins(excludeUserId: string): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.role, 'super_admin'), eq(users.enabled, true), ne(users.id, excludeUserId))
    );
  return rows.length;
}

/**
 * Quản trị KB chỉ được đụng vào tài khoản NGƯỜI DÙNG thuộc đúng KB mình phụ trách.
 *
 * Hai lớp chặn tách bạch: `requireAdmin` chặn theo KB của REQUEST (header `X-KB`), còn hàm này
 * chặn theo KB của TÀI KHOẢN BỊ TÁC ĐỘNG — thiếu lớp thứ hai thì Quản trị KB tiếng Việt vẫn
 * xoá được tài khoản của KB tiếng Anh chỉ bằng cách đứng ở KB của mình mà gọi API.
 */
function assertCanManageUser(actor: AuthUser, target: { role: string; defaultKb: string }): void {
  if (actor.role === 'super_admin') return;

  if (target.role !== 'user') {
    throw new AppError(403, 'Only System administrators can manage administrator accounts');
  }
  if (target.defaultKb !== actor.defaultKb) {
    throw new AppError(
      403,
      `This account belongs to Knowledge Base "${target.defaultKb}"; you can only manage accounts of "${actor.defaultKb}"`
    );
  }
}

const createUserSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['super_admin', 'admin', 'user']).default('user'),
  // Bỏ trống thì lấy theo KB của người tạo — Quản trị KB không cần (và không được) chọn.
  defaultKb: z.string().min(1).optional(),
});

const roleSchema = z.object({ role: z.enum(['super_admin', 'admin', 'user']) });
const defaultKbSchema = z.object({ defaultKb: z.string().min(1) });

/** GET /api/admin/users */
router.get('/users', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const allUsers = await db.select().from(users).orderBy(desc(users.createdAt));
    res.json(allUsers);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/users — Admin tạo tài khoản (không self-signup — BR-011).
 *
 * Quản trị KB cũng tạo được, nhưng bị ép hai điều: chỉ tạo vai trò `user`, và tài khoản mới
 * luôn thuộc đúng KB họ phụ trách. Ép ở backend chứ không chỉ ẩn ô chọn ngoài giao diện —
 * giao diện chỉ là gợi ý, ai cũng gọi thẳng API được.
 */
router.post('/users', authenticate, requireAdmin, validateBody(createUserSchema), async (req, res, next) => {
  try {
    const actor = req.user!;
    const body = req.body as {
      email: string;
      password: string;
      role: 'super_admin' | 'admin' | 'user';
      defaultKb?: string;
    };
    const { email, password } = body;

    const laSuper = actor.role === 'super_admin';
    if (!laSuper && body.role !== 'user') {
      throw new AppError(403, 'You can only create User accounts');
    }

    const role = laSuper ? body.role : 'user';
    const defaultKb = laSuper ? body.defaultKb ?? actor.defaultKb : actor.defaultKb;

    if (laSuper && !(await isValidKb(defaultKb))) {
      throw new AppError(400, `Knowledge Base "${defaultKb}" does not exist or is disabled`);
    }

    // Tạo user trong Supabase Auth
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error || !data.user) {
      res.status(400).json({ error: error?.message ?? 'Failed to create the user' });
      return;
    }

    // Tạo record trong bảng users của app
    const [newUser] = await db
      .insert(users)
      .values({ id: data.user.id, email, role, enabled: true, defaultKb })
      .returning();

    // Audit log
    await db.insert(auditLogs).values({
      action: 'user_create',
      actorId: actor.id,
      actorEmail: actor.email,
      targetId: newUser.id,
      targetType: 'user',
      meta: { email, role, defaultKb },
    });

    res.status(201).json({
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      defaultKb: newUser.defaultKb,
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/admin/users/:id/enable */
router.patch('/users/:id/enable', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = req.params.id as string;

    const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) throw notFound('User not found');
    assertCanManageUser(req.user!, target);

    const [updated] = await db
      .update(users)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    if (!updated) { res.status(404).json({ error: 'User not found' }); return; }

    await db.insert(auditLogs).values({
      action: 'user_enable',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: updated.id,
      targetType: 'user',
    });

    res.json({ id: updated.id, enabled: updated.enabled });
  } catch (err) { next(err); }
});

/** PATCH /api/admin/users/:id/disable */
router.patch('/users/:id/disable', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = req.params.id as string;
    if (userId === req.user!.id) {
      res.status(400).json({ error: 'You cannot disable your own account' });
      return;
    }

    const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) throw notFound('User not found');
    assertCanManageUser(req.user!, target);

    // Chặn khoá mất Quản trị hệ thống cuối cùng — xem countOtherEnabledSuperAdmins
    if (
      target.role === 'super_admin' &&
      target.enabled &&
      (await countOtherEnabledSuperAdmins(userId)) === 0
    ) {
      throw businessRuleViolation(
        'Cannot disable the last active System administrator — nobody would be left to administer the system.',
        'LAST_ADMIN'
      );
    }

    const [updated] = await db
      .update(users)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();

    await db.insert(auditLogs).values({
      action: 'user_disable',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: updated.id,
      targetType: 'user',
    });

    res.json({ id: updated.id, enabled: updated.enabled });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/admin/users/:id — Xoá vĩnh viễn 1 tài khoản (chỉ Admin).
 *
 * Khác "Vô hiệu hoá" (`enabled = false`, chặn đăng nhập nhưng giữ tài khoản): đây là xoá cứng,
 * KHÔNG hoàn tác được, và giải phóng email để tạo lại tài khoản mới.
 *
 * Dữ liệu người đó để lại KHÔNG bị mất: cả 4 khoá ngoại trỏ tới `users.id`
 * (`nodes.created_by`, `slang_dictionary.created_by`, `audit_logs.actor_id`,
 * `analytics_events.user_id`) đều khai `ON DELETE SET NULL`, nên bài viết/log chỉ mất phần
 * liên kết chứ không bị xoá theo. Riêng audit log vẫn truy vết được vì `actor_email` đã được
 * lưu tách rời khỏi khoá ngoại ngay từ đầu.
 */
router.delete('/users/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const userId = req.params.id as string;

    if (userId === req.user!.id) {
      throw new AppError(400, 'You cannot delete your own account');
    }

    const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!target) throw notFound('User not found');
    assertCanManageUser(req.user!, target);

    // Chặn xoá mất Quản trị hệ thống cuối cùng — xem countOtherEnabledSuperAdmins
    if (target.role === 'super_admin' && (await countOtherEnabledSuperAdmins(userId)) === 0) {
      throw businessRuleViolation(
        'Cannot delete the last active System administrator — nobody would be left to administer the system.',
        'LAST_ADMIN'
      );
    }

    // Xoá ở Supabase Auth TRƯỚC, xoá row `users` SAU. Nếu làm ngược lại mà bước Auth lỗi thì
    // tài khoản Auth thành mồ côi: email không tạo lại được mà cũng không còn hiện trong UI
    // để xử lý tiếp.
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    // Không còn ở Auth (đã bị xoá tay từ trước) thì vẫn cho xoá tiếp row `users` để dọn sạch.
    const authMissing = !!authError && /not.*found/i.test(authError.message);
    if (authError && !authMissing) {
      throw new AppError(502, `Could not delete the account in Supabase Auth: ${authError.message}`);
    }

    await db.delete(users).where(eq(users.id, userId));

    // Ghi audit SAU khi xoá: `target_id` không có khoá ngoại nên vẫn lưu được id vừa bị xoá.
    await db.insert(auditLogs).values({
      action: 'user_delete',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: userId,
      targetType: 'user',
      meta: { email: target.email, role: target.role, authAccountMissing: authMissing },
    });

    res.json({ success: true, id: userId, email: target.email });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/admin/users/:id/role — đổi vai trò một tài khoản.
 *
 * CHỈ Quản trị hệ thống: ai được quản trị cái gì là quyết định ở tầm hệ thống. Nếu Quản trị KB
 * tự phong vai trò được thì phạm vi quyền theo KB mất ý nghĩa ngay lập tức.
 */
router.patch(
  '/users/:id/role',
  authenticate,
  requireSuperAdmin,
  validateBody(roleSchema),
  async (req, res, next) => {
    try {
      const userId = req.params.id as string;
      const { role } = req.body as { role: 'super_admin' | 'admin' | 'user' };

      if (userId === req.user!.id) {
        throw new AppError(400, 'You cannot change your own role');
      }

      const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) throw notFound('User not found');

      // Hạ cấp Quản trị hệ thống cuối cùng cũng nguy hiểm y như xoá — chặn cùng một lý do.
      if (
        target.role === 'super_admin' &&
        role !== 'super_admin' &&
        (await countOtherEnabledSuperAdmins(userId)) === 0
      ) {
        throw businessRuleViolation(
          'Cannot demote the last active System administrator — nobody would be left to administer the system.',
          'LAST_ADMIN'
        );
      }

      const [updated] = await db
        .update(users)
        .set({ role, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();

      await db.insert(auditLogs).values({
        action: 'user_edit',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: updated.id,
        targetType: 'user',
        meta: { change: 'role', email: target.email, from: target.role, to: role },
      });

      res.json({ id: updated.id, role: updated.role });
    } catch (err) { next(err); }
  }
);

/**
 * PATCH /api/admin/users/:id/default-kb — đổi KB của một tài khoản.
 *
 * CHỈ Quản trị hệ thống, vì với vai trò `admin` thì cột này CHÍNH LÀ phạm vi quyền: cho Quản
 * trị KB tự đổi là cho họ tự chuyển sang quản KB khác.
 *
 * Lưu ý vận hành: người đã từng đăng nhập trên máy của họ vẫn mở KB dùng lần trước (lựa chọn
 * được nhớ ở trình duyệt), đổi ở đây chỉ áp dụng cho lần đăng nhập trên máy/trình duyệt mới.
 */
router.patch(
  '/users/:id/default-kb',
  authenticate,
  requireSuperAdmin,
  validateBody(defaultKbSchema),
  async (req, res, next) => {
    try {
      const userId = req.params.id as string;
      const { defaultKb } = req.body as { defaultKb: string };

      if (!(await isValidKb(defaultKb))) {
        throw new AppError(400, `Knowledge Base "${defaultKb}" does not exist or is disabled`);
      }

      const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) throw notFound('User not found');

      const [updated] = await db
        .update(users)
        .set({ defaultKb, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();

      await db.insert(auditLogs).values({
        action: 'user_edit',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: updated.id,
        targetType: 'user',
        meta: { change: 'defaultKb', email: target.email, from: target.defaultKb, to: defaultKb },
      });

      res.json({ id: updated.id, defaultKb: updated.defaultKb });
    } catch (err) { next(err); }
  }
);

// ─── Audit Logs ───────────────────────────────────────────────────────────────

/** GET /api/admin/audit-logs */
router.get('/audit-logs', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const logs = await db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(200);
    res.json(logs);
  } catch (err) { next(err); }
});

// ─── Analytics ────────────────────────────────────────────────────────────────

/** GET /api/admin/analytics/summary */
router.get('/analytics/summary', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [searchCount, aiCount, noAnswerCount, topQueries] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(analyticsEvents)
        .where(and(eq(analyticsEvents.eventType, 'search'), gte(analyticsEvents.createdAt, thirtyDaysAgo))),
      db.select({ count: sql<number>`count(*)` }).from(analyticsEvents)
        .where(and(eq(analyticsEvents.eventType, 'ai_question'), gte(analyticsEvents.createdAt, thirtyDaysAgo))),
      db.select({ count: sql<number>`count(*)` }).from(analyticsEvents)
        .where(and(eq(analyticsEvents.eventType, 'ai_no_answer'), gte(analyticsEvents.createdAt, thirtyDaysAgo))),
      db.execute<{ query: string; count: number }>(sql`
        SELECT query, count(*) as count
        FROM analytics_events
        WHERE event_type = 'ai_no_answer'
          AND created_at >= ${thirtyDaysAgo}
          AND query IS NOT NULL
        GROUP BY query
        ORDER BY count DESC
        LIMIT 20
      `),
    ]);

    res.json({
      period: '30d',
      searches: Number(searchCount[0]?.count ?? 0),
      aiQuestions: Number(aiCount[0]?.count ?? 0),
      noAnswers: Number(noAnswerCount[0]?.count ?? 0),
      topUnansweredQueries: topQueries.rows,
    });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/admin/analytics — xoá TOÀN BỘ dữ liệu thống kê.
 *
 * KHÔNG HOÀN TÁC ĐƯỢC: mọi lượt tìm kiếm và câu hỏi AI đã ghi lại (cả từ web lẫn Telegram) đều
 * mất, các con số trên trang Thống kê về 0. FE bắt buộc phải hỏi xác nhận trước khi gọi.
 *
 * CỐ Ý KHÔNG ghi audit_logs: enum audit_action chưa có giá trị nào cho thao tác này, thêm vào
 * đòi hỏi một migration riêng — đã thống nhất bỏ qua. Nếu sau này cần truy vết ai xoá lúc nào
 * thì phải thêm giá trị enum trước, đừng mượn tạm một action có sẵn cho sai ngữ nghĩa.
 *
 * Đếm trước rồi mới xoá thay vì dùng .returning(): chỉ cần con số để báo lại cho Admin, không
 * cần kéo toàn bộ id của hàng nghìn dòng vừa xoá về Node.
 */
router.delete('/analytics', authenticate, requireSuperAdmin, async (_req, res, next) => {
  try {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(analyticsEvents);
    const deleted = Number(row?.count ?? 0);

    await db.delete(analyticsEvents);

    res.json({ success: true, deleted });
  } catch (err) {
    next(err);
  }
});

// ─── Keep-Alive (DEC-12) ─────────────────────────────────────────────────────

/** POST /api/admin/keep-alive — ping Supabase để tránh sleep trên free tier */
router.post('/keep-alive', authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const pingTime = new Date();

    // Ghi/cập nhật timestamp vào app_settings
    await db
      .insert(appSettings)
      .values({ key: 'last_keep_alive', value: pingTime.toISOString() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: pingTime.toISOString(), updatedAt: pingTime },
      });

    res.json({ ok: true, pingedAt: pingTime.toISOString() });
  } catch (err) { next(err); }
});

/** GET /api/admin/keep-alive — lấy thời điểm ping gần nhất */
router.get('/keep-alive', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const [setting] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'last_keep_alive'))
      .limit(1);

    res.json({ lastPingedAt: setting?.value ?? null });
  } catch (err) { next(err); }
});

// ─── Relevance Threshold Settings (Admin Config) ─────────────────────────────

const thresholdSchema = z.object({
  threshold: z.number().min(0.05, 'Minimum threshold is 0.05').max(1.0, 'Maximum threshold is 1.0'),
});

/** GET /api/admin/settings/threshold — lấy ngưỡng hiện tại */
router.get('/settings/threshold', authenticate, requireAdmin, async (req, res, next) => {
  try {
    // Theo TỪNG KB (có đường lùi về app_settings) — xem kbSettings.service.ts
    res.json({ threshold: await getKbNumberSetting(KB_SETTING_KEYS.relevanceThreshold, 0.45) });
  } catch (err) { next(err); }
});

/** PATCH /api/admin/settings/threshold — Admin cập nhật ngưỡng */
router.patch('/settings/threshold', authenticate, requireAdmin, validateBody(thresholdSchema), async (req, res, next) => {
  try {
    const { threshold } = req.body as { threshold: number };

    // Ghi vào kb_settings của KB đang chọn — mỗi ngôn ngữ một ngưỡng riêng
    await setKbSetting(KB_SETTING_KEYS.relevanceThreshold, threshold.toString());

    // Ghi audit log — targetId để null vì đây là setting toàn cục, không gắn với 1 entity
    // UUID cụ thể nào (cột target_id kiểu uuid, không nhận chuỗi tên setting)
    await db.insert(auditLogs).values({
      action: 'content_edit',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: null,
      targetType: 'setting',
      meta: { setting: 'relevance_threshold', newThreshold: threshold },
    });

    res.json({ success: true, threshold });
  } catch (err) { next(err); }
});

// ─── Related Links Count Settings (Admin Config) ─────────────────────────────
// Số link trích dẫn (📚) hiển thị cho user trong AI Chat box — không ảnh hưởng số nguồn AI dùng
// để trả lời (xem MAX_CONTEXT_CHUNKS trong ai.service.ts).

const relatedLinksCountSchema = z.object({
  count: z.number().int().min(1, 'At least 1 link').max(5, 'At most 5 links'),
});

/** GET /api/admin/settings/related-links-count — lấy số lượng link hiện tại */
router.get('/settings/related-links-count', authenticate, requireAdmin, async (req, res, next) => {
  try {
    // Theo TỪNG KB (có đường lùi về app_settings) — xem kbSettings.service.ts
    res.json({ count: await getKbNumberSetting(KB_SETTING_KEYS.relatedLinksCount, 2) });
  } catch (err) { next(err); }
});

/** PATCH /api/admin/settings/related-links-count — Admin cập nhật số lượng link */
router.patch(
  '/settings/related-links-count',
  authenticate,
  requireAdmin,
  validateBody(relatedLinksCountSchema),
  async (req, res, next) => {
    try {
      const { count } = req.body as { count: number };

      // Theo TỪNG KB — xem kbSettings.service.ts
      await setKbSetting(KB_SETTING_KEYS.relatedLinksCount, count.toString());

      await db.insert(auditLogs).values({
        action: 'content_edit',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: null,
        targetType: 'setting',
        meta: { setting: 'related_links_count', newCount: count },
      });

      res.json({ success: true, count });
    } catch (err) { next(err); }
  }
);

// ─── Rate Limit Settings (Admin Config) ──────────────────────────────────────
// Số request tối đa trên mỗi IP. Cửa sổ thời gian CỐ ĐỊNH (xem rateLimiter.ts), Admin chỉ chỉnh
// được số lượng — đổi có hiệu lực ngay, không cần restart server.

const rateLimitSchema = z.object({
  aiChatLimit: z
    .number()
    .int()
    .min(AI_CHAT_LIMIT_RANGE.min, `AI Chat limit must be at least ${AI_CHAT_LIMIT_RANGE.min}`)
    .max(AI_CHAT_LIMIT_RANGE.max, `AI Chat limit must be at most ${AI_CHAT_LIMIT_RANGE.max}`),
  generalLimit: z
    .number()
    .int()
    .min(GENERAL_LIMIT_RANGE.min, `General limit must be at least ${GENERAL_LIMIT_RANGE.min}`)
    .max(GENERAL_LIMIT_RANGE.max, `General limit must be at most ${GENERAL_LIMIT_RANGE.max}`),
});

/** GET /api/admin/settings/rate-limit — giới hạn hiện tại + khoảng cho phép để FE dựng form */
router.get('/settings/rate-limit', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const config = await getRateLimitConfig();
    res.json({
      ...config,
      aiChatWindowMs: AI_CHAT_WINDOW_MS,
      generalWindowMs: GENERAL_WINDOW_MS,
      aiChatRange: AI_CHAT_LIMIT_RANGE,
      generalRange: GENERAL_LIMIT_RANGE,
    });
  } catch (err) { next(err); }
});

/** PATCH /api/admin/settings/rate-limit — Admin cập nhật giới hạn */
router.patch(
  '/settings/rate-limit',
  authenticate,
  requireSuperAdmin,
  validateBody(rateLimitSchema),
  async (req, res, next) => {
    try {
      const { aiChatLimit, generalLimit } = req.body as { aiChatLimit: number; generalLimit: number };

      await saveRateLimitConfig(aiChatLimit, generalLimit);

      // targetId để null vì đây là setting toàn cục, không gắn với entity UUID nào
      await db.insert(auditLogs).values({
        action: 'content_edit',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: null,
        targetType: 'setting',
        meta: { setting: 'rate_limit', aiChatLimit, generalLimit },
      });

      res.json({ success: true, aiChatLimit, generalLimit });
    } catch (err) { next(err); }
  }
);

// ─── AI Chat Provider Settings (Admin Config) ────────────────────────────────
// Cho phép Admin đổi provider/model dùng cho AI Chat box mà không cần sửa code hay deploy lại.
// API key của từng provider vẫn nằm trong .env — UI chỉ biết "đã cấu hình" hay chưa, không bao
// giờ nhận được giá trị key.

const aiProviderSchema = z.object({
  provider: z.string().refine(isChatProviderId, 'Invalid provider'),
  model: z.string().trim().min(1, 'Model is required').max(200, 'Model name is too long'),
});

const aiProviderTestSchema = z.object({
  provider: z.string().refine(isChatProviderId, 'Invalid provider'),
  model: z.string().trim().max(200, 'Model name is too long').optional(),
});

/** GET /api/admin/settings/ai-provider — cấu hình hiện tại + trạng thái từng provider */
router.get('/settings/ai-provider', authenticate, requireAdmin, async (req, res, next) => {
  try {
    res.json(await getChatProviderSettings());
  } catch (err) { next(err); }
});

/** PATCH /api/admin/settings/ai-provider — Admin đổi provider/model cho AI Chat */
router.patch(
  '/settings/ai-provider',
  authenticate,
  requireSuperAdmin,
  validateBody(aiProviderSchema),
  async (req, res, next) => {
    try {
      const { provider, model } = req.body as { provider: ChatProviderId; model: string };

      await saveChatConfig(provider, model);

      // targetId để null vì đây là setting toàn cục, không gắn với entity UUID nào
      await db.insert(auditLogs).values({
        action: 'content_edit',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: null,
        targetType: 'setting',
        meta: { setting: 'ai_chat_provider', newProvider: provider, newModel: model },
      });

      res.json({ success: true, provider, model });
    } catch (err) { next(err); }
  }
);

/**
 * POST /api/admin/settings/ai-provider/test — gọi thử provider bằng 1 câu hỏi rất ngắn.
 * Dùng để Admin xác nhận key/model dùng được TRƯỚC khi lưu; không fallback sang provider khác.
 */
router.post(
  '/settings/ai-provider/test',
  authenticate,
  requireSuperAdmin,
  validateBody(aiProviderTestSchema),
  // Không dùng `next`: mọi lỗi ở đây đều là lỗi cấu hình của Admin, trả thẳng 400 (xem catch)
  async (req, res) => {
    try {
      const { provider, model } = req.body as { provider: ChatProviderId; model?: string };
      const result = await testChatProvider(provider, model);
      res.json(result);
    } catch (err) {
      // Lỗi ở đây là lỗi cấu hình của Admin (sai model, thiếu key, hết quota) chứ không phải
      // lỗi hệ thống — trả 400 kèm nguyên nhân để hiển thị thẳng trên UI.
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Could not call the provider',
      });
    }
  }
);

/**
 * GET /api/admin/settings/ai-provider/models?provider=... — hỏi nhà cung cấp xem key hiện tại
 * được dùng model nào.
 *
 * Khác `suggestedModels` trả kèm getChatProviderSettings: cái đó là danh sách cứng trong code
 * chỉ để gợi ý nhanh, còn đây là danh sách THẬT theo quyền của key. Cố ý để Admin bấm nút mới
 * gọi, không tự chạy khi mở trang — mỗi lần gọi là một request ra nhà cung cấp bên ngoài.
 */
router.get('/settings/ai-provider/models', authenticate, requireAdmin, async (req, res) => {
  try {
    const provider = String(req.query.provider ?? '');
    if (!isChatProviderId(provider)) {
      res.status(400).json({ error: 'Invalid provider' });
      return;
    }

    const result = await fetchProviderModels(provider);
    res.json(result);
  } catch (err) {
    // Cùng lý do với endpoint /test: đây là lỗi cấu hình (thiếu key, key sai, cổng chết) nên trả
    // 400 kèm nguyên nhân để hiện thẳng cho Admin, không phải lỗi hệ thống
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Could not load the model list',
    });
  }
});

// ─── Custom AI Gateways Management ──────────────────────────────────────────

const createCustomGatewaySchema = z.object({
  name: z.string().trim().min(1, 'Gateway name is required').max(100, 'Name is too long'),
  baseUrl: z.string().trim().url('Invalid Base URL (must start with http:// or https://)'),
  apiKey: z.string().trim().min(1, 'API Key is required'),
  defaultModel: z.string().trim().min(1, 'Default model is required').max(200),
  suggestedModels: z.array(z.string().trim()).optional(),
  isActive: z.boolean().optional(),
});

const updateCustomGatewaySchema = z.object({
  name: z.string().trim().min(1, 'Gateway name is required').max(100, 'Name is too long').optional(),
  baseUrl: z.string().trim().url('Invalid Base URL (must start with http:// or https://)').optional(),
  apiKey: z.string().trim().optional(),
  defaultModel: z.string().trim().min(1, 'Default model is required').max(200).optional(),
  suggestedModels: z.array(z.string().trim()).optional(),
  isActive: z.boolean().optional(),
});

const testDirectGatewaySchema = z.object({
  baseUrl: z.string().trim().url('Invalid Base URL'),
  apiKey: z.string().trim().min(1, 'API Key is required'),
  model: z.string().trim().min(1, 'Model is required'),
});

const listDirectModelsSchema = z.object({
  baseUrl: z.string().trim().url('Invalid Base URL'),
  apiKey: z.string().trim().min(1, 'API Key is required'),
});

/** GET /api/admin/settings/ai-gateways — Danh sách các cổng custom đã lưu */
router.get('/settings/ai-gateways', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const list = await listCustomGateways();
    res.json({ gateways: list });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/settings/ai-gateways — Tạo cổng AI Custom mới */
router.post(
  '/settings/ai-gateways',
  authenticate,
  requireSuperAdmin,
  validateBody(createCustomGatewaySchema),
  async (req, res, next) => {
    try {
      const created = await createCustomGateway(req.body);

      await db.insert(auditLogs).values({
        action: 'content_create',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: created.id,
        targetType: 'setting',
        meta: { setting: 'custom_ai_gateway', name: created.name, baseUrl: created.baseUrl },
      });

      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  }
);

/** PUT /api/admin/settings/ai-gateways/:id — Cập nhật cổng AI Custom */
router.put(
  '/settings/ai-gateways/:id',
  authenticate,
  requireSuperAdmin,
  validateBody(updateCustomGatewaySchema),
  async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const updated = await updateCustomGateway(id, req.body);

      await db.insert(auditLogs).values({
        action: 'content_edit',
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        targetId: updated.id,
        targetType: 'setting',
        meta: { setting: 'custom_ai_gateway', name: updated.name, baseUrl: updated.baseUrl },
      });

      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

/** DELETE /api/admin/settings/ai-gateways/:id — Xóa cổng AI Custom */
router.delete('/settings/ai-gateways/:id', authenticate, requireSuperAdmin, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    await deleteCustomGateway(id);

    await db.insert(auditLogs).values({
      action: 'content_delete',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: id,
      targetType: 'setting',
      meta: { setting: 'custom_ai_gateway', id },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/settings/ai-gateways/test-direct — Test trực tiếp thông số kết nối */
router.post(
  '/settings/ai-gateways/test-direct',
  authenticate,
  requireSuperAdmin,
  validateBody(testDirectGatewaySchema),
  async (req, res) => {
    try {
      const result = await testDirectGateway(req.body);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Could not call the custom AI gateway',
      });
    }
  }
);

/** POST /api/admin/settings/ai-gateways/models-direct — Tải danh sách model trực tiếp từ URL + Key */
router.post(
  '/settings/ai-gateways/models-direct',
  authenticate,
  requireSuperAdmin,
  validateBody(listDirectModelsSchema),
  async (req, res) => {
    try {
      const result = await listDirectGatewayModels(req.body);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Could not load the model list',
      });
    }
  }
);

export default router;
