import { db } from '../db';
import { auditLogs } from '../db/schema';
import { lt } from 'drizzle-orm';

const RETENTION_MONTHS = 6; // DEC-09
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 lần/ngày đủ cho scale 15 user

/**
 * Xoá audit log cũ hơn 6 tháng (DEC-09).
 * Chạy 1 lần khi server khởi động, sau đó lặp lại mỗi 24h khi process backend còn sống.
 * Ở scale demo (15 user) không cần hệ thống cron/queue riêng — setInterval trong process là đủ.
 */
export async function cleanupOldAuditLogs(): Promise<number> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);

  const deleted = await db.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff)).returning({ id: auditLogs.id });

  if (deleted.length > 0) {
    console.log(`[AuditRetention] Đã xoá ${deleted.length} audit log cũ hơn ${RETENTION_MONTHS} tháng.`);
  }
  return deleted.length;
}

export function startAuditRetentionJob(): void {
  cleanupOldAuditLogs().catch((err) => console.error('[AuditRetention] Lỗi khi cleanup:', err));

  setInterval(() => {
    cleanupOldAuditLogs().catch((err) => console.error('[AuditRetention] Lỗi khi cleanup:', err));
  }, CHECK_INTERVAL_MS);
}
