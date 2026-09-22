import { AsyncLocalStorage } from 'async_hooks';
import type { KbTables } from '../../db/kbSchema';
import type { KbInfo } from './kb.registry';

/**
 * Ngữ cảnh "đang phục vụ KB nào" của luồng xử lý hiện tại.
 *
 * Dùng `AsyncLocalStorage` thay vì truyền tham số `kbCode` qua từng chữ ký hàm: hệ thống có
 * hơn 70 điểm truy vấn DB rải trong 16 file, luồn thêm một tham số qua tất cả vừa tạo ra một
 * diff khổng lồ vừa để lại đúng cái bẫy muốn tránh — chỉ cần MỘT chỗ quên truyền là truy vấn
 * chạy trên KB sai mà không có lỗi nào báo.
 *
 * NGUYÊN TẮC QUAN TRỌNG NHẤT của file này: `currentKb()` NÉM LỖI khi không có ngữ cảnh, tuyệt
 * đối không âm thầm lùi về KB mặc định. Một tác vụ nền quên mở ngữ cảnh mà lặng lẽ chạy trên
 * kb_vi sẽ ghi dữ liệu tiếng Anh vào KB tiếng Việt — hỏng dữ liệu, không exception, không ai
 * biết. Sập rõ ràng ngay lúc chạy thử rẻ hơn nhiều.
 */

export interface KbContext {
  code: string;
  locale: string;
  schemaName: string;
  tables: KbTables;
}

const storage = new AsyncLocalStorage<KbContext>();

function toContext(kb: KbInfo): KbContext {
  return { code: kb.code, locale: kb.locale, schemaName: kb.schemaName, tables: kb.tables };
}

/**
 * Chạy một đoạn xử lý trong ngữ cảnh của một KB. Mọi lời gọi bất đồng bộ bên trong (kể cả
 * nhiều tầng await) đều thấy đúng KB này.
 */
export function runWithKb<T>(kb: KbInfo | KbContext, fn: () => T): T {
  const ctx = 'tables' in kb && 'isActive' in kb ? toContext(kb as KbInfo) : (kb as KbContext);
  return storage.run(ctx, fn);
}

/**
 * KB của luồng hiện tại. Ném lỗi nếu chưa mở ngữ cảnh — xem chú thích đầu file, đây là chốt
 * chặn cố ý, không phải thiếu sót.
 */
export function currentKb(): KbContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      '[KB] No Knowledge Base context for the current execution flow. ' +
        'Every content query must run inside runWithKb(). ' +
        'Background jobs and scripts must open a KB context themselves before calling services.'
    );
  }
  return ctx;
}

/** Bộ 6 bảng nội dung của KB hiện tại — lối tắt hay dùng nhất trong service. */
export function kbTables(): KbTables {
  return currentKb().tables;
}

/** Có đang ở trong ngữ cảnh KB hay không. Chỉ dùng để ghi log/chẩn đoán, không dùng để rẽ nhánh. */
export function hasKbContext(): boolean {
  return storage.getStore() !== undefined;
}
