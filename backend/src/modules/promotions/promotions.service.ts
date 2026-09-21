import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { appSettings, auditLogs, type Promotion } from '../../db/schema';
import { currentKb, kbTables } from '../kb/kb.context';
import type { AuthUser } from '../../middleware/auth';
import { notFound, businessRuleViolation } from '../../lib/AppError';
import { publishNode } from '../nodes/nodes.service';
import {
  buildPromotionDoc,
  detectProvider,
  extractStartDate,
  extractSummary,
  extractTimeText,
  hashContent,
  mirrorNodeName,
  normalizeTitleKey,
  startMonthOf,
  versionLabel,
} from './promotionContent.util';

/**
 * Khuyến mãi — nguồn sự thật nằm ở bảng `promotions`/`promotion_versions`, còn cây `nodes` chỉ
 * giữ một BẢN SAO MỘT CHIỀU của phiên bản mới nhất để AI Chat/Search dùng chung pipeline cũ.
 *
 * Vì sao phải mirror thay vì cho `content_chunks` trỏ thẳng vào bảng khuyến mãi: cả hai nhánh
 * của `search()` đều `JOIN nodes n ON n.id = cc.node_id` (INNER JOIN) rồi lọc
 * `n.status = 'published'`. Chunk không gắn node sẽ vô hình với tìm kiếm, muốn bỏ mirror thì
 * phải sửa 2 câu SQL lõi + logic RRF + đường link trích dẫn — đổi lấy việc tiết kiệm một bản
 * sao dữ liệu, không đáng.
 */

const ROOT_FOLDER = 'Khuyến mãi';
const PROGRESS_KEY = 'promotion_import_progress';
/** Nhóm cho khuyến mãi không ghi thời hạn (toàn bộ nhóm Hoàn trả rơi vào đây). */
export const KHONG_HAN = 'khong-han';

// ─── Kiểu dữ liệu ─────────────────────────────────────────────────────────────────────────────

/** Một bản ghi trong file nguồn (promotions-unique.json). */
export interface ImportItem {
  title: string;
  sourceCategory?: string;
  content: string;
}

export interface DiffEntry {
  title: string;
  provider: string | null;
  versionLabel: string;
  reason?: string;
}

export interface ImportDiff {
  total: number;
  created: DiffEntry[];
  versioned: DiffEntry[];
  unchangedCount: number;
  invalid: { title: string; reason: string }[];
}

export interface ImportProgress {
  status: 'idle' | 'running' | 'done';
  total: number;
  processed: number;
  success: number;
  failed: number;
  failedTitles: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

const PROGRESS_RONG: ImportProgress = {
  status: 'idle',
  total: 0,
  processed: 0,
  success: 0,
  failed: 0,
  failedTitles: [],
  startedAt: null,
  finishedAt: null,
};

// ─── Đọc & chuẩn hoá file nguồn ───────────────────────────────────────────────────────────────

/**
 * Chấp nhận cả 2 hình dạng đã gặp trong thư mục dữ liệu: object bọc ngoài có khoá `promotions`
 * (promotions-unique.json) và mảng trần (promotions.json của từng lượt thu thập).
 */
export function parseImportPayload(raw: unknown): ImportItem[] {
  const mang = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { promotions?: unknown })?.promotions)
      ? ((raw as { promotions: unknown[] }).promotions)
      : null;

  if (!mang) {
    throw businessRuleViolation(
      'File không đúng định dạng: cần một mảng khuyến mãi hoặc object có khoá "promotions".'
    );
  }

  return mang.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      title: String(o.title ?? '').trim(),
      sourceCategory: o.sourceCategory ? String(o.sourceCategory).trim() : undefined,
      content: String(o.content ?? ''),
    };
  });
}

interface DaChuanHoa {
  item: ImportItem;
  titleKey: string;
  category: string;
  provider: string | null;
  timeText: string | null;
  startDate: string | null;
  hash: string;
  label: string;
  summary: string;
}

function chuanHoa(item: ImportItem, importedAt: Date): DaChuanHoa | null {
  if (!item.title || !item.content.trim()) return null;
  const category = item.sourceCategory || 'Khác';
  const timeText = extractTimeText(item.content);
  const startDate = extractStartDate(timeText);
  return {
    item,
    titleKey: normalizeTitleKey(item.title),
    category,
    provider: detectProvider(item.title, category),
    timeText,
    startDate,
    hash: hashContent(item.content, timeText),
    label: versionLabel(startDate, importedAt),
    summary: extractSummary(item.content, item.title),
  };
}

// ─── Đối chiếu (preview) ──────────────────────────────────────────────────────────────────────

/**
 * So file mới với dữ liệu đang có, KHÔNG ghi gì. Trùng `content_hash` thì bỏ qua hoàn toàn —
 * đây là chỗ giữ chi phí đợt nhập hàng tuần ở mức thấp: không ghi lại, không tính embedding lại.
 */
export async function previewImport(items: ImportItem[]): Promise<ImportDiff> {
  const { promotions, promotionVersions } = kbTables();
  const now = new Date();
  const diff: ImportDiff = { total: items.length, created: [], versioned: [], unchangedCount: 0, invalid: [] };
  const daGap = new Set<string>();

  for (const item of items) {
    const c = chuanHoa(item, now);
    if (!c) {
      diff.invalid.push({ title: item.title || '(không có tên)', reason: 'Thiếu tên hoặc nội dung' });
      continue;
    }
    // File nguồn vẫn có thể lặp bản ghi — chỉ tính lần đầu để số liệu preview khớp với số dòng
    // thực sự được ghi ở bước commit.
    if (daGap.has(c.titleKey)) {
      diff.unchangedCount += 1;
      continue;
    }
    daGap.add(c.titleKey);

    const [hienCo] = await db.select().from(promotions).where(eq(promotions.titleKey, c.titleKey)).limit(1);
    if (!hienCo) {
      diff.created.push({ title: item.title, provider: c.provider, versionLabel: c.label });
      continue;
    }

    const [trungHash] = await db
      .select({ id: promotionVersions.id })
      .from(promotionVersions)
      .where(and(eq(promotionVersions.promotionId, hienCo.id), eq(promotionVersions.contentHash, c.hash)))
      .limit(1);

    if (trungHash) {
      diff.unchangedCount += 1;
      continue;
    }
    diff.versioned.push({
      title: item.title,
      provider: hienCo.providerLocked ? hienCo.provider : c.provider,
      versionLabel: c.label,
      reason: 'Nội dung hoặc thời hạn đã thay đổi',
    });
  }

  return diff;
}

// ─── Ghi dữ liệu (commit) ─────────────────────────────────────────────────────────────────────

/**
 * Ghi phần thay đổi vào DB rồi đẩy việc mirror + index chạy NỀN.
 *
 * Tách 2 pha vì mirror phải gọi embedding cho từng bài, chạy TUẦN TỰ để không vượt quota Gemini
 * (giống `startPublishAll`/`startReindexAll`); nếu làm hết trong 1 request HTTP thì lần nhập đầu
 * (42 bài ≈ 124 chunk) chắc chắn timeout. Phần ghi DB thì nhanh nên làm ngay, để người dùng thấy
 * dữ liệu xuất hiện trên trang lập tức, còn AI dùng được sau khi index xong.
 */
export async function commitImport(
  items: ImportItem[],
  sourceFile: string | null,
  actor: AuthUser,
  // `awaitMirror` chỉ dùng cho script nạp lần đầu (chạy xong rồi mới được thoát process).
  // Đường HTTP luôn để mặc định false, nếu không request sẽ treo tới lúc timeout.
  opts?: { awaitMirror?: boolean }
): Promise<ImportDiff> {
  const { promotions, promotionVersions } = kbTables();
  const dangChay = await getImportProgress();
  if (dangChay.status === 'running') {
    throw businessRuleViolation('Đang có một lượt nhập dữ liệu chạy dở, vui lòng đợi lượt đó xong.');
  }

  const now = new Date();
  const diff: ImportDiff = { total: items.length, created: [], versioned: [], unchangedCount: 0, invalid: [] };
  const canMirror: string[] = []; // id các promotion cần dựng lại bài mirror
  const daGap = new Set<string>();

  for (const item of items) {
    const c = chuanHoa(item, now);
    if (!c) {
      diff.invalid.push({ title: item.title || '(không có tên)', reason: 'Thiếu tên hoặc nội dung' });
      continue;
    }
    if (daGap.has(c.titleKey)) {
      diff.unchangedCount += 1;
      continue;
    }
    daGap.add(c.titleKey);

    const [hienCo] = await db.select().from(promotions).where(eq(promotions.titleKey, c.titleKey)).limit(1);

    if (!hienCo) {
      const [moi] = await db
        .insert(promotions)
        .values({
          titleKey: c.titleKey,
          title: item.title,
          category: c.category,
          provider: c.provider,
          startMonth: startMonthOf(c.startDate),
        })
        .returning();
      const verId = await themVersion(moi.id, c, sourceFile, now);
      await db.update(promotions).set({ latestVersionId: verId, updatedAt: now }).where(eq(promotions.id, moi.id));
      diff.created.push({ title: item.title, provider: c.provider, versionLabel: c.label });
      canMirror.push(moi.id);
      continue;
    }

    const [trungHash] = await db
      .select({ id: promotionVersions.id })
      .from(promotionVersions)
      .where(and(eq(promotionVersions.promotionId, hienCo.id), eq(promotionVersions.contentHash, c.hash)))
      .limit(1);

    if (trungHash) {
      diff.unchangedCount += 1;
      continue;
    }

    const verId = await themVersion(hienCo.id, c, sourceFile, now);
    await db
      .update(promotions)
      .set({
        title: item.title,
        category: c.category,
        // Admin đã sửa tay thì giữ nguyên, không để kết quả tự đoán ghi đè.
        provider: hienCo.providerLocked ? hienCo.provider : c.provider,
        startMonth: startMonthOf(c.startDate),
        latestVersionId: verId,
        updatedAt: now,
      })
      .where(eq(promotions.id, hienCo.id));

    diff.versioned.push({ title: item.title, provider: c.provider, versionLabel: c.label });
    canMirror.push(hienCo.id);
  }

  await db.insert(auditLogs).values({
    action: 'promotion_import',
    actorId: actor.id,
    actorEmail: actor.email,
    targetType: 'promotion',
    kbCode: currentKb().code,
    meta: {
      sourceFile,
      total: diff.total,
      created: diff.created.length,
      versioned: diff.versioned.length,
      unchanged: diff.unchangedCount,
    },
  });

  const mirror = chayMirrorNen(canMirror, actor);
  if (opts?.awaitMirror) await mirror;
  else void mirror;

  return diff;
}

async function themVersion(
  promotionId: string,
  c: DaChuanHoa,
  sourceFile: string | null,
  importedAt: Date
): Promise<string> {
  const { promotionVersions } = kbTables();
  const [ver] = await db
    .insert(promotionVersions)
    .values({
      promotionId,
      versionLabel: c.label,
      startDate: c.startDate,
      timeText: c.timeText,
      summary: c.summary,
      content: c.item.content,
      contentHash: c.hash,
      sourceFile,
      importedAt,
    })
    .returning({ id: promotionVersions.id });
  return ver.id;
}

// ─── Mirror sang cây nodes (chạy nền, tuần tự) ────────────────────────────────────────────────

export async function getImportProgress(): Promise<ImportProgress> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, PROGRESS_KEY)).limit(1);
  if (!row) return PROGRESS_RONG;
  try {
    return JSON.parse(row.value) as ImportProgress;
  } catch {
    return PROGRESS_RONG;
  }
}

async function luuProgress(p: ImportProgress): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: PROGRESS_KEY, value: JSON.stringify(p), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: JSON.stringify(p), updatedAt: new Date() },
    });
}

async function chayMirrorNen(ids: string[], actor: AuthUser): Promise<void> {
  const { promotions } = kbTables();
  if (!ids.length) return;
  const p: ImportProgress = {
    status: 'running',
    total: ids.length,
    processed: 0,
    success: 0,
    failed: 0,
    failedTitles: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  await luuProgress(p);

  // TUẦN TỰ, không Promise.all: mỗi bài kéo theo một loạt lệnh gọi embedding Gemini, chạy song
  // song là vượt quota free tier ngay.
  for (const id of ids) {
    try {
      await mirrorPromotion(id, actor);
      p.success += 1;
    } catch (err) {
      p.failed += 1;
      const [pr] = await db.select({ title: promotions.title }).from(promotions).where(eq(promotions.id, id)).limit(1);
      p.failedTitles.push(pr?.title ?? id);
      console.error('[Promotions] Lỗi mirror khuyến mãi', id, err);
    }
    p.processed += 1;
    await luuProgress(p);
  }

  p.status = 'done';
  p.finishedAt = new Date().toISOString();
  await luuProgress(p);
}

/**
 * Sảnh của khuyến mãi có trùng tên với một Folder đã được Admin đánh dấu Provider trên cây
 * tài liệu hay không.
 *
 * Dùng để quyết định có tạo thêm một cấp folder Provider trong nhánh Khuyến mãi không — xem
 * giải thích ở `mirrorPromotion`. CHỈ chấp nhận tên đã tồn tại sẵn: tạo folder Provider mang
 * tên MỚI sẽ thêm tên đó vào danh sách nhận diện sảnh của TOÀN hệ thống
 * (`detectProviderFromFolders` quét mọi folder có cờ này), kéo theo thay đổi cách xếp hạng của
 * cả những câu hỏi không liên quan gì tới khuyến mãi.
 */
async function laProviderDaCo(provider: string | null): Promise<boolean> {
  const { nodes } = kbTables();
  if (!provider) return false;
  const [co] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.name, provider), eq(nodes.type, 'folder'), eq(nodes.isProvider, true)))
    .limit(1);
  return !!co;
}

/** Tìm hoặc tạo folder theo tên trong một thư mục cha. */
async function timHoacTaoFolder(
  name: string,
  parentId: string | null,
  createdBy: string,
  isProvider = false
): Promise<string> {
  const { nodes } = kbTables();
  const [co] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.name, name),
        eq(nodes.type, 'folder'),
        parentId ? eq(nodes.parentId, parentId) : isNull(nodes.parentId)
      )
    )
    .limit(1);
  if (co) return co.id;

  const [moi] = await db
    .insert(nodes)
    .values({ name, type: 'folder', parentId, status: 'draft', createdBy, sortOrder: 99, isProvider })
    .returning({ id: nodes.id });
  return moi.id;
}

/**
 * Dựng lại bài mirror cho MỘT khuyến mãi (chỉ phiên bản mới nhất) rồi Đăng để index chạy.
 *
 * Cố ý gọi thẳng `publishNode` thay vì `updateNode`: `updateNode` tính lại status, thấy body
 * khác bản Đăng thì rơi về draft và GỠ bài khỏi index ngay, sau đó mới đăng lại — bài sẽ biến
 * mất khỏi tìm kiếm trong lúc chờ embedding. Ghi thẳng rồi publish thì không có khoảng trống đó.
 */
export async function mirrorPromotion(promotionId: string, actor: AuthUser): Promise<void> {
  const { nodes, promotions, promotionVersions } = kbTables();
  const [pr] = await db.select().from(promotions).where(eq(promotions.id, promotionId)).limit(1);
  if (!pr) throw notFound('Khuyến mãi không tồn tại');
  if (!pr.latestVersionId) throw businessRuleViolation('Khuyến mãi chưa có phiên bản nào');

  const [ver] = await db
    .select()
    .from(promotionVersions)
    .where(eq(promotionVersions.id, pr.latestVersionId))
    .limit(1);
  if (!ver) throw notFound('Không tìm thấy phiên bản mới nhất');

  const rootId = await timHoacTaoFolder(ROOT_FOLDER, null, actor.id);
  let folderId = await timHoacTaoFolder(pr.category, rootId, actor.id);

  // Thêm một cấp folder Provider khi sảnh của khuyến mãi trùng tên với một sảnh ĐÃ CÓ trên cây
  // tài liệu.
  //
  // Vì sao cần: `vectorSearch` xếp hạng bằng `ORDER BY CASE WHEN cc.provider = <sảnh detect
  // được> THEN 0 ... ELSE 2 END, khoảng_cách` — tức là sảnh khớp được xếp HẲN LÊN TRƯỚC chứ
  // không phải cộng thêm điểm. Đo thực tế với câu "V8 Poker hoàn trả bao nhiêu?": 3 chunk của
  // bài khuyến mãi có độ tương đồng cao nhất toàn KB (0.844 / 0.795 / 0.770) nhưng vì
  // `provider` để trống nên bị đẩy xuống dưới toàn bộ chunk luật chơi V8 (0.68-0.74) và không
  // lọt vào 5 chunk gửi cho AI — AI trả lời "không tìm thấy" dù KB có đúng bài đó.
  //
  // Chỉ áp dụng với tên sảnh đã tồn tại, xem `laProviderDaCo`.
  if (await laProviderDaCo(pr.provider)) {
    folderId = await timHoacTaoFolder(pr.provider as string, folderId, actor.id, true);
  }

  const name = mirrorNodeName(pr.title, pr.provider);
  const body = buildPromotionDoc({
    title: pr.title,
    category: pr.category,
    provider: pr.provider,
    timeText: ver.timeText,
    content: ver.content,
    versionLabel: ver.versionLabel,
  });

  let nodeId = pr.nodeId;
  if (nodeId) {
    const [conSong] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!conSong) nodeId = null;
  }

  if (nodeId) {
    await db
      .update(nodes)
      .set({ name, body, parentId: folderId, hasBeenSaved: true, updatedAt: new Date() })
      .where(eq(nodes.id, nodeId));
  } else {
    const [moi] = await db
      .insert(nodes)
      .values({
        name,
        type: 'article',
        parentId: folderId,
        status: 'draft',
        body,
        hasBeenSaved: true,
        createdBy: actor.id,
        sortOrder: 0,
      })
      .returning({ id: nodes.id });
    nodeId = moi.id;
    await db.update(promotions).set({ nodeId, updatedAt: new Date() }).where(eq(promotions.id, pr.id));
  }

  // awaitIndexing: phải chờ embedding xong mới sang bài kế tiếp, nếu không việc "chạy tuần tự"
  // chỉ còn trên danh nghĩa.
  await publishNode(nodeId, actor, { awaitIndexing: true });
}

// ─── Truy vấn cho trang Khuyến mãi ────────────────────────────────────────────────────────────

export interface MonthSummary {
  key: string;
  nam: string;
  thang: string;
  soLuong: number;
}

export async function listMonths(): Promise<{ months: MonthSummary[]; khongHan: number; tong: number; tongVersion: number }> {
  const { promotions, promotionVersions } = kbTables();
  const rows = await db
    .select({ key: promotions.startMonth, soLuong: sql<number>`count(*)::int` })
    .from(promotions)
    .groupBy(promotions.startMonth);

  const months = rows
    .filter((r) => r.key !== KHONG_HAN)
    .map((r) => ({ key: r.key, nam: r.key.slice(0, 4), thang: r.key.slice(5), soLuong: Number(r.soLuong) }))
    .sort((a, b) => b.key.localeCompare(a.key));

  const [{ tongVersion }] = await db
    .select({ tongVersion: sql<number>`count(*)::int` })
    .from(promotionVersions);

  return {
    months,
    khongHan: Number(rows.find((r) => r.key === KHONG_HAN)?.soLuong ?? 0),
    tong: rows.reduce((s, r) => s + Number(r.soLuong), 0),
    tongVersion: Number(tongVersion),
  };
}

export interface VersionChip {
  id: string;
  versionLabel: string;
  startDate: string | null;
}

export interface PromotionListItem {
  id: string;
  title: string;
  category: string;
  provider: string | null;
  providerLocked: boolean;
  startMonth: string;
  startDate: string | null;
  timeText: string | null;
  summary: string | null;
  versionLabel: string;
  versionCount: number;
  // Danh sách phiên bản rút gọn, MỚI NHẤT ĐỨNG ĐẦU — đủ để thẻ ngoài danh sách hiện dãy nhãn
  // "ver 11.09.26 / ver 14.08.26" và bấm thẳng vào một bản cũ, không phải mở chi tiết rồi mới
  // chọn được. Chỉ 3 cột nên không làm nặng truy vấn danh sách.
  versions: VersionChip[];
  nodeId: string | null;
}

/**
 * Danh sách khuyến mãi của MỘT tháng. Trang chỉ nạp sẵn 2 tháng gần nhất, tháng cũ hơn gọi lại
 * hàm này khi người dùng bấm — để mở trang không phải kéo toàn bộ lịch sử về.
 */
export async function listByMonth(month: string): Promise<PromotionListItem[]> {
  const { promotions, promotionVersions } = kbTables();
  const rows = await db
    .select({
      p: promotions,
      v: promotionVersions,
      versionCount: sql<number>`(select count(*)::int from ${promotionVersions} pv where pv.promotion_id = ${promotions.id})`,
      versions: sql<VersionChip[]>`(
        select coalesce(json_agg(json_build_object('id', pv.id, 'versionLabel', pv.version_label, 'startDate', pv.start_date)
               order by pv.imported_at desc), '[]'::json)
        from ${promotionVersions} pv where pv.promotion_id = ${promotions.id}
      )`,
    })
    .from(promotions)
    .leftJoin(promotionVersions, eq(promotionVersions.id, promotions.latestVersionId))
    .where(eq(promotions.startMonth, month));

  return rows
    .map(({ p, v, versionCount, versions }) => ({
      id: p.id,
      title: p.title,
      category: p.category,
      provider: p.provider,
      providerLocked: p.providerLocked,
      startMonth: p.startMonth,
      startDate: v?.startDate ?? null,
      timeText: v?.timeText ?? null,
      summary: v?.summary ?? null,
      versionLabel: v?.versionLabel ?? '—',
      versionCount: Number(versionCount),
      versions: versions ?? [],
      nodeId: p.nodeId,
    }))
    .sort((a, b) => String(b.startDate ?? '').localeCompare(String(a.startDate ?? '')) || a.title.localeCompare(b.title, 'vi'));
}

export interface VersionSummary {
  id: string;
  versionLabel: string;
  startDate: string | null;
  timeText: string | null;
  importedAt: string;
  isLatest: boolean;
}

export interface PromotionDetail extends PromotionListItem {
  content: string;
  versions: VersionSummary[];
}

export async function getPromotionDetail(id: string, versionId?: string): Promise<PromotionDetail> {
  const { promotions, promotionVersions } = kbTables();
  const [p] = await db.select().from(promotions).where(eq(promotions.id, id)).limit(1);
  if (!p) throw notFound('Khuyến mãi không tồn tại');

  // Sắp theo THỜI ĐIỂM NHẬP chứ không theo ngày bắt đầu: bản nhập gần nhất mới là bản đang
  // hiển thị trên web M88, kể cả khi nó có ngày bắt đầu cũ hơn bản trước.
  const vers = await db
    .select()
    .from(promotionVersions)
    .where(eq(promotionVersions.promotionId, id))
    .orderBy(desc(promotionVersions.importedAt));

  if (!vers.length) throw notFound('Khuyến mãi chưa có phiên bản nào');
  const chon = versionId ? vers.find((v) => v.id === versionId) : vers[0];
  if (!chon) throw notFound('Phiên bản không tồn tại');

  return {
    id: p.id,
    title: p.title,
    category: p.category,
    provider: p.provider,
    providerLocked: p.providerLocked,
    startMonth: p.startMonth,
    startDate: chon.startDate,
    timeText: chon.timeText,
    summary: chon.summary,
    versionLabel: chon.versionLabel,
    versionCount: vers.length,
    nodeId: p.nodeId,
    content: chon.content,
    versions: vers.map((v) => ({
      id: v.id,
      versionLabel: v.versionLabel,
      startDate: v.startDate,
      timeText: v.timeText,
      importedAt: v.importedAt.toISOString(),
      isLatest: v.id === vers[0].id,
    })),
  };
}

/**
 * Admin sửa sảnh áp dụng. Sửa xong phải dựng lại bài mirror vì tên sảnh nằm trong TÊN BÀI và
 * trong đoạn mở đầu — tức là nằm trong chunk gửi cho AI.
 */
export async function updateProvider(id: string, provider: string | null, actor: AuthUser): Promise<Promotion> {
  const { promotions } = kbTables();
  const [p] = await db.select().from(promotions).where(eq(promotions.id, id)).limit(1);
  if (!p) throw notFound('Khuyến mãi không tồn tại');

  const giaTri = provider?.trim() ? provider.trim() : null;
  const [updated] = await db
    .update(promotions)
    .set({ provider: giaTri, providerLocked: true, updatedAt: new Date() })
    .where(eq(promotions.id, id))
    .returning();

  await db.insert(auditLogs).values({
    action: 'promotion_provider_edit',
    actorId: actor.id,
    actorEmail: actor.email,
    targetId: id,
    targetType: 'promotion',
    kbCode: currentKb().code,
    meta: { title: p.title, from: p.provider, to: giaTri },
  });

  // Fire-and-forget: đổi sảnh không cần chặn người dùng chờ embedding chạy xong.
  void mirrorPromotion(id, actor).catch((err) =>
    console.error('[Promotions] Lỗi mirror sau khi đổi sảnh:', err)
  );

  return updated;
}
