import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from './schema';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  // Trả connection về sớm hơn ngưỡng pooler (PgBouncer của Supabase) tự đóng, để không lấy phải
  // connection đã chết ở phía server — nguyên nhân lỗi `read ECONNRESET` giữa chừng request.
  idleTimeoutMillis: 10000,
  // Mở connection MỚI tới pooler ap-southeast-1 có lúc mất vài giây; mức 5s cũ quá ngắn nên
  // request hỏng hẳn với `Connection terminated due to connection timeout` (đo được 12/20 lần
  // lỗi khi mạng chập chờn), kéo theo lỗi 500 ở AI Chat vì mỗi câu hỏi chạm DB 6-8 lần.
  connectionTimeoutMillis: 20000,
  // Giữ TCP sống và phát hiện đứt kết nối sớm, thay vì treo tới lúc timeout.
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Lỗi kết nối PostgreSQL pool:', err);
});

export const db = drizzle(pool, { schema });

export { pool };
