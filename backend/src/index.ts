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
// Trên Render request đi qua ĐÚNG 2 lớp proxy: Cloudflare (nối IP thật của client vào
// X-Forwarded-For) rồi tới bộ cân bằng tải của Render (nối tiếp IP của nút Cloudflare). Vì vậy phải
// tin 2 hop thì `req.ip` mới là IP người dùng. Đặt `1` như trước thì `req.ip` là IP nút Cloudflare
// — đã đo trên production 21/09/2026: cùng một máy mà request rơi ngẫu nhiên vào 2 bộ đếm khác
// nhau, tức cả công ty dùng chung vài bộ đếm rate-limit và dễ bị 429 oan.
// KHÔNG đặt `true` (tin mọi hop): khi đó giá trị X-Forwarded-For do chính client tự gửi cũng được
// tin, cho phép giả IP để lách rate-limit. Đổi nơi deploy (thêm/bớt proxy) thì phải đo lại số hop.
app.set('trust proxy', 2);

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

// ─── Health Check ─────────────────────────────────────────────────────────────
// Đặt TRƯỚC rate limiter: health check của Render và job self-ping (jobs/selfPing.ts) gọi route này
// định kỳ từ cùng một IP — bị tính vào giới hạn chung thì có lúc nhận 429, Render tưởng server chết
// và khởi động lại liên tục. Route này không đọc DB, không có gì để lạm dụng.
app.get('/health', (req, res) => {
  // TẠM THỜI — đo số lớp proxy thật trên Render để đặt đúng `trust proxy`. Gỡ ngay sau khi đo.
  if (req.query.diag === '4c64ab29e0a1e5bf') {
    console.log('[DIAG]', JSON.stringify({ xff: req.headers['x-forwarded-for'], cf: req.headers['cf-connecting-ip'], tci: req.headers['true-client-ip'], xri: req.headers['x-real-ip'], ip: req.ip, ips: req.ips, remote: req.socket.remoteAddress }));
  }
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Rate Limiting (global) ───────────────────────────────────────────────────
app.use(generalLimiter);

// ─── Knowledge Base đang phục vụ ──────────────────────────────────────────────
// Mắc TOÀN CỤC và đặt TRƯỚC mọi route: mở ngữ cảnh KB cho toàn bộ chuỗi xử lý phía sau, để
// service không phải luồn thêm tham số kbCode qua hơn 70 điểm truy vấn. Xem middleware/resolveKb.ts.
app.use(resolveKb);

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
