/**
 * Trạng thái Draft/Published của một Article node KHÔNG phải cờ set thủ công — nó được
 * tính lại mỗi lần ghi (không phải mỗi lần đọc — status vẫn là cột thường, đã có index,
 * được đọc trên đường nóng nhất của app (getTree/getNodeById); tính lại on-write rồi lưu
 * kết quả vào cột là đủ để đảm bảo "không có code path nào tự set status" mà không phải
 * trả giá deep-diff JSONB trên mọi lần đọc cây).
 *
 * Theo Folio Workflow Spec: chưa từng Đăng → luôn Draft. Đã từng Đăng và nội dung hiện tại
 * giống hệt bản Đăng gần nhất → Published. Đã từng Đăng nhưng đã sửa+Lưu khác đi → về Draft,
 * dù trước đó từng xuất bản.
 */
export function computeNodeStatus(
  name: string,
  body: unknown,
  publishedName: string | null,
  publishedBody: unknown
): 'draft' | 'published' {
  if (publishedName === null || publishedName === undefined) return 'draft';
  return name === publishedName && deepEqual(body, publishedBody) ? 'published' : 'draft';
}

/**
 * So sánh sâu, không phụ thuộc thứ tự key trong object — KHÔNG dùng JSON.stringify vì
 * Postgres jsonb không đảm bảo giữ nguyên thứ tự key insertion khi đọc lại, trong khi
 * `body` mới ở request lại theo thứ tự bất kỳ do frontend serialize. Stringify-compare
 * 2 giá trị có thể báo "khác nhau" dù nội dung thực chất giống hệt.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
