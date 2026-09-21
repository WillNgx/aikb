import { TOKEN_USAGE_RETENTION_MONTHS, cleanupOldTokenUsage } from '../modules/tokenUsage/tokenUsage.service';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 lần/ngày là đủ, dữ liệu chỉ vài dòng/ngày

/**
 * Xoá thống kê token AI Chat cũ hơn 12 tháng.
 * Chạy 1 lần khi server khởi động rồi lặp mỗi 24h — cùng cách làm với job dọn audit log,
 * ở scale này không cần hệ thống cron/queue riêng.
 */
export function startTokenUsageRetentionJob(): void {
  const run = () =>
    cleanupOldTokenUsage()
      .then((deleted) => {
        if (deleted > 0) {
          console.log(
            `[TokenUsageRetention] Đã xoá ${deleted} dòng thống kê token cũ hơn ${TOKEN_USAGE_RETENTION_MONTHS} tháng.`,
          );
        }
      })
      .catch((err) => console.error('[TokenUsageRetention] Lỗi khi cleanup:', err));

  run();
  setInterval(run, CHECK_INTERVAL_MS);
}
