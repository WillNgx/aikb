import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';

/**
 * Lớp gọi embedding dùng chung cho Tìm kiếm (search.service) và Indexing (indexing.service).
 *
 * Lý do tồn tại: trước đây cả hai đều tự khởi tạo client Gemini bằng đúng một key
 * `GEMINI_API_KEY` và KHÔNG có đường lui — key chính hết quota là Tìm kiếm vector lẫn Đăng bài
 * chết ngay, trong khi AI Chat vẫn sống nhờ key dự phòng. Triệu chứng rất dễ hiểu nhầm là
 * "AI vẫn trả lời được mà tìm kiếm không ra kết quả".
 *
 * Model và số chiều CỐ Ý hardcode `gemini-embedding-001` @ 768: đổi một trong hai thứ này sẽ làm
 * toàn bộ vector cũ trong `content_chunks` không còn cùng không gian với vector mới, search hỏng
 * một cách ÂM THẦM (không có exception nào). Đổi API key thì không sao — vector chỉ phụ thuộc
 * model, không phụ thuộc key.
 *
 * CỐ Ý KHÔNG đi qua lớp adapter LLM (`modules/llm`): adapter đó cho phép Admin đổi provider trong
 * UI, còn ở đây đổi provider là hỏng dữ liệu vector. Đừng "dọn dẹp" bằng cách gộp hai thứ lại.
 */

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;

/** Key theo thứ tự ưu tiên — key sau CHỈ được dùng khi key trước hết quota. */
function getApiKeys(): string[] {
  return [env.GEMINI_API_KEY, env.GEMINI_API_KEY_2]
    .map((k) => k?.trim() ?? '')
    .filter((k) => k !== '');
}

/** Cache client theo key để không khởi tạo lại SDK ở mỗi request. */
const clientCache = new Map<string, GoogleGenAI>();

function getClient(apiKey: string): GoogleGenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

export function isQuotaError(err: unknown): boolean {
  return err instanceof Error && /429|RESOURCE_EXHAUSTED/.test(err.message);
}

/**
 * Tạo embedding cho một đoạn text, tự chuyển sang key dự phòng khi key đang dùng hết quota.
 *
 * Mỗi lần gọi đều thử LẠI TỪ KEY #1 (không nhớ trạng thái "key #1 đang hết quota"): quota free
 * tier reset theo phút nên cách này tự khôi phục ngay khi key chính có quota trở lại, đổi lại là
 * mỗi request trong lúc key #1 cạn sẽ tốn thêm một lần gọi hỏng.
 *
 * Chỉ lỗi quota mới đổi key. Lỗi khác (sai model, mất mạng, key sai) thì đổi key cũng vô ích nên
 * ném ra ngay để chỗ gọi biết mà xử lý.
 */
export async function embedText(text: string): Promise<number[]> {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) {
    throw new Error('GEMINI_API_KEY is not configured in the .env file at the repo root');
  }

  let lastQuotaError: unknown = null;

  for (let i = 0; i < apiKeys.length; i++) {
    try {
      const response = await getClient(apiKeys[i]).models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });

      if (i > 0) console.warn(`[Embedding] Đã tạo embedding bằng key dự phòng #${i + 1}`);
      return response.embeddings?.[0]?.values ?? [];
    } catch (err) {
      if (!isQuotaError(err)) throw err;

      lastQuotaError = err;
      console.warn(
        `[Embedding] Key #${i + 1} hết quota${i + 1 < apiKeys.length ? ' — thử key tiếp theo' : ''}`,
      );
    }
  }

  // Hết sạch key — ném nguyên lỗi quota cuối cùng để chỗ gọi vẫn nhận diện được là lỗi 429
  throw lastQuotaError;
}
