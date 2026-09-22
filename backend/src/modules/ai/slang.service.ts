/**
 * Slang Normalization Service
 * Bước tiền xử lý câu hỏi AI: chuẩn hóa từ lóng → thuật ngữ chuẩn
 * và phát hiện độ mơ hồ (Ambiguity Detection) khi thiếu Provider/Category
 *
 * [SECURITY] Chỉ đọc DB — không modify data từ user input
 */

import { db } from '../../db';
import { kbTables } from '../kb/kb.context';
import { eq, and, ilike, isNotNull } from 'drizzle-orm';

/**
 * Danh sách từ lóng nằm HOÀN TOÀN trong bảng `slang_dictionary`, không còn hằng số nào trong code.
 *
 * Trước đây có hai mảng KNOWN_CATEGORIES và KNOWN_BET_TYPES hardcode ở đây. Chúng gây hai vấn đề:
 *
 * 1. Muốn thêm/sửa một từ lóng phải nhờ lập trình viên và deploy lại, dù đã có sẵn giao diện
 *    quản trị ở /admin/slang.
 * 2. Nguy hiểm hơn: chúng chứa các alias MỘT ÂM TIẾT ('tài', 'chấp', 'rung', 'xiên', 'live')
 *    trùng với từ tiếng Việt thông dụng. Vì bước này thay chữ THẲNG vào câu hỏi trước khi tạo
 *    embedding, "tài khoản ngân hàng" bị biến thành "Over/Under khoản ngân hàng" — câu hỏi hỏng,
 *    retrieval lấy nhầm tài liệu thể thao, và model trả lời "không tìm thấy" dù KB có bài đúng.
 *    Đo thực tế: 9/12 câu thử bị phá, riêng cụm "tài khoản" có mặt trong 66 chunk / 33 bài viết.
 *
 * Dữ liệu khởi tạo nạp bằng `scripts/seed_slang_dictionary.ts`. Khi thêm alias mới qua UI, tránh
 * từ đơn âm tiết trừ khi chắc chắn nó không xuất hiện trong tiếng Việt thông thường.
 */

export interface NormalizedQuery {
  original: string;
  normalized: string;           // Câu hỏi sau khi thay thế từ lóng
  detectedProvider?: string;    // Provider detect được nếu có
  detectedCategory?: string;    // Category detect được nếu có
  detectedBetType?: string;     // Bet type detect được nếu có
  slangReplacements: Array<{ from: string; to: string }>; // Log những gì đã replace
}

export interface ClarificationNeeded {
  needed: boolean;
  topic?: string;               // Chủ đề mơ hồ VD: "Luật đặc biệt"
  matchedProviders?: string[];  // Danh sách provider có nội dung liên quan
}

/**
 * Bước 1a: Chuẩn hoá câu hỏi bằng bảng `slang_dictionary`.
 *
 * DB lỗi thì bỏ qua toàn bộ bước này và giữ nguyên câu hỏi gốc — chuẩn hoá là bước tăng cường,
 * không được phép làm chết luồng chat. Câu hỏi chưa chuẩn hoá vẫn tìm được tài liệu qua vector.
 */
export async function normalizeQuery(rawQuery: string): Promise<NormalizedQuery> {
  const { slangDictionary } = kbTables();
  let normalized = rawQuery;
  const slangReplacements: Array<{ from: string; to: string }> = [];

  let entries: Array<{ slangTerm: string; normalizedEntity: string; targetType: string }> = [];
  try {
    entries = await db
      .select({
        slangTerm: slangDictionary.slangTerm,
        normalizedEntity: slangDictionary.normalizedEntity,
        targetType: slangDictionary.targetType,
      })
      .from(slangDictionary)
      .where(eq(slangDictionary.isActive, true));
  } catch {
    // Không đọc được từ điển → giữ nguyên câu hỏi, các bước sau vẫn chạy bình thường
    return { original: rawQuery, normalized: rawQuery, slangReplacements: [] };
  }

  // Thay cụm DÀI trước cụm NGẮN. Nếu không sắp xếp, một alias ngắn có thể ăn mất phần đầu của
  // cụm dài hơn (vd 'tài xỉu' bị cắt còn 'xỉu' nếu 'tài' được xử lý trước), làm cụm dài không
  // bao giờ khớp được nữa.
  const sorted = [...entries].sort((a, b) => b.slangTerm.length - a.slangTerm.length);

  // ── Thay thế chữ trong câu hỏi ──────────────────────────────────────────
  // CHỈ nhóm không phải 'category': alias danh mục ('casino', 'slot'...) chỉ dùng để ưu tiên xếp
  // hạng, thay chúng vào câu hỏi sẽ làm méo câu mà không được lợi gì.
  for (const entry of sorted) {
    if (entry.targetType === 'category') continue;

    const regex = new RegExp(`\\b${escapeRegex(entry.slangTerm)}\\b`, 'gi');
    if (regex.test(normalized)) {
      normalized = normalized.replace(regex, entry.normalizedEntity);
      slangReplacements.push({ from: entry.slangTerm, to: entry.normalizedEntity });
    }
  }

  const lowerNormalized = normalized.toLowerCase();
  const lowerOriginal = rawQuery.toLowerCase();

  // Detect Provider — theo đúng danh sách Folder Admin đã đánh dấu isProvider=true trên cây
  // thư mục thực tế (setProviderFlag), không còn danh sách cứng nào trong code.
  const detectedProvider = await detectProviderFromFolders(lowerNormalized);

  // Detect Category — dò trên CẢ câu gốc lẫn câu đã thay, vì alias danh mục cố ý không được
  // thay vào câu nên chỉ còn tồn tại ở bản gốc.
  const detectedCategory = sorted.find(
    (e) =>
      e.targetType === 'category' &&
      (lowerNormalized.includes(e.slangTerm.toLowerCase()) ||
        lowerOriginal.includes(e.slangTerm.toLowerCase())),
  )?.normalizedEntity;

  // Detect Bet Type — suy ra từ chính những gì vừa thay thế được
  const detectedBetType = sorted.find(
    (e) => e.targetType === 'bet_type' && slangReplacements.some((r) => r.to === e.normalizedEntity),
  )?.normalizedEntity;

  return {
    original: rawQuery,
    normalized,
    detectedProvider,
    detectedCategory,
    detectedBetType,
    slangReplacements,
  };
}

/**
 * Bước 1b: Phát hiện mơ hồ (Ambiguity Detection)
 * Kiểm tra: nếu thiếu Provider nhưng topic xuất hiện ở nhiều Provider khác nhau (theo dữ liệu
 * thật content_chunks/nodes — hệ content cũ đã bị xóa hoàn toàn) → trả về clarification cần
 * hỏi lại user. Không còn giới hạn theo 1 category cố định như bản cũ — áp dụng cho mọi
 * category, vì Provider giờ do Admin tự gắn trên bất kỳ nhánh folder nào.
 */
export async function detectAmbiguity(
  normalizedQ: NormalizedQuery
): Promise<ClarificationNeeded> {
  const { contentChunks, nodes } = kbTables();
  // Nếu đã xác định được Provider → không cần hỏi lại
  if (normalizedQ.detectedProvider) {
    return { needed: false };
  }

  const topic = extractKeyTopic(normalizedQ.normalized);

  // Đếm số Provider khác nhau có nội dung thật (đã Đăng) liên quan tới topic này
  const providerMatches = await db
    .selectDistinct({ provider: contentChunks.provider })
    .from(contentChunks)
    .innerJoin(nodes, eq(nodes.id, contentChunks.nodeId))
    .where(
      and(
        isNotNull(contentChunks.provider),
        eq(nodes.status, 'published'),
        // CHỈ so với TÊN BÀI, cố ý không quét `chunk_text`.
        //
        // Trước đây có thêm vế `ilike(contentChunks.chunkText, ...)`, và nó khiến hệ thống hỏi
        // ngược lại người dùng bằng một danh sách sảnh Live Casino chẳng liên quan gì. Nguyên
        // nhân: với câu hỏi so sánh chung chung ("Sự khác nhau là gì"), extractKeyTopic() rút ra
        // chủ đề là "khác nhau" — một cụm từ nối. Cụm đó nằm rải rác trong phần mô tả của rất
        // nhiều bài ("tỷ lệ thanh toán khác nhau", "các loại cược khác nhau"), thực đo là chunk
        // của 7/8 Provider, nên điều kiện ">= 2 Provider" luôn thoả. Và vì 6/8 Folder Provider
        // thuộc Live Casino nên danh sách gợi ý gần như lúc nào cũng là các sảnh Live Casino.
        //
        // Tên bài mới là tín hiệu đúng: nó cho biết sảnh đó THỰC SỰ có nội dung riêng về chủ đề
        // đang hỏi, còn một cụm từ xuất hiện tình cờ giữa đoạn văn thì không nói lên điều gì.
        ilike(nodes.name, `%${topic}%`)
      )
    )
    .limit(5);

  const providers = providerMatches
    .map((r) => r.provider)
    .filter(Boolean) as string[];

  if (providers.length >= 2) {
    return {
      needed: true,
      topic,
      matchedProviders: providers,
    };
  }

  return { needed: false };
}

/**
 * Trích xuất keyword chính từ câu hỏi (đơn giản, không dùng AI)
 * để so sánh với tiêu đề bài viết trong DB
 */
function extractKeyTopic(query: string): string {
  const STOP_WORDS = ['có', 'là', 'gì', 'như', 'thế', 'nào', 'của', 'cho', 'với', 'và', 'hay', 'hoặc', 'về', 'trong', 'khi', 'được', 'sẽ'];
  const words = query.toLowerCase().split(/\s+/);
  // > 2 (không phải > 3) để không loại nhầm các từ tiếng Việt có dấu chỉ 3 ký tự nhưng
  // vẫn mang nghĩa quan trọng (vd "tốc" trong "xổ số siêu tốc") — từ ngắn vô nghĩa đã có
  // STOP_WORDS chặn riêng.
  const keywords = words.filter((w) => w.length > 2 && !STOP_WORDS.includes(w));
  return keywords.slice(0, 3).join(' ') || query.slice(0, 40);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect Provider ngay trong câu hỏi bằng cách so khớp với tên các Folder Admin đã đánh dấu
 * isProvider=true (setProviderFlag) — hoàn toàn theo dữ liệu thực tế trên cây thư mục, không
 * có danh sách provider cứng nào. Khớp theo substring không phân biệt hoa/thường; nếu nhiều
 * folder cùng khớp thì lấy tên dài nhất (cụ thể hơn, tránh 1 tên ngắn "ăn" nhầm 1 tên dài hơn
 * chứa nó, vd "M88" bên trong "Club M88").
 */
async function detectProviderFromFolders(lowerQuery: string): Promise<string | undefined> {
  const matches = await matchProviderFolders(lowerQuery);

  if (matches.length === 0) return undefined;
  return matches.reduce((longest, name) => (name.length > longest.length ? name : longest));
}

/** Danh sách tên Folder được đánh dấu isProvider có mặt trong câu hỏi (chưa khử tên lồng nhau). */
async function matchProviderFolders(lowerQuery: string): Promise<string[]> {
  const { nodes } = kbTables();
  // selectDistinct: một tên sảnh có thể xuất hiện ở NHIỀU folder khác nhau trên cây (ví dụ
  // "V8 Poker" vừa là sảnh trong nhánh P2P, vừa là nhóm trong nhánh Khuyến mãi). Không khử
  // trùng thì `detectProvidersInQuery()` trả về ["V8 Poker", "V8 Poker"], khiến ai.service
  // tưởng câu hỏi nhắc TỚI HAI sảnh và bỏ luôn bộ lọc theo sảnh — câu hỏi chỉ nhắc một sảnh
  // lại mất đúng phần ưu tiên xếp hạng dành cho nó.
  const providerFolders = await db
    .selectDistinct({ name: nodes.name })
    .from(nodes)
    .where(and(eq(nodes.type, 'folder'), eq(nodes.isProvider, true)));

  return providerFolders
    .map((f) => f.name)
    .filter((name) => name.trim().length > 0 && lowerQuery.includes(name.toLowerCase()));
}

/**
 * Trả về TẤT CẢ Provider được nhắc tới trong câu hỏi, không chỉ một cái.
 *
 * `detectProviderFromFolders()` cố ý chỉ giữ tên DÀI NHẤT để "M88" không ăn nhầm "Club M88" —
 * đúng cho câu hỏi về một sảnh, nhưng sai hẳn với câu so sánh kiểu "Sexy Gaming khác Club M88".
 * Ở câu đó nó chỉ giữ lại một sảnh rồi ưu tiên xếp hạng cho mỗi sảnh ấy, nên không chunk nào
 * của sảnh còn lại lọt vào context và AI trả lời "không tìm thấy" dù KB có đủ cả hai.
 *
 * Hàm này giữ nguyên nguyên tắc chống ăn nhầm bằng cách loại tên nào là chuỗi con của một tên
 * khác cũng khớp, nhưng giữ lại mọi Provider thực sự khác nhau.
 */
export async function detectProvidersInQuery(query: string): Promise<string[]> {
  const matches = await matchProviderFolders(query.toLowerCase());

  return matches.filter(
    (name) =>
      !matches.some((other) => other !== name && other.toLowerCase().includes(name.toLowerCase())),
  );
}
