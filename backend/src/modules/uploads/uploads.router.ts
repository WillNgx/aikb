import { Router } from 'express';
import { z } from 'zod';
import dns from 'node:dns/promises';
import { createClient } from '@supabase/supabase-js';
import { fromBuffer } from 'file-type';
import { authenticate } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import { validateBody } from '../../middleware/validate';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';

const router = Router();
const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const BUCKET = 'kb-images';
const MAX_BYTES = 5 * 1024 * 1024; // 5MB — đủ cho ảnh minh hoạ trong bài viết KB
const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

let bucketEnsured = false;
async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  if (!buckets?.some((b) => b.name === BUCKET)) {
    await supabaseAdmin.storage.createBucket(BUCKET, { public: true, fileSizeLimit: MAX_BYTES });
  }
  bucketEnsured = true;
}

/**
 * Kiểm tra magic bytes thật của buffer — không tin tưởng mimeType do client/nguồn ngoài tự
 * khai báo (có thể bị giả mạo). Dùng chung cho cả upload trực tiếp lẫn upload từ URL ngoài.
 */
async function detectAllowedMime(buffer: Buffer): Promise<{ mime: string; ext: string }> {
  if (buffer.byteLength > MAX_BYTES) {
    throw new AppError(413, 'Image exceeds the 5MB size limit');
  }
  const detected = await fromBuffer(buffer);
  const ext = detected && ALLOWED_MIME[detected.mime];
  if (!detected || !ext) {
    throw new AppError(
      400,
      'File content does not match an allowed image format (PNG, JPEG, WEBP, GIF)'
    );
  }
  return { mime: detected.mime, ext };
}

/** Lưu buffer ảnh đã validate vào Supabase Storage, trả về public URL. */
async function storeImageBuffer(buffer: Buffer, mime: string, ext: string, userId: string): Promise<string> {
  await ensureBucket();
  const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(fileName, buffer, { contentType: mime, upsert: false });
  if (uploadError) {
    throw new AppError(500, `Upload failed: ${uploadError.message}`);
  }
  const { data: publicUrlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(fileName);
  return publicUrlData.publicUrl;
}

const uploadSchema = z.object({
  // data URI: "data:image/png;base64,...."
  imageBase64: z.string().min(1, 'Image data is required'),
});

/**
 * POST /api/uploads/image
 * Upload ảnh minh hoạ (Text+Image MVP scope) qua Supabase Storage — chỉ Admin.
 * Nhận data URI base64, trả về public URL để gắn vào block 'image' trong bài viết.
 */
router.post('/image', authenticate, requireAdmin, validateBody(uploadSchema), async (req, res, next) => {
  try {
    const { imageBase64 } = req.body as { imageBase64: string };

    const match = imageBase64.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);
    if (!match) {
      res.status(400).json({ error: 'Invalid image format (expected a base64 data URI)' });
      return;
    }
    const [, , base64Data] = match;
    const buffer = Buffer.from(base64Data, 'base64');

    const { mime, ext } = await detectAllowedMime(buffer);
    const url = await storeImageBuffer(buffer, mime, ext, req.user!.id);
    res.status(201).json({ url });
  } catch (err) {
    // AppError (413/400/500 từ detectAllowedMime/storeImageBuffer) được errorHandler trả về
    // đúng status — không cần bắt riêng ở đây nữa.
    next(err);
  }
});

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local + cloud metadata endpoint
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd00:/i,
];

function isPrivateAddress(host: string): boolean {
  return PRIVATE_HOSTNAME_PATTERNS.some((p) => p.test(host));
}

/**
 * Chặn SSRF — chỉ cho phép http(s) tới host công khai, không cho trỏ vào mạng nội bộ.
 *
 * Kiểm tra cả hostname LẪN địa chỉ IP mà nó thực sự resolve ra. Chỉ so hostname (như trước) là
 * không đủ: một domain công khai bình thường vẫn có thể trỏ DNS sang 127.0.0.1/169.254.169.254
 * (DNS rebinding) để lách qua chuỗi regex vốn chỉ nhận diện IP viết trực tiếp trong URL.
 */
async function isSafeExternalUrl(url: URL): Promise<boolean> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (isPrivateAddress(url.hostname)) return false;

  try {
    const records = await dns.lookup(url.hostname, { all: true });
    return records.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false; // Không resolve được thì chặn luôn, an toàn hơn là cho qua
  }
}

const uploadFromUrlSchema = z.object({
  imageUrl: z.string().url('Invalid image URL'),
});

/**
 * POST /api/uploads/from-url
 * Tải ảnh từ 1 URL bên ngoài (VD: dán ảnh copy từ website khác vào editor) rồi lưu lại vào
 * Supabase Storage — chỉ Admin. Tải ở backend để tránh CORS khi fetch thẳng từ trình duyệt,
 * và để ảnh dán từ web khác cũng được lưu bản riêng thay vì hotlink URL gốc (dễ vỡ nếu site
 * nguồn đổi/xoá/chặn hotlink).
 */
router.post('/from-url', authenticate, requireAdmin, validateBody(uploadFromUrlSchema), async (req, res, next) => {
  try {
    const { imageUrl } = req.body as { imageUrl: string };

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      res.status(400).json({ error: 'Invalid image URL' });
      return;
    }
    if (!(await isSafeExternalUrl(parsedUrl))) {
      res.status(400).json({ error: 'Image URL not allowed (only http/https to public hosts)' });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      // Nhiều site chặn request không có User-Agent giống trình duyệt thật (coi là bot).
      // redirect: 'manual' — KHÔNG tự đi theo 3xx: URL gốc đã qua kiểm SSRF, nhưng URL đích
      // redirect thì chưa, site nguồn có thể lợi dụng để trỏ sang mạng nội bộ. `!response.ok`
      // bên dưới coi 3xx là lỗi nên chặn được, không cần thêm nhánh riêng.
      response = await fetch(parsedUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InternalKB-ImageFetch/1.0)' },
      });
    } catch {
      res.status(400).json({ error: 'Could not download the image from the given URL (the source site may block access)' });
      return;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      res.status(400).json({ error: `Could not download the image from the given URL (HTTP ${response.status})` });
      return;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { mime, ext } = await detectAllowedMime(buffer);
    const url = await storeImageBuffer(buffer, mime, ext, req.user!.id);
    res.status(201).json({ url });
  } catch (err) {
    // AppError (413/400/500 từ detectAllowedMime/storeImageBuffer) được errorHandler trả về
    // đúng status — không cần bắt riêng ở đây nữa.
    next(err);
  }
});

export default router;
