import { useTranslation } from 'react-i18next';
import type { AiAnswerImage } from '../api';

/** Ảnh minh hoạ kèm câu trả lời AI — lấy từ chính các bài được trích dẫn. Bấm để xem ảnh gốc ở tab mới. */
export default function ChatImages({ images }: { images: AiAnswerImage[] }) {
  const { t } = useTranslation();
  return (
    <div className="chat-images">
      <div className="citations-label">🖼️ {t('chat.images')}</div>
      <div className="chat-images-grid">
        {images.map((img) => (
          <a key={img.src} href={img.src} target="_blank" rel="noopener noreferrer" className="chat-image-link">
            <img src={img.src} alt={img.alt || img.contentTitle} loading="lazy" />
          </a>
        ))}
      </div>
    </div>
  );
}
