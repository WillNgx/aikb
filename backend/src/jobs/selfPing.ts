import { env } from '../config/env';

/** Render gói miễn phí cho service ngủ sau 15 phút không có request nào — ping sớm hơn 1 phút. */
const PING_INTERVAL_MS = 14 * 60 * 1000;
const PING_TIMEOUT_MS = 10_000;

/**
 * Tự gọi `/health` của chính mình mỗi 14 phút để Render không cho server ngủ đông.
 *
 * Server ngủ thì request đầu tiên phải chờ ~1 phút để khởi động lại, và nặng hơn là bot Telegram
 * (long polling) ngừng nhận tin hoàn toàn trong lúc ngủ — mà kết nối polling là kết nối ĐI RA, Render
 * không tính nó là "có hoạt động" nên không tự giữ được server thức.
 *
 * BẮT BUỘC gọi qua địa chỉ CÔNG KHAI (`RENDER_EXTERNAL_URL`), không gọi `localhost`: Render chỉ đếm
 * request đi vào qua proxy của nó, gọi nội bộ thì server vẫn bị coi là rảnh và vẫn bị cho ngủ.
 *
 * Chỉ chạy khi có `RENDER_EXTERNAL_URL` — biến này Render tự cấp, nên máy dev và mọi nơi khác tự bỏ
 * qua mà không cần cờ bật/tắt riêng.
 */
export function startSelfPingJob(): void {
  if (!env.RENDER_EXTERNAL_URL) return;

  const url = `${env.RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/health`;

  const ping = () =>
    fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
      .then((res) => {
        if (!res.ok) console.warn(`[SelfPing] ${url} trả về HTTP ${res.status}`);
      })
      // Chỉ log, không ném: ping hụt một lần không phải lỗi của server, lần sau sẽ gọi lại.
      .catch((err) => console.warn('[SelfPing] Không gọi được:', err instanceof Error ? err.message : err));

  // unref(): bộ hẹn giờ này không được là thứ duy nhất giữ tiến trình sống khi tắt server.
  setInterval(ping, PING_INTERVAL_MS).unref();
  console.log(`⏰ Self-ping: gọi ${url} mỗi 14 phút để Render không cho server ngủ.`);
}
