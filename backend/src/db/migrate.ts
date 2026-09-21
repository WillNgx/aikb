import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './index';
import path from 'path';

async function runMigrations() {
  console.log('🔄 Đang chạy database migrations...');

  await migrate(db, {
    migrationsFolder: path.join(__dirname, '../../drizzle'),
  });

  console.log('✅ Migration hoàn tất!');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('❌ Migration thất bại:', err);
  pool.end();
  process.exit(1);
});
