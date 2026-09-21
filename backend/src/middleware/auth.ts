import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

// Supabase admin client — chỉ dùng ở BE, không bao giờ ra FE
const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

export interface AuthUser {
  id: string;
  email: string;
  role: 'super_admin' | 'admin' | 'user';
  enabled: boolean;
  /**
   * KB mà tài khoản này THUỘC VỀ. Mang hai ý nghĩa tuỳ vai trò:
   *   - Mọi vai trò: KB mở sẵn sau khi đăng nhập.
   *   - Riêng `admin` (Quản trị KB): đây cũng là KB DUY NHẤT họ được sửa — xem `requireAdmin.ts`.
   *
   * Đọc vẫn mở cho mọi KB với mọi vai trò. KB thực sự đang phục vụ request lấy từ
   * `middleware/resolveKb.ts` (header `X-KB`), không phải từ cột này.
   */
  defaultKb: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Middleware xác thực Supabase JWT từ Authorization header.
 * Gắn req.user nếu token hợp lệ và user enabled.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Thiếu token xác thực' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    // Verify JWT với Supabase
    const { data: { user: supabaseUser }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !supabaseUser) {
      res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
      return;
    }

    // Lấy role + enabled từ bảng users của app
    const [appUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, supabaseUser.id))
      .limit(1);

    if (!appUser) {
      res.status(401).json({ error: 'Tài khoản không tồn tại trong hệ thống' });
      return;
    }

    if (!appUser.enabled) {
      res.status(403).json({ error: 'Tài khoản đã bị vô hiệu hóa' });
      return;
    }

    req.user = {
      id: appUser.id,
      email: appUser.email,
      role: appUser.role,
      enabled: appUser.enabled,
      defaultKb: appUser.defaultKb,
    };

    next();
  } catch (err) {
    console.error('Lỗi xác thực:', err);

    // Lỗi kết nối DB/Supabase là lỗi tạm thời (mạng chập chờn, pooler đóng connection) chứ không
    // phải bug — trả 503 để client biết là nên thử lại, thay vì 500 chung chung khiến mọi sự cố
    // mạng đều trông giống lỗi server.
    if (isTransientConnectionError(err)) {
      res.status(503).json({ error: 'Hệ thống đang bận, vui lòng thử lại sau giây lát.' });
      return;
    }

    res.status(500).json({ error: 'Lỗi máy chủ khi xác thực' });
  }
}

/**
 * Nhận diện lỗi kết nối tạm thời tới PostgreSQL/Supabase (đứt TCP, timeout khi mở connection,
 * pooler ngắt kết nối). Dùng để phân biệt với lỗi logic thật sự của server.
 */
function isTransientConnectionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', '08000', '08003', '08006', '57P01'].includes(code)) {
    return true;
  }

  const message = (err as { message?: string } | null)?.message?.toLowerCase() ?? '';
  return (
    message.includes('connection terminated') ||
    message.includes('connection timeout') ||
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('econnreset') ||
    message.includes('fetch failed')
  );
}
