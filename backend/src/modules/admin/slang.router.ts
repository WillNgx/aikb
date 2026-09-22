import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import { validateBody } from '../../middleware/validate';
import { db } from '../../db';
import { auditLogs } from '../../db/schema';
import { currentKb, kbTables } from '../kb/kb.context';
import { eq, ilike, and } from 'drizzle-orm';

const router = Router();

// All routes are admin-only
router.use(authenticate, requireAdmin);

// ─── Validation Schemas ───────────────────────────────────────────────────────

const createSlangSchema = z.object({
  slangTerm: z.string().min(1, 'Slang term is required').max(200).trim()
    .transform((s) => s.toLowerCase()),
  normalizedEntity: z.string().min(1, 'Standard term is required').max(200).trim(),
  targetType: z.enum(['provider', 'bet_type', 'platform', 'category', 'general']).default('general'),
  notes: z.string().max(1000).optional(),
  isActive: z.boolean().default(true),
});

const updateSlangSchema = z.object({
  slangTerm: z.string().min(1).max(200).trim().transform((s) => s.toLowerCase()).optional(),
  normalizedEntity: z.string().min(1).max(200).trim().optional(),
  targetType: z.enum(['provider', 'bet_type', 'platform', 'category', 'general']).optional(),
  notes: z.string().max(1000).optional().nullable(),
  isActive: z.boolean().optional(),
});

// ─── GET /api/admin/slang — Lấy danh sách từ điển ───────────────────────────

/**
 * GET /api/admin/slang
 * Query params: ?type=provider&search=saba&activeOnly=true
 */
router.get('/', async (req, res, next) => {
  const { slangDictionary } = kbTables();
  try {
    const { type, search, activeOnly } = req.query as {
      type?: string;
      search?: string;
      activeOnly?: string;
    };

    let query = db.select().from(slangDictionary).$dynamic();

    const conditions = [];
    if (type && type !== 'all') {
      conditions.push(eq(slangDictionary.targetType, type as any));
    }
    if (search) {
      conditions.push(ilike(slangDictionary.slangTerm, `%${search}%`));
    }
    if (activeOnly === 'true') {
      conditions.push(eq(slangDictionary.isActive, true));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const entries = await query.orderBy(
      slangDictionary.targetType,
      slangDictionary.slangTerm
    );

    res.json(entries);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/admin/slang — Thêm từ mới ────────────────────────────────────

router.post('/', validateBody(createSlangSchema), async (req, res, next) => {
  const { slangDictionary } = kbTables();
  try {
    const body = req.body as z.infer<typeof createSlangSchema>;

    const [entry] = await db
      .insert(slangDictionary)
      .values({
        ...body,
        createdBy: req.user!.id,
      })
      .returning();

    await db.insert(auditLogs).values({
      action: 'slang_create',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: entry.id,
      targetType: 'slang',
      kbCode: currentKb().code,
      meta: { slangTerm: entry.slangTerm, normalizedEntity: entry.normalizedEntity },
    });

    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/admin/slang/:id — Cập nhật từ ───────────────────────────────

router.patch('/:id', validateBody(updateSlangSchema), async (req, res, next) => {
  const { slangDictionary } = kbTables();
  try {
    const id = req.params.id as string;
    const body = req.body as z.infer<typeof updateSlangSchema>;

    const [existing] = await db
      .select()
      .from(slangDictionary)
      .where(eq(slangDictionary.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: 'Slang term not found' });
      return;
    }

    const [updated] = await db
      .update(slangDictionary)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(slangDictionary.id, id))
      .returning();

    await db.insert(auditLogs).values({
      action: 'slang_edit',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: id,
      targetType: 'slang',
      kbCode: currentKb().code,
      meta: { before: existing.slangTerm, changes: body },
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/admin/slang/:id — Xóa từ ───────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  const { slangDictionary } = kbTables();
  try {
    const id = req.params.id as string;

    const [existing] = await db
      .select()
      .from(slangDictionary)
      .where(eq(slangDictionary.id, id))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: 'Slang term not found' });
      return;
    }

    await db.delete(slangDictionary).where(eq(slangDictionary.id, id));

    await db.insert(auditLogs).values({
      action: 'slang_delete',
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      targetId: id,
      targetType: 'slang',
      kbCode: currentKb().code,
      meta: { deleted: existing.slangTerm },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/admin/slang/export — Xuất toàn bộ từ điển ─────────────────────

router.get('/export', async (_req, res, next) => {
  const { slangDictionary } = kbTables();
  try {
    const allEntries = await db
      .select()
      .from(slangDictionary)
      .where(eq(slangDictionary.isActive, true))
      .orderBy(slangDictionary.slangTerm);

    // Trả về JSON (FE có thể tải về hoặc hiển thị)
    res.setHeader('Content-Disposition', 'attachment; filename="slang-dictionary.json"');
    res.json(allEntries);
  } catch (err) {
    next(err);
  }
});

export default router;
