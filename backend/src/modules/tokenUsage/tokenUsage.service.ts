import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { DEFAULT_KB_CODE, aiTokenUsage } from '../../db/schema';
import type { ChatTokenUsage } from '../llm/llm.types';

/**
 * Thống kê token AI Chat đã tiêu, gộp sẵn theo ngày (xem chú thích bảng `ai_token_usage`).
 *
 * Ghi vào đây là việc của lớp adapter LLM (llm.service gọi sau mỗi câu trả lời thành công);
 * đọc/xoá là việc của trang AI Settings bên Admin.
 *
 * Chỉ tính phần CHAT — cả câu hỏi từ web lẫn từ Telegram đều đi qua cùng một đường
 * (ai.service -> callChatModel) nên được cộng chung, không tách kênh.
 */

/** Giữ dữ liệu tối đa 12 tháng — dùng cho cả job dọn dẹp lẫn khoảng xem của biểu đồ tháng. */
export const TOKEN_USAGE_RETENTION_MONTHS = 12;

/**
 * Ngày theo GIỜ VIỆT NAM dưới dạng 'YYYY-MM-DD'.
 *
 * Không dùng `toISOString().slice(0, 10)`: hàm đó trả về ngày theo UTC, nên mọi câu hỏi trước
 * 7h sáng giờ VN sẽ bị đếm sang ngày hôm trước — biểu đồ lệch một ngày mà không có lỗi nào.
 * 'en-CA' được chọn vì locale này format sẵn theo đúng thứ tự YYYY-MM-DD.
 */
export function getVnDateString(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

// ─── Ghi ──────────────────────────────────────────────────────────────────────

/**
 * Cộng dồn token của một lần gọi model vào dòng của (ngày + provider + model).
 *
 * KHÔNG bao giờ ném lỗi ra ngoài: đây là số liệu thống kê, hỏng thì chấp nhận thiếu dữ liệu
 * chứ không được kéo theo lỗi cho câu trả lời mà người dùng đang chờ.
 */
export async function recordTokenUsage(
  provider: string,
  model: string,
  usage: ChatTokenUsage,
): Promise<void> {
  try {
    const usageDate = getVnDateString();

    await db
      .insert(aiTokenUsage)
      .values({
        usageDate,
        // TODO(nhiều KB): tạm dùng KB mặc định. Sẽ thay bằng KB thật của request ở bước gắn
        // ngữ cảnh KB — `callChatModel()` chưa biết mình đang phục vụ KB nào.
        kbCode: DEFAULT_KB_CODE,
        provider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        requestCount: 1,
      })
      .onConflictDoUpdate({
        // Đúng bộ cột của unique index ai_token_usage_date_kb_provider_model_idx
        target: [aiTokenUsage.usageDate, aiTokenUsage.kbCode, aiTokenUsage.provider, aiTokenUsage.model],
        set: {
          // Cộng dồn ngay trong SQL để nhiều request song song không ghi đè lẫn nhau
          inputTokens: sql`${aiTokenUsage.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${aiTokenUsage.outputTokens} + ${usage.outputTokens}`,
          totalTokens: sql`${aiTokenUsage.totalTokens} + ${usage.totalTokens}`,
          requestCount: sql`${aiTokenUsage.requestCount} + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error('[TokenUsage] Không ghi được thống kê token:', err);
  }
}

// ─── Đọc ──────────────────────────────────────────────────────────────────────

export interface UsagePoint {
  /** 'YYYY-MM-DD' với biểu đồ ngày, 'YYYY-MM' với biểu đồ tháng. */
  period: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
}

export interface UsageByModel {
  provider: string;
  model: string;
  totalTokens: number;
  requestCount: number;
}

export interface TokenUsageReport {
  points: UsagePoint[];
  /** Tổng của đúng khoảng đang xem, không phải tổng toàn bộ lịch sử. */
  totals: { inputTokens: number; outputTokens: number; totalTokens: number; requestCount: number };
  /** Xếp hạng model tốn token nhất trong khoảng đang xem. */
  byModel: UsageByModel[];
}

/** Lùi `days` ngày từ hôm nay (giờ VN) và trả về mốc đầu khoảng dạng 'YYYY-MM-DD'. */
function startDateOfLastDays(days: number): string {
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  return getVnDateString(from);
}

/** Lùi `months` tháng và trả về ngày đầu tháng đó dạng 'YYYY-MM-DD'. */
function startDateOfLastMonths(months: number): string {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  return getVnDateString(from);
}

/**
 * Báo cáo theo ngày hoặc theo tháng.
 *
 * Các ngày/tháng không có dữ liệu KHÔNG được trả về ở đây — frontend tự bù khoảng trống khi vẽ,
 * để backend không phải sinh chuỗi ngày rỗng vô ích.
 */
export async function getTokenUsageReport(
  granularity: 'day' | 'month',
  range: number,
): Promise<TokenUsageReport> {
  const startDate =
    granularity === 'day' ? startDateOfLastDays(range) : startDateOfLastMonths(range);

  // to_char thay vì cắt chuỗi ở JS: gộp theo tháng phải do DB làm thì mới dùng được GROUP BY
  const periodExpr =
    granularity === 'day'
      ? sql<string>`to_char(${aiTokenUsage.usageDate}, 'YYYY-MM-DD')`
      : sql<string>`to_char(${aiTokenUsage.usageDate}, 'YYYY-MM')`;

  const rows = await db
    .select({
      period: periodExpr,
      inputTokens: sql<number>`sum(${aiTokenUsage.inputTokens})::int`,
      outputTokens: sql<number>`sum(${aiTokenUsage.outputTokens})::int`,
      totalTokens: sql<number>`sum(${aiTokenUsage.totalTokens})::int`,
      requestCount: sql<number>`sum(${aiTokenUsage.requestCount})::int`,
    })
    .from(aiTokenUsage)
    .where(gte(aiTokenUsage.usageDate, startDate))
    .groupBy(periodExpr)
    .orderBy(periodExpr);

  const modelRows = await db
    .select({
      provider: aiTokenUsage.provider,
      model: aiTokenUsage.model,
      totalTokens: sql<number>`sum(${aiTokenUsage.totalTokens})::int`,
      requestCount: sql<number>`sum(${aiTokenUsage.requestCount})::int`,
    })
    .from(aiTokenUsage)
    .where(gte(aiTokenUsage.usageDate, startDate))
    .groupBy(aiTokenUsage.provider, aiTokenUsage.model)
    .orderBy(desc(sql`sum(${aiTokenUsage.totalTokens})`));

  const points: UsagePoint[] = rows.map((r) => ({
    period: r.period,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    totalTokens: r.totalTokens ?? 0,
    requestCount: r.requestCount ?? 0,
  }));

  const totals = points.reduce(
    (acc, p) => ({
      inputTokens: acc.inputTokens + p.inputTokens,
      outputTokens: acc.outputTokens + p.outputTokens,
      totalTokens: acc.totalTokens + p.totalTokens,
      requestCount: acc.requestCount + p.requestCount,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, requestCount: 0 },
  );

  return {
    points,
    totals,
    byModel: modelRows.map((r) => ({
      provider: r.provider,
      model: r.model,
      totalTokens: r.totalTokens ?? 0,
      requestCount: r.requestCount ?? 0,
    })),
  };
}

// ─── Xoá ──────────────────────────────────────────────────────────────────────

/** Xoá dữ liệu của đúng một ngày ('YYYY-MM-DD'). Trả về số dòng đã xoá. */
export async function deleteUsageByDate(usageDate: string): Promise<number> {
  const deleted = await db
    .delete(aiTokenUsage)
    .where(eq(aiTokenUsage.usageDate, usageDate))
    .returning({ id: aiTokenUsage.id });
  return deleted.length;
}

/** Xoá dữ liệu của đúng một tháng ('YYYY-MM'). Trả về số dòng đã xoá. */
export async function deleteUsageByMonth(month: string): Promise<number> {
  const [year, mon] = month.split('-').map(Number);
  const from = `${month}-01`;
  // Mốc chặn trên là ngày đầu tháng kế tiếp — tránh phải tính số ngày của từng tháng
  const nextMonth = new Date(year, mon, 1);
  const to = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

  const deleted = await db
    .delete(aiTokenUsage)
    .where(and(gte(aiTokenUsage.usageDate, from), lt(aiTokenUsage.usageDate, to)))
    .returning({ id: aiTokenUsage.id });
  return deleted.length;
}

/** Xoá toàn bộ lịch sử token. Trả về số dòng đã xoá. */
export async function deleteAllUsage(): Promise<number> {
  const deleted = await db.delete(aiTokenUsage).returning({ id: aiTokenUsage.id });
  return deleted.length;
}

/** Xoá dữ liệu cũ hơn 12 tháng — dùng cho job dọn dẹp chạy nền. */
export async function cleanupOldTokenUsage(): Promise<number> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - TOKEN_USAGE_RETENTION_MONTHS);

  const deleted = await db
    .delete(aiTokenUsage)
    .where(lt(aiTokenUsage.usageDate, getVnDateString(cutoff)))
    .returning({ id: aiTokenUsage.id });
  return deleted.length;
}
