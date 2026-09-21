import { db } from '../../db';
import { auditLogs, appSettings } from '../../db/schema';
import { currentKb, kbTables } from '../kb/kb.context';
import { eq, isNull, asc, and } from 'drizzle-orm';
import { AuthUser } from '../../middleware/auth';
import { isAdminRole } from '../../middleware/requireAdmin';
import type { Node } from '../../db/schema';
import { triggerIndexing } from '../indexing/indexing.service';
import { computeNodeStatus } from './nodeStatus.util';
import { businessRuleViolation, notFound } from '../../lib/AppError';

export interface TreeNode {
  id: string;
  name: string;
  type: 'folder' | 'article';
  status: 'draft' | 'published';
  parentId: string | null;
  sortOrder: number;
  // TiptapDoc — xem frontend/src/data/docModel.ts. CHỈ có mặt ở các endpoint trả về 1 node
  // (getNodeById/create/update/publish/move); cây thư mục (getTree) KHÔNG bao giờ kèm body.
  body?: unknown;
  hasBeenSaved: boolean;
  isProvider: boolean;
  children?: TreeNode[];
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Hàng dữ liệu tối thiểu để dựng cây — KHÔNG có `body`. Xem getTree() bên dưới để biết vì sao.
 */
type NodeTreeRow = Omit<Node, 'body' | 'publishedName' | 'publishedBody' | 'createdBy'>;

/** Map cho các endpoint trả về 1 node cụ thể — CÓ `body` (nội dung bài viết đầy đủ). */
function toTreeNode(n: Node): Omit<TreeNode, 'children'> {
  return {
    ...toTreeNodeLite(n),
    body: n.body,
  };
}

/** Map cho cây thư mục — KHÔNG kèm `body`. */
function toTreeNodeLite(n: NodeTreeRow): Omit<TreeNode, 'children' | 'body'> {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    status: n.status,
    parentId: n.parentId,
    sortOrder: n.sortOrder,
    hasBeenSaved: n.hasBeenSaved,
    isProvider: n.isProvider,
    publishedAt: n.publishedAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

/**
 * Lấy tất cả nodes và tổ chức thành cây đệ quy.
 * Người dùng thường (không phải quản trị) không thấy Article ở trạng thái draft — Folder luôn
 * hiển thị (cấu trúc cây), vì status của Folder chỉ mang tính hình thức (không có
 * vòng đời Draft/Published thật cho Folder).
 *
 * CỐ Ý chỉ SELECT các cột dựng cây, KHÔNG lấy `body`: endpoint này được sidebar gọi ở MỌI
 * trang, mà `body` là tài liệu TipTap JSON ~15–20KB/bài. Trả kèm body nghĩa là mỗi lần vào
 * trang phải tải toàn bộ nội dung của mọi bài viết (ở mức 500 bài là ~10MB). Frontend không
 * đọc `body` từ cây — nội dung bài viết lấy riêng qua getNodeById (`GET /api/nodes/:id`).
 */
export async function getTree(actorRole: AuthUser['role']): Promise<TreeNode[]> {
  const { nodes } = kbTables();
  const allNodes = await db
    .select({
      id: nodes.id,
      name: nodes.name,
      type: nodes.type,
      status: nodes.status,
      parentId: nodes.parentId,
      sortOrder: nodes.sortOrder,
      hasBeenSaved: nodes.hasBeenSaved,
      isProvider: nodes.isProvider,
      publishedAt: nodes.publishedAt,
      createdAt: nodes.createdAt,
      updatedAt: nodes.updatedAt,
    })
    .from(nodes)
    .orderBy(asc(nodes.sortOrder), asc(nodes.createdAt));
  const visible =
    isAdminRole(actorRole)
      ? allNodes
      : allNodes.filter((n) => n.type === 'folder' || n.status === 'published');
  return buildTreeRecursive(visible, null);
}

function buildTreeRecursive(allNodes: NodeTreeRow[], parentId: string | null): TreeNode[] {
  return allNodes
    .filter((n) => n.parentId === parentId)
    .map((n) => ({
      ...toTreeNodeLite(n),
      children: buildTreeRecursive(allNodes, n.id),
    }));
}

/**
 * Lấy một node theo ID (kèm body đầy đủ)
 */
export async function getNodeById(id: string): Promise<TreeNode | null> {
  const { nodes } = kbTables();
  const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!node) return null;
  return toTreeNode(node);
}

/**
 * Tạo node mới (Folder hoặc Article).
 * Article: theo Folio Workflow Spec, không hỏi tên trước — tạo ngay với tên rỗng, mở
 * thẳng vào Chỉnh sửa. Folder: vẫn bắt buộc nhập tên trước khi tạo (router validate).
 */
export async function createNode(
  input: { name: string; type: 'folder' | 'article'; parentId?: string | null },
  actor: AuthUser
): Promise<TreeNode> {
  const { nodes } = kbTables();
  // Validate parentId nếu có
  if (input.parentId) {
    const [parent] = await db.select().from(nodes).where(eq(nodes.id, input.parentId)).limit(1);
    if (!parent || parent.type !== 'folder') {
      throw businessRuleViolation('Parent phải là một Thư mục hợp lệ');
    }
  }

  const [newNode] = await db
    .insert(nodes)
    .values({
      name: input.name.trim(),
      type: input.type,
      parentId: input.parentId ?? null,
      sortOrder: await getNextSortOrder(input.parentId ?? null),
      status: 'draft',
      body: null, // Article mới: chưa có tài liệu TipTap nào — frontend tự khởi tạo doc rỗng khi mở Chỉnh sửa
      hasBeenSaved: false,
      createdBy: actor.id,
    })
    .returning();

  await writeAuditLog('node_create', actor, newNode.id, { name: newNode.name, type: newNode.type });

  return { ...toTreeNode(newNode), children: [] };
}

/**
 * Cập nhật tên hoặc body (Lưu Draft).
 * status không được set thủ công — luôn tính lại bằng computeNodeStatus so với
 * publishedName/publishedBody (bản Đăng gần nhất). Nếu 1 Article đã Published mà Lưu ra
 * nội dung khác bản Đăng, nó rơi về Draft ngay — kể cả khi trước đó đang published — và bị
 * gỡ khỏi index ngay lập tức (User không được thấy nội dung Draft, khớp BR-009).
 */
export async function updateNode(
  id: string,
  input: { name?: string; body?: unknown },
  actor: AuthUser
): Promise<TreeNode> {
  const { nodes } = kbTables();
  const [existing] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!existing) throw notFound('Node không tồn tại');

  const newName = input.name ?? existing.name;
  const newBody = input.body !== undefined ? input.body : existing.body;
  const isArticle = existing.type === 'article';
  const newStatus = isArticle
    ? computeNodeStatus(newName, newBody, existing.publishedName, existing.publishedBody)
    : existing.status; // Folder: status vestigial, không đổi ở path này

  const [updated] = await db
    .update(nodes)
    .set({
      name: newName,
      body: newBody,
      status: newStatus,
      hasBeenSaved: isArticle ? true : existing.hasBeenSaved,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();

  await writeAuditLog('node_edit', actor, id, { name: updated.name });

  if (isArticle && existing.status === 'published' && updated.status === 'draft') {
    // Vừa lệch khỏi bản Đăng gần nhất → gỡ khỏi index ngay (không phải "reindex", vì nội
    // dung published-eligible không còn nữa cho tới khi Đăng lại).
    triggerIndexing(updated.id, 'unpublish').catch((err) =>
      console.error('[Nodes] Lỗi gỡ index sau khi edit làm lệch bản published:', err)
    );
  }
  // Nếu status vẫn 'published' (nội dung Lưu ra giống hệt bản Đăng) thì không cần re-index —
  // index hiện tại đã đúng với đúng bản Đăng đó, không có gì thay đổi để đồng bộ lại.

  return toTreeNode(updated);
}

/**
 * Di chuyển node sang parentId mới (null = root)
 * Kiểm tra circular reference để tránh thả folder vào chính con cháu của nó
 */
export async function moveNode(
  id: string,
  targetParentId: string | null,
  actor: AuthUser
): Promise<TreeNode> {
  const { nodes } = kbTables();
  const allNodes = await db.select().from(nodes);
  const source = allNodes.find((n) => n.id === id);
  if (!source) throw notFound('Node không tồn tại');

  // Không di chuyển vào chính nó
  if (id === targetParentId) throw businessRuleViolation('Không thể di chuyển node vào chính nó');

  // Kiểm tra circular: targetParentId không được là con cháu của source
  if (targetParentId && source.type === 'folder') {
    if (isDescendant(id, targetParentId, allNodes)) {
      throw businessRuleViolation('Không thể di chuyển Thư mục vào bên trong chính con/cháu của nó');
    }
  }

  // Validate target parent là folder
  if (targetParentId) {
    const target = allNodes.find((n) => n.id === targetParentId);
    if (!target || target.type !== 'folder') {
      throw businessRuleViolation('Thư mục đích không hợp lệ');
    }
  }

  const [updated] = await db
    .update(nodes)
    .set({
      parentId: targetParentId,
      sortOrder: await getNextSortOrder(targetParentId),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();

  await writeAuditLog('node_move', actor, id, { from: source.parentId, to: targetParentId });

  return toTreeNode(updated);
}

/**
 * Đánh dấu/bỏ đánh dấu 1 Folder là "Provider" (sảnh cược) — chỉ áp dụng cho Folder.
 * Dùng để suy ra provider của các Article nằm trong cây con khi index (xem
 * getAncestorProvider trong indexing.service.ts) và để AI Chat nhận diện Provider ngay
 * trong câu hỏi (xem detectProvider trong slang.service.ts) — cả 2 đều đọc trực tiếp danh
 * sách Folder có cờ này, không còn danh sách provider cứng nào trong code.
 */
export async function setProviderFlag(
  id: string,
  isProvider: boolean,
  actor: AuthUser
): Promise<TreeNode> {
  const { nodes } = kbTables();
  const [existing] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!existing) throw notFound('Node không tồn tại');
  if (existing.type !== 'folder') throw businessRuleViolation('Chỉ Thư mục mới có thể đánh dấu là Provider');

  const [updated] = await db
    .update(nodes)
    .set({ isProvider, updatedAt: new Date() })
    .where(eq(nodes.id, id))
    .returning();

  await writeAuditLog('node_edit', actor, id, { name: existing.name, isProvider });

  return toTreeNode(updated);
}

/**
 * Sắp xếp lại vị trí (sortOrder) của toàn bộ node cùng cấp cha `parentId` (null = root),
 * theo đúng thứ tự trong `orderedIds` — dùng cho tính năng kéo/thả đổi vị trí trong cây.
 * orderedIds phải khớp chính xác (không thiếu/thừa) với tập con hiện tại của parentId đó.
 */
export async function reorderNodes(
  parentId: string | null,
  orderedIds: string[],
  actor: AuthUser
): Promise<void> {
  const { nodes } = kbTables();
  const siblings = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(parentId === null ? isNull(nodes.parentId) : eq(nodes.parentId, parentId));

  const currentIds = new Set(siblings.map((s) => s.id));
  if (
    currentIds.size !== orderedIds.length ||
    !orderedIds.every((id) => currentIds.has(id))
  ) {
    throw businessRuleViolation('Danh sách sắp xếp không khớp với các mục con hiện tại của thư mục này');
  }

  await Promise.all(
    orderedIds.map((id, index) =>
      db.update(nodes).set({ sortOrder: index, updatedAt: new Date() }).where(eq(nodes.id, id))
    )
  );

  await writeAuditLog('node_move', actor, parentId, { action: 'reorder', orderedIds });
}

/** sortOrder tiếp theo để 1 node mới/được chuyển cha luôn xếp cuối danh sách anh em. */
async function getNextSortOrder(parentId: string | null): Promise<number> {
  const { nodes } = kbTables();
  const siblings = await db
    .select({ sortOrder: nodes.sortOrder })
    .from(nodes)
    .where(parentId === null ? isNull(nodes.parentId) : eq(nodes.parentId, parentId));
  if (siblings.length === 0) return 0;
  return Math.max(...siblings.map((s) => s.sortOrder)) + 1;
}

/** BR-012: có Article nào trong toàn bộ cây con của nodeId không (đệ quy, mọi cấp độ sâu). */
function hasArticleDescendant(nodeId: string, allNodes: Node[]): boolean {
  const children = allNodes.filter((n) => n.parentId === nodeId);
  for (const child of children) {
    if (child.type === 'article') return true;
    if (hasArticleDescendant(child.id, allNodes)) return true;
  }
  return false;
}

function isDescendant(sourceId: string, targetId: string, allNodes: Node[]): boolean {
  const children = allNodes.filter((n) => n.parentId === sourceId);
  for (const child of children) {
    if (child.id === targetId) return true;
    if (isDescendant(child.id, targetId, allNodes)) return true;
  }
  return false;
}

/**
 * Publish một Article node — chốt name/body hiện tại thành snapshot "bản Đăng gần nhất"
 * (publishedName/publishedBody). Đăng lại một Article đã Published là hành động bình
 * thường (không còn throw) — đây chính là hành vi Save-rồi-Publish-lại theo Folio spec.
 *
 * `awaitIndexing`: mặc định false (fire-and-forget, giữ nguyên UX nút "Đăng" hiện có — trả về
 * ngay, không chờ Gemini embedding). startPublishAll() bên dưới truyền true để CHỜ index xong
 * từng bài mới sang bài tiếp theo — bắt buộc phải tuần tự (giống startReindexAll) để tránh dồn
 * nhiều request embedding cùng lúc vượt quota Gemini free tier khi Đăng hàng loạt.
 */
export async function publishNode(
  id: string,
  actor: AuthUser,
  opts?: { awaitIndexing?: boolean }
): Promise<TreeNode> {
  const { nodes } = kbTables();
  const [existing] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
  if (!existing) throw notFound('Node không tồn tại');
  if (existing.type !== 'article') throw businessRuleViolation('Chỉ Article mới có thể Publish');

  const [updated] = await db
    .update(nodes)
    .set({
      status: 'published',
      publishedName: existing.name,
      publishedBody: existing.body,
      hasBeenSaved: true,
      publishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();

  await writeAuditLog('node_publish', actor, id, { name: existing.name });

  // Auto re-index ngay khi Publish (DEC-02) — không phụ thuộc thao tác thủ công riêng.
  const indexingPromise = triggerIndexing(updated.id, 'publish').catch((err) =>
    console.error('[Nodes] Lỗi index sau khi publish:', err)
  );
  if (opts?.awaitIndexing) {
    await indexingPromise;
  }

  return toTreeNode(updated);
}

// ─── Đăng toàn bộ Draft (Admin) ─────────────────────────────────────────────────
// Cùng cơ chế "chạy nền tuần tự + progress lưu app_settings" như startReindexAll trong
// indexing.service.ts — publish cũng gọi Gemini (qua triggerIndexing) nên cần tránh song song.

export interface PublishAllProgress {
  status: 'idle' | 'running' | 'done';
  total: number;
  processed: number;
  success: number;
  failed: number;
  failedNodeIds: string[];
  currentItem: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  // Đếm sống mỗi lần FE poll — không lưu trong snapshot progress vì có thể đổi giữa các lần
  // poll (admin publish/tạo bài ở tab khác trong lúc đang xem trang này).
  draftCount: number;
  totalArticleCount: number;
}

const PUBLISH_ALL_PROGRESS_KEY = 'publish_all_progress';

const IDLE_PUBLISH_ALL_PROGRESS: Omit<PublishAllProgress, 'draftCount' | 'totalArticleCount'> = {
  status: 'idle',
  total: 0,
  processed: 0,
  success: 0,
  failed: 0,
  failedNodeIds: [],
  currentItem: null,
  startedAt: null,
  finishedAt: null,
};

/** Bài Draft "hợp lệ" để Đăng toàn bộ — loại các Article mới tạo chưa từng Lưu lần nào
 * (hasBeenSaved=false, còn đang để trống dở dang), tránh Đăng nhầm bài rỗng người khác
 * đang soạn ở tab khác. */
async function getEligibleDraftArticles(): Promise<{ id: string; name: string }[]> {
  const { nodes } = kbTables();
  return db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(and(eq(nodes.type, 'article'), eq(nodes.status, 'draft'), eq(nodes.hasBeenSaved, true)));
}

async function countArticles(): Promise<number> {
  const { nodes } = kbTables();
  const rows = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.type, 'article'));
  return rows.length;
}

export async function getPublishAllProgress(): Promise<PublishAllProgress> {
  const [setting] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, PUBLISH_ALL_PROGRESS_KEY))
    .limit(1);

  let stored: Omit<PublishAllProgress, 'draftCount' | 'totalArticleCount'> = IDLE_PUBLISH_ALL_PROGRESS;
  if (setting) {
    try {
      stored = JSON.parse(setting.value);
    } catch {
      stored = IDLE_PUBLISH_ALL_PROGRESS;
    }
  }

  const [draftArticles, totalArticleCount] = await Promise.all([
    getEligibleDraftArticles(),
    countArticles(),
  ]);

  return { ...stored, draftCount: draftArticles.length, totalArticleCount };
}

async function savePublishAllProgress(
  progress: Omit<PublishAllProgress, 'draftCount' | 'totalArticleCount'>
): Promise<void> {
  const value = JSON.stringify(progress);
  await db
    .insert(appSettings)
    .values({ key: PUBLISH_ALL_PROGRESS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

/**
 * Bắt đầu Đăng toàn bộ Article đang Draft (đã từng Lưu). Trả về ngay (fire-and-forget) —
 * quá trình Đăng thật chạy nền tuần tự trong runPublishAllSequential.
 */
export async function startPublishAll(
  actor: AuthUser
): Promise<{ started: boolean; total: number }> {
  const current = await getPublishAllProgress();
  if (current.status === 'running') {
    return { started: false, total: current.total };
  }

  const targets = await getEligibleDraftArticles();
  if (targets.length === 0) {
    return { started: false, total: 0 };
  }

  const progress: Omit<PublishAllProgress, 'draftCount' | 'totalArticleCount'> = {
    ...IDLE_PUBLISH_ALL_PROGRESS,
    status: 'running',
    total: targets.length,
    startedAt: new Date().toISOString(),
  };
  await savePublishAllProgress(progress);

  runPublishAllSequential(targets, actor, progress).catch((err) => {
    console.error('[Nodes] startPublishAll: lỗi không mong đợi', err);
  });

  return { started: true, total: targets.length };
}

async function runPublishAllSequential(
  targets: { id: string; name: string }[],
  actor: AuthUser,
  progress: Omit<PublishAllProgress, 'draftCount' | 'totalArticleCount'>
): Promise<void> {
  for (const node of targets) {
    progress.currentItem = node.name;
    await savePublishAllProgress(progress);

    try {
      await publishNode(node.id, actor, { awaitIndexing: true });
      progress.success += 1;
    } catch (err) {
      console.error(`[Nodes] Đăng toàn bộ lỗi cho bài "${node.name}":`, err);
      progress.failed += 1;
      progress.failedNodeIds.push(node.id);
    }

    progress.processed += 1;
    await savePublishAllProgress(progress);
  }

  progress.status = 'done';
  progress.currentItem = null;
  progress.finishedAt = new Date().toISOString();
  await savePublishAllProgress(progress);
}

/**
 * Xóa một node
 * BR-012: Folder không được xóa nếu bên trong còn Article (kiểm tra đệ quy toàn bộ cây con,
 * kể cả Article nằm trong thư mục con) — Folder rỗng hoặc chỉ chứa thư mục con rỗng thì được
 * phép xóa bình thường.
 * Cascade: xóa toàn bộ children (thư mục con rỗng, nếu có) qua FK ON DELETE CASCADE thật
 * trong schema — trước migration 0003, cột parent_id không có constraint nào cả nên bước này
 * từng chỉ mồ côi children thay vì xóa chúng.
 */
export async function deleteNode(
  id: string,
  actor: AuthUser
): Promise<{ parentId: string | null }> {
  const { nodes } = kbTables();
  const allNodes = await db.select().from(nodes);
  const target = allNodes.find((n) => n.id === id);
  if (!target) throw notFound('Node không tồn tại');

  if (target.type === 'folder' && hasArticleDescendant(id, allNodes)) {
    throw businessRuleViolation(
      'BR-012: Không thể xóa thư mục khi bên trong còn Article (kể cả Article nằm trong thư mục con). Vui lòng xóa hoặc di chuyển các Article đó trước.',
      'BR-012'
    );
  }

  // Cascade delete (DB có ON DELETE CASCADE cho children)
  await db.delete(nodes).where(eq(nodes.id, id));
  await writeAuditLog('node_delete', actor, id, { name: target.name, type: target.type });

  // Auto re-index (xoá chunks) ngay khi Delete (DEC-02) — content_chunks cũng cascade theo FK,
  // nhưng gọi lại cho rõ ràng + để có log; vô hại nếu node không phải article/chưa từng index.
  triggerIndexing(id, 'delete').catch((err) =>
    console.error('[Nodes] Lỗi xoá index sau khi delete:', err)
  );

  return { parentId: target.parentId };
}

// ─── Helper ───────────────────────────────────────────────────────────────────
async function writeAuditLog(
  action: 'node_create' | 'node_edit' | 'node_delete' | 'node_move' | 'node_publish',
  actor: AuthUser,
  targetId: string | null,
  meta?: object
) {
  await db.insert(auditLogs).values({
    action,
    actorId: actor.id,
    actorEmail: actor.email,
    targetId,
    targetType: 'node',
    meta,
    // Mọi tài khoản đều sửa được nội dung của mọi KB, nên đây là thứ duy nhất truy ngược được
    // "ai đã sửa nội dung của ngôn ngữ nào".
    kbCode: currentKb().code,
  });
}
