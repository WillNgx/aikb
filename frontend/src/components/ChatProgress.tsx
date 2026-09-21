import { useTranslation } from 'react-i18next';
import type { ChatProgress as ChatProgressData } from '../api';

/**
 * Hiển thị bước xử lý hiện tại của AI Chat, dùng chung cho trang Chat và widget nổi.
 *
 * Tiến trình là THẬT: mỗi bước do backend đẩy về qua SSE khi nó thật sự bắt đầu chạy (xem
 * `ChatProgress` trong `backend/src/modules/ai/ai.service.ts`), không phải chuỗi chữ chạy theo
 * đồng hồ. Nhờ vậy mới hiện được bước "mở rộng tìm kiếm" — bước chỉ thỉnh thoảng xảy ra — và
 * mới được phép hiện con số chunk tìm thấy.
 *
 * `progress = null` là lúc vừa bấm Gửi, chưa nhận event nào: hiện bước đầu tiên cho liền mạch.
 */

// Icon giữ ở đây, CHỮ lấy từ từ điển (`chatProgress.*`) — đổi ngôn ngữ không phải đụng biểu tượng.
const STEP_ICONS: Record<ChatProgressData['step'], string> = {
  understanding: '🔎',
  searching: '📚',
  expanding: '🔁',
  generating: '✍️',
};

interface ChatProgressProps {
  progress: ChatProgressData | null;
}

export default function ChatProgress({ progress }: ChatProgressProps) {
  const { t } = useTranslation();
  const step = progress?.step ?? 'understanding';
  const icon = STEP_ICONS[step];
  const text = t(`chatProgress.${step}`);

  // Số đoạn tài liệu model đang đọc — số THẬT do backend đếm, chỉ có ở bước cuối.
  const chunkNote =
    progress?.step === 'generating' && progress.chunkCount > 0
      ? t('chatProgress.chunks', { count: progress.chunkCount })
      : '';

  return (
    <div className="chat-progress" role="status" aria-live="polite">
      <div className="typing-indicator">
        <span />
        <span />
        <span />
      </div>
      <span className="chat-progress-text">
        <span aria-hidden="true">{icon}</span> {text}
        {chunkNote}
      </span>
    </div>
  );
}
