import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { isAdminRole, requireAdmin } from '../../middleware/requireAdmin';
import { validateBody } from '../../middleware/validate';
import * as nodesService from './nodes.service';
import { tiptapDocSchema } from './docContent.schema';

const router = Router();

// ─── Schemas ──────────────────────────────────────────────────────────────────
// Article: theo Folio Workflow Spec, tạo không hỏi tên trước — tên rỗng hợp lệ lúc tạo.
// Folder: vẫn bắt buộc tên ngay từ đầu (không có "Folder chưa đặt tên" nào tồn tại).
const createSchema = z
  .object({
    name: z.string().max(500).default(''),
    type: z.enum(['folder', 'article']),
    parentId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => data.type !== 'folder' || data.name.trim().length > 0, {
    message: 'Tên thư mục bắt buộc',
    path: ['name'],
  });

// name không còn .min(1): auto-save-khi-rời-trang có thể Lưu 1 Article chưa kịp đặt tên
// (nút "Lưu" ở UI vẫn tự giữ validate rỗng riêng cho thao tác Lưu chủ động, đây chỉ nới
// lỏng tầng API để không chặn auto-save).
const updateSchema = z.object({
  name: z.string().max(500).optional(),
  body: tiptapDocSchema.optional(),
});

const moveSchema = z.object({
  parentId: z.string().uuid().nullable(), // null = root
});

const providerSchema = z.object({
  isProvider: z.boolean(),
});

const reorderSchema = z.object({
  parentId: z.string().uuid().nullable(), // null = root
  orderedIds: z.array(z.string().uuid()).min(1),
});

// ─── GET /api/nodes/tree — Lấy toàn bộ cây ───────────────────────────────────
router.get('/tree', authenticate, async (req, res, next) => {
  try {
    const tree = await nodesService.getTree(req.user!.role);
    res.json(tree);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/nodes/:id — Lấy chi tiết 1 node ────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const node = await nodesService.getNodeById(req.params.id as string);
    if (!node) {
      res.status(404).json({ error: 'Node không tồn tại' });
      return;
    }
    // User thường chỉ xem Published
    if (!isAdminRole(req.user!.role) && node.status !== 'published') {
      res.status(403).json({ error: 'Bài viết chưa được xuất bản' });
      return;
    }
    res.json(node);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/nodes — Tạo node mới (Admin) ──────────────────────────────────
router.post('/', authenticate, requireAdmin, validateBody(createSchema), async (req, res, next) => {
  try {
    const node = await nodesService.createNode(req.body, req.user!);
    res.status(201).json(node);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/nodes/reorder — Sắp xếp lại vị trí các node cùng cấp cha (Admin) ──
// Lưu ý: phải khai báo TRƯỚC route "/:id" bên dưới, nếu không Express sẽ khớp nhầm
// "reorder" vào tham số :id.
router.patch('/reorder', authenticate, requireAdmin, validateBody(reorderSchema), async (req, res, next) => {
  try {
    await nodesService.reorderNodes(req.body.parentId, req.body.orderedIds, req.user!);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/nodes/:id — Cập nhật tên/body (Admin) ────────────────────────
router.patch('/:id', authenticate, requireAdmin, validateBody(updateSchema), async (req, res, next) => {
  try {
    const node = await nodesService.updateNode(req.params.id as string, req.body, req.user!);
    res.json(node);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/nodes/:id/move — Di chuyển node (Admin) ─────────────────────
router.patch('/:id/move', authenticate, requireAdmin, validateBody(moveSchema), async (req, res, next) => {
  try {
    const node = await nodesService.moveNode(
      req.params.id as string,
      req.body.parentId,
      req.user!
    );
    res.json(node);
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /api/nodes/:id/provider — Đánh dấu/bỏ đánh dấu Folder là Provider (Admin) ──
router.patch('/:id/provider', authenticate, requireAdmin, validateBody(providerSchema), async (req, res, next) => {
  try {
    const node = await nodesService.setProviderFlag(
      req.params.id as string,
      req.body.isProvider,
      req.user!
    );
    res.json(node);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/nodes/:id/publish — Publish article (Admin) ───────────────────
router.post('/:id/publish', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const node = await nodesService.publishNode(req.params.id as string, req.user!);
    res.json(node);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/nodes/:id — Xóa node (Admin) ────────────────────────────────
router.delete('/:id', authenticate, requireAdmin, async (req, res, next) => {
  try {
    const result = await nodesService.deleteNode(req.params.id as string, req.user!);
    res.json({ success: true, parentId: result.parentId });
  } catch (err) {
    next(err);
  }
});

export default router;
