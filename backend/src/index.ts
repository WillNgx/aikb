import './config/env'; // Load & validate env TRƯỚC mọi thứ
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { generalLimiter } from './middleware/rateLimiter';
import { resolveKb } from './middleware/resolveKb';
import { errorHandler } from './middleware/errorHandler';

// Routers
import authRouter from './modules/auth/auth.router';
import aiRouter from './modules/ai/ai.router';
import adminRouter from './modules/admin/admin.router';
import slangRouter from './modules/admin/slang.router';
import reindexRouter from './modules/indexing/indexing.router';
import nodesRouter from './modules/nodes/nodes.router';
import publishAllRouter from './modules/nodes/publishAll.router';
import uploadsRouter from './modules/uploads/uploads.router';
import telegramRouter from './modules/telegram/telegram.router';
import tokenUsageRouter from './modules/tokenUsage/tokenUsage.router';
import promotionsRouter from './modules/promotions/promotions.router';
import promotionsAdminRouter from './modules/promotions/promotionsAdmin.router';
import kbRouter from './modules/kb/kb.router';
import { startAuditRetentionJob } from './jobs/auditRetention';
import { startTokenUsageRetentionJob } from './jobs/tokenUsageRetention';
import { startSelfPingJob } from './jobs/selfPing';
import { startTelegramBot } from './modules/telegram/telegram.bot';


const app = express();

// ─── Reverse Proxy ────────────────────────────────────────────────────────────
// Tin đúng 1 hop proxy phía trước (Render/Railway/Cloudflare khi deploy production). Thiếu dòng
// này thì `req.ip` luôn là IP của proxy chứ không phải IP thật của client — mọi người dùng bị
// tính chung một bucket rate-limit. Đặt `1`, KHÔNG đặt `true` (tin mọi hop): `true` sẽ tin luôn
// header `X-Forwarded-For` do chính client tự gửi, cho phép giả IP để lách rate-limit.
app.set('trust proxy', 1);

// ─── Security Headers ────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // 'X-KB' bắt buộc phải có mặt ở đây: trình duyệt CHẶN header tuỳ chỉnh không được liệt kê
    // trong preflight, và khi bị chặn thì request rơi về KB mặc định — tức người dùng đang xem
    // ENKB lại nhận dữ liệu tiếng Việt, đúng kiểu lỗi âm thầm cần tránh.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-KB'],
  })
);

// ─── Body Parser ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '8mb' })); // TipTap JSON + ảnh base64 (upload) có thể lớn
app.use(express.urlencoded({ extended: true }));

// ─── Rate Limiting (global) ───────────────────────────────────────────────────
app.use(generalLimiter);

// ─── Knowledge Base đang phục vụ ──────────────────────────────────────────────
// Mắc TOÀN CỤC và đặt TRƯỚC mọi route: mở ngữ cảnh KB cho toàn bộ chuỗi xử lý phía sau, để
// service không phải luồn thêm tham số kbCode qua hơn 70 điểm truy vấn. Xem middleware/resolveKb.ts.
app.use(resolveKb);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);
app.use('/api/ai', aiRouter);
app.use('/api/admin', adminRouter);
app.use('/api/admin/slang', slangRouter);
app.use('/api/admin/reindex', reindexRouter);
app.use('/api/admin/publish-all', publishAllRouter);
app.use('/api/nodes', nodesRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/admin/telegram', telegramRouter);
app.use('/api/admin/token-usage', tokenUsageRouter);
app.use('/api/admin/promotions', promotionsAdminRouter);
app.use('/api/promotions', promotionsRouter);
app.use('/api/kb', kbRouter);


// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint không tồn tại' });
});

// ─── Global Error Handler (phải cuối cùng) ───────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  console.log(`🚀 Backend đang chạy tại http://localhost:${env.PORT}`);
  console.log(`   Môi trường: ${env.NODE_ENV}`);
  console.log(`   CORS cho: ${env.FRONTEND_URL}`);
});

// ─── Background Jobs ──────────────────────────────────────────────────────────
startAuditRetentionJob(); // DEC-09: dọn audit log quá 6 tháng
startTokenUsageRetentionJob(); // dọn thống kê token quá 12 tháng
startSelfPingJob(); // giữ server Render gói miễn phí không ngủ đông — chỉ chạy trên Render
// Bot Telegram — tự bỏ qua nếu chưa cấu hình TELEGRAM_BOT_TOKEN. Bọc try/catch để lỗi khởi
// động bot không bao giờ làm sập API web đang chạy chung tiến trình.
try {
  startTelegramBot();
} catch (err) {
  console.error('[Telegram] Bỏ qua bot do lỗi khởi động:', err);
}

export default app;
