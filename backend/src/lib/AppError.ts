/**
 * Lỗi nghiệp vụ có mã HTTP đi kèm.
 *
 * Trước đây service chỉ `throw new Error('BR-012: ...')` rồi router phải đoán status bằng cách
 * so khớp chuỗi tiếng Việt trong message (`msg.includes('BR-012')`, `msg.includes('chính nó')`...).
 * Cách đó rất dễ vỡ: chỉ cần sửa một chữ trong câu thông báo là status code đổi theo mà
 * TypeScript không hề báo lỗi. Với AppError, service tự khai báo status, router chỉ cần
 * `next(err)` và errorHandler đọc `status` ra.
 *
 * Quy ước status dùng trong dự án:
 * - 404: không tìm thấy bản ghi.
 * - 409: thao tác xung đột với một tiến trình đang chạy (vd đang có lượt re-index khác).
 * - 413: dữ liệu gửi lên vượt giới hạn dung lượng.
 * - 422: dữ liệu hợp lệ về cú pháp nhưng vi phạm quy tắc nghiệp vụ (BR-xxx).
 */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Mã máy đọc được, tuỳ chọn — frontend dùng để phân nhánh xử lý thay vì so khớp message. */
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Không tìm thấy bản ghi. */
export function notFound(message: string, code?: string): AppError {
  return new AppError(404, message, code);
}

/** Vi phạm quy tắc nghiệp vụ (BR-xxx) — dữ liệu đúng cú pháp nhưng không được phép. */
export function businessRuleViolation(message: string, code?: string): AppError {
  return new AppError(422, message, code);
}

/** Xung đột với một tiến trình đang chạy. */
export function conflict(message: string, code?: string): AppError {
  return new AppError(409, message, code);
}
