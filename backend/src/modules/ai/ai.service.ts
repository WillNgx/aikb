import { env } from "../../config/env";
import { currentKb } from "../kb/kb.context";
import { KB_SETTING_KEYS, getKbNumberSetting, getKbSetting } from "../kb/kbSettings.service";
import { search, SearchResult } from "../search/search.service";
import { db } from "../../db";
import { analyticsEvents } from "../../db/schema";
import { normalizeQuery, detectAmbiguity, detectProvidersInQuery } from "./slang.service";
import { rewriteQuery } from "./queryRewrite.service";
import { getRecentQuestions, mergeWithHistory, sanitizeClientHistory } from "./contextHistory.service";
import { callChatModel } from "../llm/llm.service";
import { clarifyQueries, fillText, getAiTexts } from "./aiTexts";

// Số chunk tối đa đưa vào context để AI trả lời — giữ ở mức cao để câu trả lời đầy đủ, KHÔNG
// phải số link hiển thị cho user (xem DEFAULT_RELATED_LINKS_COUNT + getRelatedLinksCount bên dưới).
const MAX_CONTEXT_CHUNKS = 5;
// Số link trích dẫn hiển thị cho user (Admin cấu hình tại Thống kê > Số lượng link gợi ý AI Chat).
const DEFAULT_RELATED_LINKS_COUNT = 2;

export interface ChatResponse {
  answer: string;
  citations: Citation[];
  hasAnswer: boolean;
  suggestions?: SearchResult[];
  // Clarification flow (Rủi ro 1)
  needsClarification?: boolean;
  clarificationQuestion?: string;
  clarificationOptions?: ClarificationOption[];
  // Debug info (chỉ dùng khi development)
  debug?: {
    originalQuery: string;
    // Câu hỏi sau khi ghép lịch sử gần đây (nếu có) — CHỈ khác originalQuery khi có import lịch sử.
    mergedQuestion?: string;
    normalizedQuery: string;
    slangReplacements: Array<{ from: string; to: string }>;
  };
  // Cảnh báo: câu hỏi xác định được Provider nhưng không có chunk nào trong context thực sự
  // gắn đúng Provider đó — câu trả lời chỉ là thông tin tham khảo chung, chưa chắc đúng riêng
  // cho Provider được hỏi.
  note?: string;
}

export interface ClarificationOption {
  label: string; // VD: "⚽ M Thể thao"
  provider: string; // VD: "M Thể thao"
  query: string; // Câu hỏi đầy đủ khi user chọn option này
}

export interface Citation {
  chunkId: string;
  contentId: string;
  contentTitle: string;
  sectionTitle: string | null;
  headingIndex: number | null;
  excerpt: string;
}

/**
 * Tiến trình xử lý một câu hỏi, đẩy về FE (qua SSE ở `POST /api/ai/chat/stream`) để người dùng
 * thấy hệ thống đang làm gì thay vì một ô "Đang xử lý..." đứng im 20-30 giây.
 *
 * CỐ Ý chỉ gửi KHOÁ BƯỚC + số liệu, không gửi sẵn câu chữ hiển thị: chữ và icon là việc của
 * frontend, backend đổi cách diễn đạt không nên bắt build lại cả hai bên.
 *
 * `expanding` chỉ phát khi bước rewrite THỰC SỰ chạy (retrieval rỗng hoặc câu hỏi nhắc nhiều
 * Provider) — đây chính là thứ mà một thanh tiến trình chạy theo đồng hồ không thể biết.
 */
export type ChatProgress =
  | { step: 'understanding' }
  | { step: 'searching' }
  | { step: 'expanding' }
  | { step: 'generating'; chunkCount: number };

export type ChatProgressCallback = (progress: ChatProgress) => void;

/**
 * AI/RAG Pipeline (Hướng A — Hybrid 2-Tier Filtered RAG):
 * -1. Context Memory: import tối đa 4 câu hỏi gần nhất (15 phút) cùng định danh, ghép thành câu
 *     hỏi đầy đủ nếu câu hỏi hiện tại bị tỉnh lược/dùng đại từ (contextHistory.service)
 * 0. Normalize query: chuẩn hóa từ lóng (slang.service) — chạy trên câu hỏi ĐÃ ghép ở bước -1
 * 0b. Ambiguity Detection: phát hiện mơ hồ → hỏi lại nếu cần (Rủi ro 1)
 * 1. Retrieve chunks liên quan (có metadata filter nếu detect được Provider)
 * 2. Kiểm tra relevance threshold → Fallback nếu không đủ
 * 3. No-Answer Flow (BR-004) + gợi ý (BR-005)
 * 4. Xây dựng context → gọi model chat (provider do Admin cấu hình, có fallback)
 * 5. Parse output (answer + citations)
 *
 * [SECURITY] System prompt tách biệt hoàn toàn với context KB.
 */
export async function chat(
  question: string,
  userId?: string,
  telegramId?: string,
  onProgress?: ChatProgressCallback,
  /**
   * Lịch sử hội thoại do CLIENT gửi lên — chỉ dùng cho web. Xem `sanitizeClientHistory`.
   * Bot Telegram không có sessionStorage nên vẫn đọc lịch sử từ DB theo `telegramId`.
   */
  clientHistory?: unknown,
): Promise<ChatResponse> {
  // Callback là TUỲ CHỌN và lỗi của nó KHÔNG được làm hỏng câu trả lời: nó ghi thẳng vào
  // response SSE, mà client có thể đóng tab giữa chừng làm lệnh ghi ném lỗi. Telegram bot gọi
  // chat() không truyền callback nên hoàn toàn không đổi hành vi.
  const notify = (progress: ChatProgress): void => {
    try {
      onProgress?.(progress);
    } catch (err) {
      console.warn('[AI Chat] Không gửi được tiến trình:', err);
    }
  };

  notify({ step: 'understanding' });

  // ── Bước -1: Context Memory ───────────────────────────────────────────────
  //
  // BẮT BUỘC chạy TRƯỚC khi ghi analytics_events cho câu hỏi hiện tại bên dưới — ghi trước sẽ
  // khiến chính câu hỏi đang hỏi lẫn vào "lịch sử gần đây" mà bước này vừa đọc ra.
  // WEB: lịch sử do client gửi (sessionStorage theo TỪNG TAB) — nhiều nhân viên dùng chung một
  // tài khoản nên đọc theo `user_id` từ DB sẽ trộn câu hỏi của những người khác nhau vào cùng
  // một mạch hội thoại. TELEGRAM: không có sessionStorage nên vẫn đọc DB theo `telegramId`
  // (truy vấn đó đã lọc thêm kb_code — xem contextHistory.service).
  const recentQuestions = telegramId
    ? await getRecentQuestions({ telegramId })
    : sanitizeClientHistory(clientHistory);
  const effectiveQuestion = recentQuestions.length
    ? await mergeWithHistory(question, recentQuestions)
    : question;

  // Log analytics — dùng `question` GỐC (không dùng effectiveQuestion đã ghép), để lần sau tra
  // lịch sử phản ánh đúng những gì user thực sự gõ, không lẫn phần do AI viết lại.
  if (userId) {
    db.insert(analyticsEvents)
      .values({ eventType: "ai_question", query: question, userId, kbCode: currentKb().code })
      .catch(console.error);
  }

  // ── Bước 0: Normalize query (từ lóng → chuẩn hóa) ────────────────────────
  const normalized = await normalizeQuery(effectiveQuestion);
  const normalizedQuestion = normalized.normalized;

  // ── Bước 0b: Ambiguity Detection → hỏi lại nếu thiếu Provider ───────────
  const ambiguity = await detectAmbiguity(normalized);
  if (
    ambiguity.needed &&
    ambiguity.matchedProviders &&
    ambiguity.matchedProviders.length >= 2
  ) {
    const PROVIDER_ICONS: Record<string, string> = {
      "M Thể thao": "⚽",
      Saba: "🔵",
      Bti: "🟢",
      "Sexy Gaming": "🎰",
      "Club M88": "🎲",
    };

    // Câu chữ theo KB (Admin sửa được ở trang System prompt) — xem aiTexts.ts
    const texts = await getAiTexts();
    const queries = clarifyQueries(currentKb().locale);
    const topic = ambiguity.topic ?? "";

    const clarificationOptions: ClarificationOption[] = [
      ...ambiguity.matchedProviders.map((p) => ({
        label: `${PROVIDER_ICONS[p] ?? "📋"} ${p}`,
        provider: p,
        query: queries.pickProvider(normalizedQuestion, p),
      })),
      {
        label: `📑 ${texts.compareAll}`,
        provider: "__all__",
        query: queries.compareAll(topic, ambiguity.matchedProviders),
      },
    ];

    const clarificationQuestion = fillText(texts.clarify, { topic });
    return {
      answer: clarificationQuestion,
      citations: [],
      hasAnswer: false,
      needsClarification: true,
      clarificationQuestion,
      clarificationOptions,
    };
  }

  // ── Bước 1: Retrieve (hybrid keyword ∥ vector, hợp nhất bằng RRF) ─────────
  //
  // Câu hỏi nhắc tới NHIỀU sảnh ("Sexy Gaming khác Club M88?") thì KHÔNG được truyền provider
  // filter: `detectedProvider` chỉ giữ đúng một tên (tên dài nhất), nên ưu tiên xếp hạng theo nó
  // sẽ đẩy hết chunk của sảnh còn lại ra khỏi top và AI trả lời "không tìm thấy" dù KB có đủ.
  const providersInQuery = await detectProvidersInQuery(normalizedQuestion);
  const isMultiProvider = providersInQuery.length >= 2;

  const searchFilters = {
    category: normalized.detectedCategory,
    provider: isMultiProvider ? undefined : normalized.detectedProvider,
  };

  notify({ step: 'searching' });

  let searchResults = await search(normalizedQuestion, undefined, searchFilters);

  // ── Bước 1b: Rewrite CÓ ĐIỀU KIỆN ────────────────────────────────────────
  //
  // Cố ý KHÔNG rewrite mọi câu hỏi: đo trên bộ 18 câu thật thì chạy luôn sẽ gấp đôi số lượt gọi
  // model và cộng thêm 1-2s cho mọi câu, trong khi chỉ khoảng 1/18 câu thực sự cần. Hai điều
  // kiện dưới đây là đúng hai tình huống rule-based bó tay:
  //   - retrieval rỗng: câu chữ người dùng dùng không khớp gì trong KB
  //   - nhiều Provider: câu so sánh, cần gom từ khoá của mọi sảnh vào một truy vấn
  if (searchResults.length === 0 || isMultiProvider) {
    notify({ step: 'expanding' });

    const rewritten = await rewriteQuery(normalizedQuestion);

    if (rewritten !== normalizedQuestion) {
      const retryResults = await search(rewritten, undefined, searchFilters);
      searchResults = mergeSearchResults(searchResults, retryResults);
    }
  }

  // ── Bước 2: No-Answer khi không còn chunk nào ─────────────────────────────
  //
  // KHÔNG lọc lại theo `relevance_threshold` ở đây nữa. Ngưỡng đó là ngưỡng cosine similarity,
  // chỉ có nghĩa với nhánh vector và đã được áp bên trong search(). Sau khi hợp nhất RRF, điểm
  // của mỗi chunk là điểm RRF (cỡ 0.016) — đem so với 0.45 sẽ loại sạch mọi chunk và AI trả lời
  // "không tìm thấy" cho 100% câu hỏi.
  const relevantChunks = searchResults;

  if (relevantChunks.length === 0) {
    // ── No-Answer Flow (BR-004, BR-005) ───────────────────────────────────
    if (userId) {
      db.insert(analyticsEvents)
        .values({ eventType: "ai_no_answer", query: question, userId, kbCode: currentKb().code })
        .catch(console.error);
    }

    return {
      answer: (await getAiTexts()).noAnswer,
      citations: [],
      hasAnswer: false,
      suggestions: searchResults.slice(0, 3),
      debug:
        env.NODE_ENV === "development"
          ? {
              originalQuery: question,
              mergedQuestion: effectiveQuestion !== question ? effectiveQuestion : undefined,
              normalizedQuery: normalizedQuestion,
              slangReplacements: normalized.slangReplacements,
            }
          : undefined,
    };
  }

  // ── Bước 3: Xây dựng context ──────────────────────────────────────────────
  const contextChunks = relevantChunks.slice(0, MAX_CONTEXT_CHUNKS);
  const context = buildContext(contextChunks);

  // Câu hỏi xác định được Provider nhưng không chunk nào trong context thực sự gắn đúng
  // Provider đó (nội dung chưa được gắn tag, hoặc chỉ có bài viết chung/của provider khác) →
  // cảnh báo rõ đây chỉ là thông tin tham khảo chung, không tự nhận là đúng cho Provider hỏi.
  // Bỏ qua cảnh báo này với câu hỏi nhiều sảnh: lúc đó `detectedProvider` chỉ là một trong số
  // các sảnh được nhắc tới, đối chiếu theo nó sẽ ra cảnh báo sai.
  const providerMismatch =
    !isMultiProvider &&
    !!normalized.detectedProvider &&
    !contextChunks.some((c) => c.provider === normalized.detectedProvider);
  const note = providerMismatch
    ? `⚠️ ${fillText((await getAiTexts()).providerNote, { provider: normalized.detectedProvider ?? "" })}`
    : undefined;

  // ── Bước 4: Gọi model chat với system prompt grounding ────────────────────
  //
  // Gửi kèm số chunk THẬT đang đưa cho model đọc — đây là số liệu có thật nên hiển thị được cho
  // người dùng; một thanh tiến trình chạy theo đồng hồ thì không được phép hiện con số nào.
  notify({ step: 'generating', chunkCount: contextChunks.length });

  const rawAnswer = await callChatProvider(normalizedQuestion, context);

  // ── Bước 5: Trả kết quả ───────────────────────────────────────────────────
  // Chỉ hiển thị cho user tối đa `relatedLinksCount` link đầu (Admin cấu hình) — KHÔNG cắt bớt
  // contextChunks dùng để trả lời (giữ nguyên MAX_CONTEXT_CHUNKS để câu trả lời đầy đủ).
  const relatedLinksCount = await getRelatedLinksCount();
  return {
    answer: rawAnswer,
    citations: contextChunks.slice(0, relatedLinksCount).map((c) => ({
      chunkId: c.chunkId,
      contentId: c.contentId,
      contentTitle: c.contentTitle,
      sectionTitle: c.sectionTitle,
      headingIndex: c.headingIndex,
      excerpt: c.excerpt,
    })),
    hasAnswer: true,
    note,
    debug:
      env.NODE_ENV === "development"
        ? {
            originalQuery: question,
            normalizedQuery: normalizedQuestion,
            slangReplacements: normalized.slangReplacements,
          }
        : undefined,
  };
}

// ─── Context Builder ──────────────────────────────────────────────────────────

/**
 * Xây context string kèm metadata và delimiter rõ ràng.
 * Delimiter ngăn prompt injection từ nội dung KB.
 */
function buildContext(chunks: SearchResult[]): string {
  const sections = chunks.map((chunk, i) => {
    const header = `[NGUỒN ${i + 1}] ${chunk.contentTitle}${chunk.sectionTitle ? ` > ${chunk.sectionTitle}` : ""}`;
    return `${header}\n${chunk.chunkText}`;
  });

  return sections.join("\n\n---\n\n");
}

// ─── Gọi model chat ───────────────────────────────────────────────────────────

/**
 * [SECURITY] System prompt cố định — không thể bị user/KB override.
 * Context KB đặt trong delimiter <<<KB_CONTEXT>>> ... <<<END_KB_CONTEXT>>>
 *
 * Không gọi thẳng Gemini nữa mà đi qua adapter (llm.service): provider do Admin chọn, và nếu
 * provider đó hết quota thì adapter tự chuyển sang provider khác còn quota.
 */
async function callChatProvider(question: string, context: string): Promise<string> {
  // LƯU Ý VỀ CÁCH DIỄN ĐẠT: các câu lệnh ở đây CỐ Ý tránh cụm "dựa trên". Model có xu hướng
  // nhại lại chính từ ngữ của prompt, nên khi prompt nói "trả lời dựa trên thông tin trong KB"
  // thì gần như câu trả lời nào cũng mở đầu bằng "Dựa trên thông tin trong Knowledge Base, ...".
  // Ràng buộc grounding nằm ở ĐOẠN MỞ ĐẦU (chỉ dùng KB, không suy diễn, không bịa) — vẫn nguyên
  // vẹn về mặt ngữ nghĩa so với bản cũ, chỉ đổi cách nói và gom lại cho gọn.
  //
  // VỀ ĐỘ DÀI: prompt này được gửi lại NGUYÊN VẸN ở MỖI request và tiếng Việt có dấu tốn khoảng
  // 1 token / 2-2,5 ký tự (tiếng Anh là ~1/4), nên mỗi câu thừa đều nhân lên theo số câu hỏi.
  // Đó là lý do các nguyên tắc dưới đây viết ở dạng mệnh lệnh ngắn, phần giải thích LÝ DO để hết
  // trong comment này. Cũng đã cân nhắc viết prompt bằng tiếng Anh cho rẻ token (~15-20% input)
  // nhưng bỏ: nguyên tắc 1 buộc phải giữ nguyên cụm tiếng Việt mới có tác dụng, và prompt Anh +
  // context Việt làm model rẻ dễ bám rule kém hơn — không đáng đổi.
  //
  // Nguyên tắc 5, 6 vá 2 lỗi phát hiện khi QC cơ chế Context Memory: (5) hỏi phủ định kiểu
  // "không có ở đâu?" bị model lặp lại đúng câu trả lời khẳng định của câu hỏi gốc, coi như đã
  // trả lời xong; (6) câu hỏi còn cụm mơ hồ không resolve được từ lịch sử (vd "sảnh đầu tiên" —
  // chỉ có nghĩa nhờ THỨ TỰ trong câu trả lời trước, mà lịch sử chỉ lưu câu hỏi không lưu câu trả
  // lời) đôi khi bị model đoán bừa một giá trị thay vì báo không rõ — do temperature, không phải
  // lỗi hệ thống nhất quán, nên phải chặn tận gốc bằng rule rõ ràng thay vì chỉ dựa vào may rủi.
  //
  // Nguyên tắc 2, 3, 4 lấy từ bộ nguyên tắc trả lời SOP nội bộ: (2) kết luận đặt trước để người
  // đọc trên bubble chat hẹp không phải đọc hết mới biết được/không được; (3) chặn lỗi model liệt
  // kê đủ thao tác nhưng nuốt mất điều kiện tiên quyết; (4) chặn lỗi gộp nội dung của nhiều sảnh
  // hoặc nhiều mức xử lý thành một câu trả lời chung — KB này đa Provider nên rất dễ dính.
  //
  // "Không dùng bảng" ở khối TRÌNH BÀY là CHỐT CHẶN, không phải gợi ý phong cách: frontend render
  // câu trả lời bằng `react-markdown` TRẦN (ChatMarkdown.tsx), KHÔNG có remark-gfm, mà bảng là cú
  // pháp GFM — bỏ dòng này ra là người dùng nhìn thấy nguyên đống "| --- | --- |". Muốn cho phép
  // bảng thì phải cài remark-gfm và thêm style bảng vào chat.css trước.
  const DEFAULT_SYSTEM_PROMPT_VI = `Bạn là trợ lý AI của Knowledge Base nội bộ. Chỉ dùng thông tin có trong KNOWLEDGE BASE bên dưới: không dùng kiến thức ngoài, không suy diễn, không bịa. Không trả lời được thì nói rõ "Tôi không tìm thấy thông tin này trong Knowledge Base."

NGUYÊN TẮC:
1. Trả lời bằng tiếng Việt, đi thẳng vào nội dung. TUYỆT ĐỐI không mở đầu bằng "Dựa trên...", "Theo tài liệu...", "Căn cứ vào KB..." — người đọc đã biết nguồn.
2. Câu đầu tiên là kết luận (được/không được, có/không, hướng xử lý). Lý do và các bước đặt sau.
3. KB có điều kiện áp dụng, điều kiện tiên quyết hoặc thứ tự bắt buộc thì phải nêu, không rút gọn còn mỗi thao tác.
4. KB mô tả nhiều trường hợp hoặc nhiều mức xử lý thì tách riêng từng cái kèm điều kiện của nó, không gộp thành một câu trả lời chung.
5. Câu hỏi PHỦ ĐỊNH/LOẠI TRỪ ("không có ở đâu", "trừ cái nào") mà KB chỉ liệt kê trường hợp khẳng định: nói rõ không đủ dữ liệu cho chiều phủ định, TUYỆT ĐỐI không lặp lại câu trả lời khẳng định như thể đã trả lời đúng.
6. Câu hỏi còn cụm mơ hồ không khớp tên cụ thể nào trong KB ("sảnh đầu tiên", "cái kia"): hỏi lại cho rõ, TUYỆT ĐỐI không đoán bừa.

TRÌNH BÀY:
- Nhiều bước hoặc nhiều ý: gạch đầu dòng, mỗi ý một dòng ngắn. In đậm tên riêng, con số và điều kiện chặn.
- So sánh nhiều đối tượng: mỗi đối tượng một nhóm gạch đầu dòng riêng, giữ cùng thứ tự tiêu chí. Không dùng bảng.
- Chỉ dùng tiêu đề "##" khi câu trả lời có từ 3 phần rõ rệt trở lên; câu ngắn thì không cần tiêu đề.`;

  // Prompt theo TỪNG KB. Mỗi ngôn ngữ cần bản riêng, và bản tiếng Anh phải VIẾT LẠI chứ không
  // dịch máy: nguyên tắc 1 ở trên chặn model mở đầu bằng "Dựa trên..." bằng chính cách diễn đạt
  // tiếng Việt, dịch sang ngôn ngữ khác là mất tác dụng.
  //
  // Chưa cấu hình thì dùng bản tiếng Việt mặc định. Với KB không phải tiếng Việt thì ghi cảnh
  // báo — dữ liệu cách ly đúng mà prompt không đổi sẽ dẫn tới việc người dùng hỏi tiếng Anh,
  // tìm đúng tài liệu tiếng Anh, rồi nhận câu trả lời bằng tiếng Việt.
  const kb = currentKb();
  const systemPrompt = await getKbSetting(KB_SETTING_KEYS.systemPrompt, DEFAULT_SYSTEM_PROMPT_VI);
  if (systemPrompt === DEFAULT_SYSTEM_PROMPT_VI && kb.locale !== 'vi') {
    console.warn(
      `[AI] KB "${kb.code}" (locale ${kb.locale}) chưa có system_prompt riêng — đang dùng prompt tiếng Việt, câu trả lời sẽ ra tiếng Việt.`
    );
  }

  // Câu bọc câu hỏi theo ngôn ngữ của KB: KB tiếng Việt giữ nguyên câu cũ, KB khác dùng tiếng Anh
  // trung tính — câu bọc tiếng Việt kéo model trả lời lẫn tiếng Việt cho người hỏi bằng tiếng khác.
  const askBlock =
    kb.locale === 'vi'
      ? `Câu hỏi: ${question}

Trả lời câu hỏi trên. Chỉ được dùng thông tin nằm trong KB_CONTEXT.`
      : `Question: ${question}

Answer the question above using only the information inside KB_CONTEXT.`;

  const userMessage = `<<<KB_CONTEXT>>>
${context}
<<<END_KB_CONTEXT>>>

${askBlock}`;

  // Tham số giữ nguyên như khi gọi Gemini trực tiếp: temperature thấp để bám sát KB,
  // maxOutputTokens 2048 đủ cho câu trả lời dài nhất hiện có.
  return callChatModel({
    systemPrompt,
    userMessage,
    temperature: 0.1,
    maxOutputTokens: 2048,
  });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Gộp kết quả của lần search gốc và lần search sau khi rewrite, khử trùng theo chunkId.
 *
 * Kết quả của truy vấn đã rewrite được xếp TRƯỚC: rewrite chỉ chạy khi lần đầu thất bại hoặc
 * câu hỏi nhắc nhiều sảnh, nên nó là truy vấn sát ý hơn. Kết quả cũ vẫn giữ lại phía sau để
 * không mất chunk nào lần đầu đã tìm đúng.
 */
function mergeSearchResults(
  original: SearchResult[],
  rewritten: SearchResult[],
): SearchResult[] {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];

  for (const chunk of [...rewritten, ...original]) {
    if (seen.has(chunk.chunkId)) continue;
    seen.add(chunk.chunkId);
    merged.push(chunk);
  }

  return merged;
}

async function getRelatedLinksCount(): Promise<number> {
  // Theo TỪNG KB (có đường lùi về app_settings) — xem kbSettings.service.ts
  return getKbNumberSetting(KB_SETTING_KEYS.relatedLinksCount, DEFAULT_RELATED_LINKS_COUNT);
}
