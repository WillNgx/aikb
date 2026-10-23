import { db } from '../../db';
import { appSettings } from '../../db/schema';
import { kbTables } from '../kb/kb.context';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { embedText, isQuotaError } from '../embedding/embedding.service';
import { businessRuleViolation, conflict, notFound } from '../../lib/AppError';
import type { ChunkImage } from '../../db/kbSchema';

type IndexingAction = 'publish' | 'unpublish' | 'delete' | 'reindex';

/**
 * Fire-and-forget trigger. Chạy bất đồng bộ, không block request của user.
 * RISK đã note: indexing failure cần retry strategy sau; hiện tại chỉ log.
 *
 * Nguồn duy nhất là bảng `nodes` (cây Folder/Article) — hệ `content` (TipTap) cũ đã bị xóa
 * hoàn toàn khỏi hệ thống.
 */
export async function triggerIndexing(id: string, action: IndexingAction): Promise<void> {
  console.log(`[Indexing] Trigger: ${action} cho node ${id}`);

  if (action === 'unpublish' || action === 'delete') {
    await removeFromIndex(id);
    return;
  }

  if (action === 'publish' || action === 'reindex') {
    await indexNode(id);
  }
}

/**
 * Xoá toàn bộ chunks của 1 node khỏi index
 */
async function removeFromIndex(nodeId: string): Promise<void> {
  const { contentChunks } = kbTables();
  await db.delete(contentChunks).where(eq(contentChunks.nodeId, nodeId));
  console.log(`[Indexing] Đã xoá chunks: node ${nodeId}`);
}

// ─── Re-index toàn bộ (Admin) ──────────────────────────────────────────────────
// Dùng cho trường hợp cần backfill lại số lượng lớn bài viết (vd sau khi đổi cách chunk/gắn
// heading index). Chạy TUẦN TỰ từng bài (không song song như trước) để tránh dồn request vượt
// quota Gemini free tier (100 request/phút) — lỗi này đã xảy ra thực tế khi test. Tiến trình được
// lưu vào app_settings (key `reindex_progress`) để FE poll hiển thị thanh tiến trình thực.

export interface ReindexProgress {
  status: 'idle' | 'running' | 'done';
  total: number;
  processed: number;
  success: number;
  failed: number;
  // Id các node lỗi ở lượt chạy gần nhất — dùng cho retryFailedReindex() để chỉ chạy lại đúng
  // những bài này thay vì re-index lại từ đầu toàn bộ (tránh tốn quota Gemini cho bài đã ổn).
  failedNodeIds: string[];
  currentItem: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const REINDEX_PROGRESS_KEY = 'reindex_progress';

const IDLE_REINDEX_PROGRESS: ReindexProgress = {
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

export async function getReindexProgress(): Promise<ReindexProgress> {
  const [setting] = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, REINDEX_PROGRESS_KEY))
    .limit(1);

  if (!setting) return IDLE_REINDEX_PROGRESS;
  try {
    return JSON.parse(setting.value) as ReindexProgress;
  } catch {
    return IDLE_REINDEX_PROGRESS;
  }
}

async function saveReindexProgress(progress: ReindexProgress): Promise<void> {
  const value = JSON.stringify(progress);
  await db
    .insert(appSettings)
    .values({ key: REINDEX_PROGRESS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/**
 * Bắt đầu re-index toàn bộ Article đã Published. Trả về ngay (fire-and-forget) — quá trình thực
 * sự chạy nền tuần tự trong runReindexAllSequential. Chặn khởi động thêm 1 lượt mới nếu đang có
 * lượt re-index khác chạy dở (status running).
 */
export async function startReindexAll(): Promise<{ started: boolean; total: number }> {
  const { nodes } = kbTables();
  const current = await getReindexProgress();
  if (current.status === 'running') {
    return { started: false, total: current.total };
  }

  const publishedNodes = await db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(and(eq(nodes.status, 'published'), eq(nodes.type, 'article')));

  const progress: ReindexProgress = {
    ...IDLE_REINDEX_PROGRESS,
    status: 'running',
    total: publishedNodes.length,
    startedAt: new Date().toISOString(),
  };
  await saveReindexProgress(progress);

  runReindexSequential(publishedNodes, progress).catch((err) => {
    console.error('[Indexing] startReindexAll: lỗi không mong đợi', err);
  });

  return { started: true, total: publishedNodes.length };
}

/**
 * Chỉ re-index lại đúng những bài lỗi ở lượt chạy gần nhất (failedNodeIds) — dùng khi lượt
 * "Re-index toàn bộ" trước đó bị dính rate limit giữa chừng, tránh phải chạy lại từ đầu toàn bộ
 * (tốn quota Gemini cho những bài đã index thành công rồi).
 */
export async function retryFailedReindex(): Promise<{ started: boolean; total: number }> {
  const { nodes } = kbTables();
  const current = await getReindexProgress();
  if (current.status === 'running') {
    return { started: false, total: current.total };
  }
  if (!current.failedNodeIds || current.failedNodeIds.length === 0) {
    return { started: false, total: 0 };
  }

  const targets = await db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(
      and(
        inArray(nodes.id, current.failedNodeIds),
        eq(nodes.status, 'published'),
        eq(nodes.type, 'article')
      )
    );

  const progress: ReindexProgress = {
    ...IDLE_REINDEX_PROGRESS,
    status: 'running',
    total: targets.length,
    startedAt: new Date().toISOString(),
  };
  await saveReindexProgress(progress);

  runReindexSequential(targets, progress).catch((err) => {
    console.error('[Indexing] retryFailedReindex: lỗi không mong đợi', err);
  });

  return { started: true, total: targets.length };
}

async function runReindexSequential(
  targets: { id: string; name: string }[],
  progress: ReindexProgress
): Promise<void> {
  for (const node of targets) {
    progress.currentItem = node.name;
    await saveReindexProgress(progress);

    try {
      await indexNode(node.id);
      progress.success += 1;
    } catch (err) {
      console.error(`[Indexing] Re-index lỗi cho bài "${node.name}":`, err);
      progress.failed += 1;
      progress.failedNodeIds.push(node.id);
    }

    progress.processed += 1;
    await saveReindexProgress(progress);
  }

  progress.status = 'done';
  progress.currentItem = null;
  progress.finishedAt = new Date().toISOString();
  await saveReindexProgress(progress);
}

/**
 * Chunk node (bảng `nodes`, 1 tài liệu TipTap JSON — Wiki thật) theo heading + tạo embedding + lưu vào DB.
 *
 * Thứ tự cố ý: build chunk + gọi embedding TRƯỚC, chỉ xoá chunk cũ (removeFromIndex) SAU KHI toàn
 * bộ embedding đã tạo thành công — nếu embedChunks lỗi (vd hết quota Gemini) thì chunk cũ vẫn còn
 * nguyên, tránh để node tạm thời "trắng" hoàn toàn khỏi search/AI chat cho tới lần index lại kế tiếp.
 */
async function indexNode(nodeId: string): Promise<void> {
  const { nodes, contentChunks } = kbTables();
  const [item] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);

  if (!item || item.type !== 'article' || item.status !== 'published') {
    console.log(`[Indexing] Bỏ qua: node ${nodeId} không phải article đã published`);
    return;
  }

  const doc = isTiptapDoc(item.body) ? item.body : null;
  const chunks = parseDocToChunks(doc, item.name);

  if (chunks.length === 0) {
    await removeFromIndex(nodeId);
    console.log(`[Indexing] Không có chunk nào để index: node ${nodeId}`);
    return;
  }

  const chunksWithEmbeddings = await embedChunks(chunks);

  // category/subCategory suy từ tên 2 cấp folder tổ tiên đầu tiên (root-first). provider suy
  // từ folder tổ tiên GẦN NHẤT được Admin đánh dấu isProvider=true (setProviderFlag trong
  // nodes.service.ts) — không dùng danh sách provider cứng nào, hoàn toàn theo dữ liệu thực tế
  // Admin đã gắn trên cây thư mục.
  const { category, subCategory, provider } = await getAncestorMetadata(nodeId);

  await removeFromIndex(nodeId);

  await db.insert(contentChunks).values(
    chunksWithEmbeddings.map((c, index) => ({
      nodeId,
      sectionTitle: c.sectionTitle,
      headingIndex: c.headingIndex,
      chunkText: c.text,
      chunkIndex: index,
      embedding: c.embedding,
      images: c.images.length > 0 ? c.images : null,
      category,
      subCategory,
      provider,
    }))
  );

  console.log(`[Indexing] ✅ Đã index ${chunks.length} chunks cho node ${nodeId}`);
}

/**
 * Suy category/subCategory/provider từ đường dẫn folder tổ tiên của 1 node.
 * - category = tên folder tổ tiên gốc (root-first, cấp 1)
 * - subCategory = tên folder tổ tiên cấp 2
 * - provider = tên folder tổ tiên GẦN NHẤT (gần node nhất) có isProvider=true — không giới hạn
 *   cấp độ sâu, không phụ thuộc category/subCategory ở trên.
 */
async function getAncestorMetadata(nodeId: string): Promise<AncestorMetadata> {
  const { nodes } = kbTables();
  const allNodes = await db
    .select({ id: nodes.id, parentId: nodes.parentId, name: nodes.name, isProvider: nodes.isProvider })
    .from(nodes);
  return deriveAncestorMetadata(new Map(allNodes.map((n) => [n.id, n])), nodeId).metadata;
}

interface AncestorMetadata {
  category: string | null;
  subCategory: string | null;
  provider: string | null;
}

interface AncestorRow {
  parentId: string | null;
  name: string;
  isProvider: boolean;
}

/**
 * Phần thuần của getAncestorMetadata — tách ra để getStaleArticles() tính "metadata đáng ra phải
 * có" cho mọi bài từ MỘT lần đọc cây, và để hai nơi luôn dùng chung đúng một luật suy metadata.
 * `path` là chuỗi tên folder tổ tiên (root-first) để hiển thị.
 */
function deriveAncestorMetadata(
  byId: Map<string, AncestorRow>,
  nodeId: string
): { metadata: AncestorMetadata; path: string[] } {
  const chain: { name: string; isProvider: boolean }[] = [];
  let current = byId.get(nodeId);
  while (current?.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    chain.unshift({ name: parent.name, isProvider: parent.isProvider }); // root-first
    current = parent;
  }

  let provider: string | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].isProvider) {
      provider = chain[i].name;
      break;
    }
  }

  return {
    metadata: { category: chain[0]?.name ?? null, subCategory: chain[1]?.name ?? null, provider },
    path: chain.map((c) => c.name),
  };
}

// ─── Bài chưa được index đúng (Admin) ───────────────────────────────────────────
// Không lưu thêm cột "đã index lúc nào/theo gì" — so thẳng chunk đang có với thứ đáng ra phải có.
// Bắt được: chuyển bài sang folder khác, đổi tên folder, bật/tắt cờ Provider (metadata lệch), bài
// Published nhưng chưa có chunk, và lần Đăng lại bị lỗi index (chunk cũ hơn bản Đăng).
// KHÔNG bắt được: nội dung chunk lệch nhưng không kèm dấu hiệu nào ở trên (vd đổi cách chunk) —
// trường hợp đó vẫn dùng "Re-index toàn bộ".

export type StaleReason = 'no_chunks' | 'metadata' | 'title' | 'outdated';

export interface StaleArticle {
  id: string;
  name: string;
  path: string;
  reasons: StaleReason[];
}

// publishedAt lấy giờ máy chủ ứng dụng, created_at của chunk lấy giờ DB → chừa dung sai để lệch
// đồng hồ không làm bài báo lệch oan. Một lần Đăng lại lỗi index để lại chunk cũ hàng giờ/ngày.
const OUTDATED_TOLERANCE_MS = 5 * 60 * 1000;

export async function getStaleArticles(): Promise<{ total: number; stale: StaleArticle[] }> {
  const { nodes, contentChunks } = kbTables();

  const allNodes = await db
    .select({
      id: nodes.id,
      parentId: nodes.parentId,
      name: nodes.name,
      isProvider: nodes.isProvider,
      type: nodes.type,
      status: nodes.status,
      publishedAt: nodes.publishedAt,
    })
    .from(nodes);
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const published = allNodes.filter((n) => n.type === 'article' && n.status === 'published');

  const groups = await db.execute<{
    node_id: string;
    category: string | null;
    sub_category: string | null;
    provider: string | null;
    title_ok: boolean;
    last_at: Date | string;
  }>(sql`
    SELECT
      cc.node_id,
      cc.category,
      cc.sub_category,
      cc.provider,
      bool_and(starts_with(cc.chunk_text, '[Tài liệu: ' || n.name || ']')) AS title_ok,
      max(cc.created_at) AS last_at
    FROM ${contentChunks} cc
    JOIN ${nodes} n ON n.id = cc.node_id
    GROUP BY cc.node_id, cc.category, cc.sub_category, cc.provider
  `);
  const groupsByNode = new Map<string, (typeof groups.rows)[number][]>();
  for (const g of groups.rows ?? []) {
    const list = groupsByNode.get(g.node_id);
    if (list) list.push(g);
    else groupsByNode.set(g.node_id, [g]);
  }

  const stale: StaleArticle[] = [];
  for (const node of published) {
    const { metadata, path } = deriveAncestorMetadata(byId, node.id);
    const nodeGroups = groupsByNode.get(node.id) ?? [];
    const reasons: StaleReason[] = [];

    if (nodeGroups.length === 0) {
      reasons.push('no_chunks');
    } else {
      if (
        nodeGroups.some(
          (g) =>
            g.category !== metadata.category ||
            g.sub_category !== metadata.subCategory ||
            g.provider !== metadata.provider
        )
      ) {
        reasons.push('metadata');
      }
      if (nodeGroups.some((g) => !g.title_ok)) reasons.push('title');
      if (node.publishedAt) {
        const lastIndexed = Math.max(...nodeGroups.map((g) => new Date(g.last_at).getTime()));
        if (lastIndexed < node.publishedAt.getTime() - OUTDATED_TOLERANCE_MS) reasons.push('outdated');
      }
    }

    if (reasons.length > 0) {
      stale.push({ id: node.id, name: node.name, path: path.join(' / '), reasons });
    }
  }

  stale.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  return { total: published.length, stale };
}

let singleReindexRunning = false;

/**
 * Re-index đúng MỘT bài (chạy đồng bộ, trả về khi xong). Từ chối khi "Re-index toàn bộ" đang
 * chạy hoặc đang có một lượt re-index lẻ khác — mọi lượt embedding dùng chung quota Gemini nên
 * phải xếp hàng tuần tự, không chạy chồng.
 */
export async function reindexOneArticle(id: string): Promise<void> {
  const { nodes } = kbTables();
  const [item] = await db
    .select({ type: nodes.type, status: nodes.status })
    .from(nodes)
    .where(eq(nodes.id, id))
    .limit(1);
  if (!item) throw notFound('Node not found');
  if (item.type !== 'article' || item.status !== 'published') {
    throw businessRuleViolation('Only published articles can be re-indexed');
  }

  const busy = () => conflict('Another re-index run is in progress, please wait until it finishes');
  // Đặt cờ TRƯỚC mọi await để hai request đồng thời không cùng lọt qua bước kiểm tra.
  if (singleReindexRunning) throw busy();
  singleReindexRunning = true;
  try {
    if ((await getReindexProgress()).status === 'running') throw busy();
    await indexNode(id);
  } finally {
    singleReindexRunning = false;
  }
}

/**
 * Trải bảng thành text cho AI đọc, CÓ XỬ LÝ ô gộp (colspan/rowspan).
 *
 * Ô gộp chỉ tồn tại MỘT lần trong dữ liệu: ô `colspan=2` chiếm 2 cột nhưng chỉ là 1 node, và
 * ô `rowspan=2` hoàn toàn không xuất hiện ở hàng thứ hai. Nếu cứ nối các node bằng " | " như
 * trước thì hàng có ô gộp sẽ ít đoạn hơn các hàng khác → cột bị lệch, và AI đối chiếu nhầm
 * giá trị sang cột bên cạnh. Với KB mà bảng so sánh là nội dung chính (hạn mức cược theo từng
 * sảnh) thì đây là lỗi âm thầm, không ai phát hiện ngay.
 *
 * Cách xử lý: dựng lại lưới đầy đủ, LẶP LẠI nội dung ô gộp ở mọi cột/hàng mà nó phủ — giống
 * cách các công cụ xử lý bảng thường làm khi làm phẳng. Nhờ vậy mọi hàng luôn có đúng số cột.
 */
export function flattenTable(table: TiptapNodeLike): string {
  const rows = table.content || [];
  /** Ô đang phủ xuống các hàng dưới do rowspan: cột → { text, số hàng còn lại } */
  const dangPhuXuong = new Map<number, { text: string; conLai: number }>();
  const dongText: string[] = [];

  for (const row of rows) {
    const oTrongHang = row.content || [];
    const hang: string[] = [];
    let viTriO = 0;
    let cot = 0;

    // Dừng khi vừa hết ô của hàng vừa không còn ô nào phủ xuống từ hàng trên
    while (viTriO < oTrongHang.length || dangPhuXuong.size > 0) {
      const phu = dangPhuXuong.get(cot);
      if (phu) {
        hang.push(phu.text);
        phu.conLai -= 1;
        if (phu.conLai <= 0) dangPhuXuong.delete(cot);
        cot += 1;
        continue;
      }

      if (viTriO >= oTrongHang.length) break;

      const o = oTrongHang[viTriO];
      viTriO += 1;
      const text = (o.content || []).map(extractNodeText).filter(Boolean).join(' ');
      const colspan = Math.max(1, Number(o.attrs?.colspan) || 1);
      const rowspan = Math.max(1, Number(o.attrs?.rowspan) || 1);

      for (let i = 0; i < colspan; i++) {
        hang.push(text);
        if (rowspan > 1) dangPhuXuong.set(cot, { text, conLai: rowspan - 1 });
        cot += 1;
      }
    }

    dongText.push(hang.join(' | '));
  }

  return dongText.join('\n');
}

interface Chunk {
  sectionTitle: string | null;
  headingIndex: number | null;
  text: string;
  images: ChunkImage[];
}

// ─── TipTap Doc Parser (bảng `nodes` — Wiki thật) ─────────────────────────────

/** Duck-typed, khớp với frontend/src/data/docModel.ts (không import trực tiếp — 2 project riêng) */
interface TiptapNodeLike {
  type: string;
  // colspan/rowspan: ô bảng đã gộp — xem flattenTable() để biết vì sao phải quan tâm
  attrs?: { level?: number; alt?: string; src?: string; variant?: string; colspan?: number; rowspan?: number };
  content?: TiptapNodeLike[];
  text?: string;
}

interface TiptapDocLike {
  type: 'doc';
  content: TiptapNodeLike[];
}

function isTiptapDoc(value: unknown): value is TiptapDocLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** Nối text các node inline (text/hardBreak) — dùng cho heading/paragraph/table cell... */
function extractInlineText(node: TiptapNodeLike): string {
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content || []).map(extractInlineText).join('');
}

/**
 * Gom ảnh trong một node top-level, kể cả ảnh lồng trong danh sách / callout / ô bảng. Chỉ nhận
 * URL https — `src` đến từ nội dung Admin soạn nhưng sẽ được frontend đưa thẳng vào `<img>`.
 */
function collectImages(node: TiptapNodeLike, out: ChunkImage[]): void {
  if (node.type === 'image') {
    const src = node.attrs?.src;
    if (typeof src === 'string' && src.startsWith('https://') && !out.some((i) => i.src === src)) {
      out.push(node.attrs?.alt ? { src, alt: node.attrs.alt } : { src });
    }
    return;
  }
  node.content?.forEach((child) => collectImages(child, out));
}

/**
 * Chunk 1 tài liệu TipTap (doc phẳng, không lồng như BlockNode cũ) theo heading — mỗi heading
 * (H1/H2/H3, không phân biệt cấp) mở ra 1 section/chunk mới, gồm mọi nội dung sau nó cho tới
 * heading tiếp theo. horizontalRule = ranh giới chunk cưỡng bức trong cùng 1 section (giống
 * "divider" của mô hình cũ), không tự mở section mới.
 */
function parseDocToChunks(doc: TiptapDocLike | null, articleTitle: string): Chunk[] {
  const titlePrefix = `[Tài liệu: ${articleTitle}]`;
  const chunks: Chunk[] = [];
  const topLevelNodes = doc?.content || [];

  let sectionTitle: string | null = null;
  // Đếm heading theo đúng thứ tự xuất hiện — khớp với extractTocFromDoc/HeadingAnchor phía
  // frontend (frontend/src/data/docModel.ts, frontend/src/extensions/HeadingAnchor.ts) để id neo
  // "heading-N" trỏ đúng vị trí. headingIndex null nếu section nằm trước heading đầu tiên.
  let headingCounter = 0;
  let currentHeadingIndex: number | null = null;
  let parts: string[] = [];
  let images: ChunkImage[] = [];

  function flushSection() {
    const text = parts.map((p) => p.trim()).filter(Boolean).join('\n');
    const sectionImages = images;
    parts = [];
    images = [];
    // Section chỉ có ảnh (không chữ) vẫn thành chunk: nếu bỏ, ảnh biến mất khỏi AI chat.
    if (!text && sectionImages.length === 0) return;
    const fullText = `${titlePrefix} ${sectionTitle ? `[Phần: ${sectionTitle}] ` : ''}${text}`.trimEnd();
    chunks.push({ sectionTitle, headingIndex: currentHeadingIndex, text: fullText, images: sectionImages });
  }

  for (const node of topLevelNodes) {
    if (node.type === 'heading') {
      flushSection();
      sectionTitle = extractInlineText(node).trim() || sectionTitle;
      currentHeadingIndex = headingCounter;
      headingCounter += 1;
      continue;
    }
    if (node.type === 'horizontalRule') {
      flushSection();
      continue;
    }
    const text = extractNodeText(node);
    if (text) parts.push(text);
    collectImages(node, images);
  }
  flushSection();

  if (chunks.length === 0) {
    chunks.push({ sectionTitle: articleTitle, headingIndex: null, text: `${titlePrefix} ${articleTitle}`, images: [] });
  }

  return chunks;
}

function extractNodeText(node: TiptapNodeLike): string {
  switch (node.type) {
    case 'paragraph':
      return extractInlineText(node);
    case 'blockquote':
    case 'callout':
      // Nội dung chứa (block+) → gom text từng dòng con
      return (node.content || []).map(extractNodeText).filter(Boolean).join('\n');
    case 'bulletList':
    case 'orderedList':
      return (node.content || [])
        .map((item) => `- ${(item.content || []).map(extractNodeText).filter(Boolean).join(' ')}`)
        .join('\n');
    case 'image': {
      const alt = node.attrs?.alt;
      return alt ? `[Hình ảnh: ${alt}]` : '';
    }
    case 'table':
      return flattenTable(node);
    case 'horizontalRule':
      return '';
    default:
      // Node lạ/không xác định: vẫn cố gom text con (nếu có) thay vì bỏ qua hoàn toàn
      return node.content ? node.content.map(extractNodeText).filter(Boolean).join(' ') : extractInlineText(node);
  }
}

// ─── Embedding ────────────────────────────────────────────────────────────────

interface ChunkWithEmbedding extends Chunk {
  embedding: number[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Gọi embedding cho 1 chunk, retry + backoff khi dính rate limit (429/RESOURCE_EXHAUSTED).
 *
 * THỨ TỰ QUAN TRỌNG: embedText() đã thử hết mọi key Gemini rồi mới ném lỗi quota ra đây, nên khi
 * tới nhánh chờ 65s thì chắc chắn KHÔNG còn key nào còn quota. Đừng đảo lại thành "chờ 65s trước,
 * đổi key sau" — như vậy là ngồi chờ vô ích trong khi key dự phòng vẫn dùng được.
 */
async function embedOneWithRetry(text: string, maxRetries = 5): Promise<number[]> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await embedText(text);
    } catch (err) {
      const is429 = isQuotaError(err);
      if (is429 && attempt < maxRetries) {
        console.log(
          `[Indexing] Mọi key Gemini đều hết quota — chờ 65s rồi thử lại embedding (lần ${attempt}/${maxRetries})`,
        );
        await sleep(65_000);
        continue;
      }
      if (is429) {
        console.log('Indexing - Đã hết quota');
      }
      throw err;
    }
  }
  throw new Error('embedOneWithRetry: exceeded the maximum number of retries');
}

/**
 * Gọi Gemini text-embedding-004 để tạo embedding cho từng chunk.
 * Batch theo nhóm 10 để tránh rate limit; mỗi request lẻ tự retry khi dính 429 (free tier Gemini
 * giới hạn 100 request/phút — dễ vượt khi re-index nhiều bài liên tiếp).
 */
async function embedChunks(chunks: Chunk[]): Promise<ChunkWithEmbedding[]> {
  const BATCH_SIZE = 10;
  const result: ChunkWithEmbedding[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    const embeddings = await Promise.all(batch.map((chunk) => embedOneWithRetry(chunk.text)));

    result.push(
      ...batch.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx],
      }))
    );

    if (i + BATCH_SIZE < chunks.length) {
      await sleep(500);
    }
  }

  return result;
}
