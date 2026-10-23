import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { AppError } from '../../lib/AppError';

/**
 * Tải ảnh từ URL ngoài mà không để backend bị lợi dụng gọi vào mạng nội bộ (SSRF) hay bị đầy RAM.
 *
 * Ba lớp chặn, thiếu lớp nào cũng có đường lách:
 *  1. Host viết thẳng bằng IP (kể cả dạng lạ như 2130706433, 0x7f.1 — URL đã chuẩn hoá về a.b.c.d)
 *     bị kiểm ngay ở `assertPublicUrl`, vì Node không gọi `lookup` cho IP viết sẵn.
 *  2. Host là tên miền thì kiểm NGAY LÚC KẾT NỐI qua `safeLookup`: chính địa chỉ đã kiểm là địa chỉ
 *     được nối tới. Kiểm trước rồi để thư viện resolve lại lần nữa (như bản cũ) là hở cho DNS
 *     rebinding: lần 1 trả IP công khai, lần 2 trả 127.0.0.1.
 *  3. Không đi theo redirect (3xx là lỗi) và đọc theo luồng, quá giới hạn byte thì cắt ngay —
 *     bản cũ tải hết body vào RAM rồi mới kiểm 5MB.
 */

const BLOCKED = new net.BlockList();

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "mạng này", gồm 0.0.0.0
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT, nội bộ nhà mạng / một số cloud
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + endpoint metadata của cloud
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // dành riêng + broadcast
];
for (const [addr, prefix] of BLOCKED_V4) BLOCKED.addSubnet(addr, prefix, 'ipv4');

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique-local, gồm cả fd12:... (bản cũ chỉ chặn đúng tiền tố fd00:)
  ['fe80::', 10],
  ['ff00::', 8],
];
for (const [addr, prefix] of BLOCKED_V6) BLOCKED.addSubnet(addr, prefix, 'ipv6');

/** Đổi IPv6 dạng nén (đã chuẩn hoá bởi URL) thành 16 byte. */
function ipv6ToBytes(ip: string): number[] {
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

/**
 * true nếu `ip` (chuỗi IP thuần, không ngoặc vuông) thuộc dải nội bộ/đặc biệt.
 *
 * Hai dải IPv6 "nhúng IPv4" được xử lý riêng, KHÔNG đưa vào BlockList:
 *  - IPv4-mapped `::ffff:a.b.c.d`: chặn cả dải (loopback đội lốt IPv6). Nếu thêm vào BlockList thì
 *    Node đem địa chỉ IPv4 so với luật này qua dạng mapped và chặn nhầm MỌI IPv4 công khai.
 *  - NAT64 `64:ff9b::/96`: mạng dùng DNS64 (một số ISP, mạng di động, máy dev) trả về dạng này cho
 *    tên miền chỉ có IPv4, nên chặn cả dải là hỏng việc tải ảnh từ những site đó. Thay vào đó lấy
 *    IPv4 nhúng ở 32 bit cuối ra kiểm theo luật IPv4 (64:ff9b::7f00:1 vẫn bị chặn vì là 127.0.0.1).
 */
export function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true; // không phải IP hợp lệ thì chặn cho chắc
  if (family === 4) return BLOCKED.check(ip, 'ipv4');

  // Chuẩn hoá qua URL để bắt cả dạng viết dài (0:0:0:0:0:ffff:7f00:1) và chữ hoa.
  const gon = new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase();
  if (gon.startsWith('::ffff:')) return true;
  if (gon.startsWith('64:ff9b::')) {
    const b = ipv6ToBytes(gon);
    return BLOCKED.check(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`, 'ipv4');
  }
  return BLOCKED.check(ip, 'ipv6');
}

/** Hàm resolve thay cho mặc định: từ chối nếu BẤT KỲ địa chỉ nào của tên miền là nội bộ. */
const safeLookup = ((hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) {
      return callback(new Error('Blocked address'), '', 0);
    }
    if (options.all) return callback(null, list as never);
    callback(null, list[0].address, list[0].family);
  });
}) as net.LookupFunction;

export function assertPublicUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'Image URL not allowed (only http/https to public hosts)');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new AppError(400, 'Image URL not allowed (only http/https to public hosts)');
  }
  if (net.isIP(host) !== 0 && isBlockedIp(host)) {
    throw new AppError(400, 'Image URL not allowed (only http/https to public hosts)');
  }
}

const DOWNLOAD_FAILED =
  'Could not download the image from the given URL (the source site may block access)';

/**
 * Tải `url` về Buffer, tối đa `maxBytes`. Ném AppError 400/413 khi bị chặn, lỗi mạng, không phải
 * HTTP 200 (kể cả redirect) hoặc quá lớn / quá chậm.
 */
export async function downloadPublicImage(url: URL, maxBytes: number, timeoutMs = 15_000): Promise<Buffer> {
  assertPublicUrl(url);

  return new Promise<Buffer>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };

    const req = lib.get(
      url,
      {
        lookup: safeLookup,
        // Nhiều site chặn request không có User-Agent giống trình duyệt thật (coi là bot).
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InternalKB-ImageFetch/1.0)' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.resume();
          return finish(() =>
            reject(new AppError(400, `Could not download the image from the given URL (HTTP ${status})`)),
          );
        }

        const tooBig = (): void =>
          finish(() => {
            req.destroy();
            reject(new AppError(413, 'Image exceeds the 5MB size limit'));
          });
        if (Number(res.headers['content-length']) > maxBytes) return tooBig();

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) return tooBig();
          chunks.push(chunk);
        });
        res.on('end', () => finish(() => resolve(Buffer.concat(chunks))));
        res.on('error', () => finish(() => reject(new AppError(400, DOWNLOAD_FAILED))));
      },
    );

    // Hạn tổng, không chỉ hạn "im lặng": nguồn nhỏ giọt từng byte vẫn bị cắt.
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('error', () => finish(() => reject(new AppError(400, DOWNLOAD_FAILED))));
  });
}
