import fs from 'fs';
import path from 'path';
import express, { type Express } from 'express';
import type { HelmetOptions } from 'helmet';
import { env } from './config/env';

// Chế độ "BE phục vụ luôn FE" (bật bằng SERVE_FRONTEND=true). Mặc định TẮT: FE vẫn chạy riêng ở
// Vercel và BE chỉ trả API như trước. Bật khi mạng công ty chặn domain Vercel — FE và API cùng
// một origin nên không cần CORS, build FE với VITE_API_URL=/api.

// frontend/dist nằm cạnh backend/ (đúng cả khi chạy src/ bằng tsx lẫn dist/ sau khi build).
const FRONTEND_DIST = path.resolve(__dirname, '../../frontend/dist');

/** CSP cho trang FE — phải khớp với `headers` trong vercel.json (giữ hai nơi đồng bộ). */
export function frontendHelmetOptions(): HelmetOptions {
  return {
    contentSecurityPolicy: {
      // useDefaults:false để khỏi dính `upgrade-insecure-requests` khi thử trên http://localhost.
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", new URL(env.SUPABASE_URL).origin],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  };
}

/**
 * Phục vụ file build của FE + trả `index.html` cho mọi đường dẫn giao diện (React Router).
 * Gọi SAU `/health` và TRƯỚC rate limiter / resolveKb: file tĩnh không cần ngữ cảnh KB và một
 * lần mở trang tải hàng chục file, tính vào giới hạn chung là dễ dính 429 oan.
 */
export function serveFrontend(app: Express): void {
  const indexFile = path.join(FRONTEND_DIST, 'index.html');
  if (!fs.existsSync(indexFile)) {
    console.error(`❌ SERVE_FRONTEND=true nhưng chưa có bản build FE tại ${FRONTEND_DIST} (chạy "npm run build" ở frontend/ với VITE_API_URL=/api).`);
    process.exit(1);
  }

  app.use(
    express.static(FRONTEND_DIST, {
      index: false,
      // File trong /assets do Vite đặt tên theo hash nội dung → cache vô hạn được.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  app.get('*', (req, res, next) => {
    // /api/* chưa khớp route nào thì để 404 JSON, file có đuôi mà không tồn tại cũng vậy.
    if (req.path.startsWith('/api/') || path.extname(req.path)) return next();
    res.setHeader('Cache-Control', 'no-cache'); // index.html trỏ tới bản build mới nhất
    res.sendFile(indexFile);
  });

  console.log(`   Phục vụ giao diện từ ${FRONTEND_DIST}`);
}
