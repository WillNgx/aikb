import { Router } from 'express';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { authenticate } from '../../middleware/auth';
import { requireAdmin } from '../../middleware/requireAdmin';
import { validateBody } from '../../middleware/validate';
import { env } from '../../config/env';
import { AppError } from '../../lib/AppError';
import { downloadPublicImage } from './safeFetch';

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

/** Nhận diện định dạng theo chữ ký đầu file (magic bytes); null nếu không phải 4 định dạng cho phép. */
function sniffImageMime(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const head6 = b.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Kiểm tra magic bytes thật của buffer — không tin tưởng mimeType do client/nguồn ngoài tự
 * khai báo (có thể bị giả mạo). Dùng chung cho cả upload trực tiếp lẫn upload từ URL ngoài.
 */
function detectAllowedMime(buffer: Buffer): { mime: string; ext: string } {
  if (buffer.byteLength > MAX_BYTES) {
    throw new AppError(413, 'Image exceeds the 5MB size limit');
  }
  const mime = sniffImageMime(buffer);
  const ext = mime && ALLOWED_MIME[mime];
  if (!mime || !ext) {
    throw new AppError(
      400,
      'File content does not match an allowed image format (PNG, JPEG, WEBP, GIF)'
    );
  }
  return { mime, ext };
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

    const { mime, ext } = detectAllowedMime(buffer);
    const url = await storeImageBuffer(buffer, mime, ext, req.user!.id);
    res.status(201).json({ url });
  } catch (err) {
    // AppError (413/400/500 từ detectAllowedMime/storeImageBuffer) được errorHandler trả về
    // đúng status — không cần bắt riêng ở đây nữa.
    next(err);
  }
});

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
    // Chặn SSRF + giới hạn dung lượng: xem safeFetch.ts (không đi theo redirect, cắt khi quá 5MB).
    const buffer = await downloadPublicImage(parsedUrl, MAX_BYTES);

    const { mime, ext } = detectAllowedMime(buffer);
    const url = await storeImageBuffer(buffer, mime, ext, req.user!.id);
    res.status(201).json({ url });
  } catch (err) {
    // AppError (413/400/500 từ detectAllowedMime/storeImageBuffer) được errorHandler trả về
    // đúng status — không cần bắt riêng ở đây nữa.
    next(err);
  }
});

export default router;
