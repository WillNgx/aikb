import { db } from '../../db';
import { analyticsEvents } from '../../db/schema';
import { sql } from 'drizzle-orm';
import { embedText, isQuotaError } from '../embedding/embedding.service';
import { currentKb, kbTables } from '../kb/kb.context';
import { KB_SETTING_KEYS, getKbNumberSetting } from '../kb/kbSettings.service';


// Relevance threshold fallback mặc định
const DEFAULT_VECTOR_THRESHOLD = 0.45;
const KEYWORD_MIN_RANK = 0.01;
const MAX_RESULTS = 10;

export async function getVectorThreshold(): Promise<number> {
  // Ngưỡng theo TỪNG KB: phân bố điểm cosine khác nhau giữa các ngôn ngữ (đo được: câu hỏi
  // tiếng Anh khớp chunk tiếng Việt ở 0.62-0.69), dùng chung một ngưỡng sẽ hoặc bỏ sót hoặc
  // nhận rác. Có đường lùi về app_settings nên giá trị cũ vẫn có hiệu lực cho tới khi Admin
  // lưu lại lần đầu.
  return getKbNumberSetting(KB_SETTING_KEYS.relevanceThreshold, DEFAULT_VECTOR_THRESHOLD);
}

export interface SearchResult {
  chunkId: string;
  contentId: string;
  contentTitle: string;
  sectionTitle: string | null;
  headingIndex: number | null;
  excerpt: string;
  chunkText: string;  // raw text dùng để build RAG context
  /**
   * Điểm GỐC của nhánh tìm ra chunk này: ts_rank với keyword, cosine similarity với vector.
   * Hai thang này KHÔNG cùng đơn vị nên không được so sánh trực tiếp với nhau, cũng không
   * được đem so với `relevance_threshold` một cách vô điều kiện — ngưỡng đó chỉ có nghĩa
   * với điểm vector. Việc lọc theo ngưỡng đã làm xong bên trong search(), chỗ gọi không lọc lại.
   */
  score: number;
  /** Điểm hợp nhất RRF dùng để xếp hạng cuối cùng. Chỉ để so sánh tương đối giữa các chunk. */
  fusedScore: number;
  /** Nhánh đã tìm ra chunk này — 'both' nghĩa là cả keyword lẫn vector cùng trả về. */
  searchType: 'keyword' | 'vector' | 'both';
  category: string | null;
  provider: string | null;
}

export interface SearchFilters {
  category?: string;
  provider?: string;
}

/**
 * Hybrid Search: chạy SONG SONG keyword + vector rồi hợp nhất bằng RRF.
 *
 * TRƯỚC ĐÂY đây là cascading: chạy keyword trước, CHỈ khi keyword rỗng mới chạy vector. Cách đó
 * có một lỗi âm thầm và khá nặng — chỉ cần keyword trả về đúng 1 chunk lạc đề (ts_rank rất thấp
 * vẫn tính là "có kết quả") là vector search bị chặn hoàn toàn, model chỉ nhận được mẩu tài liệu
 * vô quan và trả lời "không tìm thấy thông tin", trong khi KB có hẳn bài viết đúng chủ đề.
 * Không có exception nào, nên lỗi này không bao giờ lộ ra ở log.
 *
 * Đo trên bộ 18 câu hỏi thật: nhánh keyword chỉ trả về kết quả ở 1/15 câu — và đúng câu đó là
 * câu bị hỏng. Nghĩa là cascading gần như không tiết kiệm được gì, chỉ tạo thêm cái bẫy.
 *
 * `filters` (category/provider detect được từ câu hỏi — xem slang.service.ts) chỉ ƯU TIÊN xếp
 * hạng chunk khớp lên đầu, KHÔNG loại bỏ chunk không khớp — tránh mất kết quả với nội dung
 * chưa được gắn category/provider đầy đủ.
 */
export async function search(
  query: string,
  userId?: string,
  filters?: SearchFilters
): Promise<SearchResult[]> {
  // Log analytics event (fire-and-forget) — kèm KB để thống kê tách được theo ngôn ngữ
  if (userId) {
    db.insert(analyticsEvents)
      .values({ eventType: 'search', query, userId, kbCode: currentKb().code })
      .catch(console.error);
  }

  // Hai nhánh độc lập nhau nên chạy song song — tổng thời gian bằng nhánh chậm hơn, không phải
  // tổng hai nhánh. Nhánh vector được bọc lại để lỗi quota KHÔNG kéo sập cả hàm: nếu keyword
  // vẫn có kết quả thì trả về được, thay vì chết hẳn như bản cascading cũ.
  const [keywordResults, vectorOutcome] = await Promise.all([
    keywordSearch(query, filters),
    vectorSearch(query, filters).then(
      (results) => ({ ok: true as const, results }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);

  if (!vectorOutcome.ok) {
    // Không còn nhánh nào cứu được → ném nguyên lỗi để chỗ gọi phân biệt "hết quota" với
    // "KB không có nội dung này". Hai thứ đó cần thông báo khác nhau cho người dùng.
    if (keywordResults.length === 0) throw vectorOutcome.error;

    console.warn(
      '[Search] Nhánh vector lỗi, trả về kết quả keyword:',
      vectorOutcome.error instanceof Error ? vectorOutcome.error.message : vectorOutcome.error,
    );
  }

  const vectorResults = vectorOutcome.ok ? vectorOutcome.results : [];

  return fuseRRF(keywordResults, vectorResults, filters).slice(0, MAX_RESULTS);
}

// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/** Hằng số RRF chuẩn — làm mềm chênh lệch giữa các hạng đầu bảng. */
const RRF_K = 60;
/** Cộng thêm cho chunk khớp Provider/Category detect được từ câu hỏi. */
const BOOST_PROVIDER = 0.02;
const BOOST_CATEGORY = 0.01;

/**
 * Hợp nhất 2 danh sách bằng THỨ HẠNG, không dùng điểm thô.
 *
 * Bắt buộc phải làm vậy: ts_rank (keyword) thường rơi vào 0.03–0.1 còn cosine similarity (vector)
 * nằm quanh 0.45–0.9. Trộn hai thang này bằng cách so sánh số trực tiếp sẽ khiến mọi kết quả
 * keyword luôn xếp dưới mọi kết quả vector, bất kể nó khớp tốt đến đâu.
 *
 * Chunk được CẢ HAI nhánh trả về sẽ cộng dồn điểm của cả hai — đó chính là tín hiệu "vừa khớp
 * chữ vừa khớp nghĩa", đáng tin hơn hẳn chunk chỉ khớp một nhánh.
 */
function fuseRRF(
  keywordResults: SearchResult[],
  vectorResults: SearchResult[],
  filters?: SearchFilters,
): SearchResult[] {
  const merged = new Map<string, SearchResult>();

  const addList = (list: SearchResult[]) => {
    list.forEach((chunk, idx) => {
      const rrf = 1 / (RRF_K + idx + 1);
      const existing = merged.get(chunk.chunkId);

      if (existing) {
        existing.fusedScore += rrf;
        existing.searchType = 'both';
        // Giữ điểm gốc CAO hơn giữa hai nhánh cho mục đích hiển thị/gỡ lỗi
        if (chunk.score > existing.score) existing.score = chunk.score;
      } else {
        merged.set(chunk.chunkId, { ...chunk, fusedScore: rrf });
      }
    });
  };

  addList(keywordResults);
  addList(vectorResults);

  for (const chunk of merged.values()) {
    if (filters?.provider && chunk.provider === filters.provider) chunk.fusedScore += BOOST_PROVIDER;
    if (filters?.category && chunk.category === filters.category) chunk.fusedScore += BOOST_CATEGORY;
  }

  return Array.from(merged.values()).sort((a, b) => b.fusedScore - a.fusedScore);
}

// ─── Keyword Search ───────────────────────────────────────────────────────────

async function keywordSearch(query: string, filters?: SearchFilters): Promise<SearchResult[]> {
  const ilikePattern = `%${query}%`;
  const providerParam = filters?.provider ?? null;
  const categoryParam = filters?.category ?? null;
  // Bảng của ĐÚNG KB đang phục vụ request. Nội suy `${contentChunks}` / `${nodes}` vào câu SQL
  // thô bên dưới khiến Drizzle ghi thẳng tên schema (`"kb_en"."nodes"`) — KHÔNG dựa vào
  // `search_path`, vì kết nối đi qua pooler chế độ transaction nên search_path của connection
  // có thể là của client khác.
  const { contentChunks, nodes } = kbTables();

  // JOIN với `nodes` (cây Folder/Article — Wiki thật, nguồn duy nhất từ khi hệ content cũ bị xóa).
  const rows = await db.execute<{
    chunk_id: string;
    content_id: string;
    content_title: string;
    section_title: string | null;
    heading_index: number | null;
    chunk_text: string;
    rank: number;
    category: string | null;
    provider: string | null;
  }>(sql`
    SELECT
      cc.id AS chunk_id,
      cc.node_id AS content_id,
      n.name AS content_title,
      cc.section_title,
      cc.heading_index,
      cc.chunk_text,
      cc.category,
      cc.provider,
      CASE
        WHEN n.name ILIKE ${ilikePattern} THEN 1.0
        ELSE ts_rank(to_tsvector('simple', cc.chunk_text), plainto_tsquery('simple', ${query}))
      END AS rank
    FROM ${contentChunks} cc
    JOIN ${nodes} n ON n.id = cc.node_id
    WHERE n.status = 'published'
      AND (
        n.name ILIKE ${ilikePattern}
        OR to_tsvector('simple', cc.chunk_text) @@ plainto_tsquery('simple', ${query})
      )
    ORDER BY
      CASE
        WHEN ${providerParam}::text IS NOT NULL AND cc.provider = ${providerParam} THEN 0
        WHEN ${categoryParam}::text IS NOT NULL AND cc.category = ${categoryParam} THEN 1
        ELSE 2
      END,
      rank DESC
    LIMIT ${MAX_RESULTS}
  `);

  const results = (rows.rows ?? []).filter((r) => Number(r.rank) >= KEYWORD_MIN_RANK);

  return results.map((r) => ({
    chunkId: r.chunk_id,
    contentId: r.content_id,
    contentTitle: r.content_title,
    sectionTitle: r.section_title,
    headingIndex: r.heading_index,
    excerpt: makeExcerpt(r.chunk_text, query),
    chunkText: r.chunk_text,
    score: Number(r.rank),
    fusedScore: 0, // được tính lại trong fuseRRF()
    searchType: 'keyword' as const,
    category: r.category,
    provider: r.provider,
  }));
}

// ─── Vector Search ────────────────────────────────────────────────────────────

async function vectorSearch(query: string, filters?: SearchFilters): Promise<SearchResult[]> {
  // Tạo embedding cho query — embedding.service tự chuyển sang key Gemini dự phòng khi hết quota
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query);
  } catch (err) {
    // Tới đây nghĩa là MỌI key đều đã hết quota, không còn đường lui nào nữa
    if (isQuotaError(err)) {
      console.log('Search (Vector) - Đã hết quota');
      (err as Error & { aiName?: string }).aiName = 'Search (Vector)';
    }
    throw err;
  }

  if (queryEmbedding.length === 0) return [];

  const threshold = await getVectorThreshold();
  const embeddingStr = `[${queryEmbedding.join(',')}]`;
  const providerParam = filters?.provider ?? null;
  const categoryParam = filters?.category ?? null;
  // Xem chú thích ở keywordSearch: nội suy bảng để tên schema được ghi thẳng vào câu SQL.
  const { contentChunks, nodes } = kbTables();

  const rows = await db.execute<{
    chunk_id: string;
    content_id: string;
    content_title: string;
    section_title: string | null;
    heading_index: number | null;
    chunk_text: string;
    similarity: number;
    category: string | null;
    provider: string | null;
  }>(sql`
    SELECT
      cc.id AS chunk_id,
      cc.node_id AS content_id,
      n.name AS content_title,
      cc.section_title,
      cc.heading_index,
      cc.chunk_text,
      cc.category,
      cc.provider,
      1 - (cc.embedding <=> ${embeddingStr}::vector) AS similarity
    FROM ${contentChunks} cc
    JOIN ${nodes} n ON n.id = cc.node_id
    WHERE n.status = 'published'
      AND cc.embedding IS NOT NULL
      AND 1 - (cc.embedding <=> ${embeddingStr}::vector) >= ${threshold}
    ORDER BY
      CASE
        WHEN ${providerParam}::text IS NOT NULL AND cc.provider = ${providerParam} THEN 0
        WHEN ${categoryParam}::text IS NOT NULL AND cc.category = ${categoryParam} THEN 1
        ELSE 2
      END,
      similarity DESC
    LIMIT ${MAX_RESULTS}
  `);

  return (rows.rows ?? []).map((r) => ({
    chunkId: r.chunk_id,
    contentId: r.content_id,
    contentTitle: r.content_title,
    sectionTitle: r.section_title,
    headingIndex: r.heading_index,
    excerpt: makeExcerpt(r.chunk_text, query),
    chunkText: r.chunk_text,
    score: Number(r.similarity),
    fusedScore: 0, // được tính lại trong fuseRRF()
    searchType: 'vector' as const,
    category: r.category,
    provider: r.provider,
  }));
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeExcerpt(text: string, query: string, maxLen = 200): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase().split(' ')[0];
  const idx = lowerText.indexOf(lowerQuery);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, start + maxLen);
  const excerpt = text.slice(start, end);
  return (start > 0 ? '…' : '') + excerpt + (end < text.length ? '…' : '');
}
