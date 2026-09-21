import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Nút "về đầu trang" cho bài viết dài.
 *
 * Mục lục chỉ hiện từ 992px trở lên, nên trên tablet/điện thoại người đọc phải vuốt ngược
 * rất lâu để quay lại đầu bài. Nút chỉ xuất hiện sau khi đã cuộn xuống một quãng, tránh
 * che nội dung khi chưa cần.
 *
 * Vị trí nằm NGAY TRÊN nút nổi "Hỏi AI" (bottom 2rem) để hai nút không chồng lên nhau.
 */
const NGUONG_HIEN = 400; // px — cuộn quá mức này mới hiện nút

export default function BackToTopButton() {
  const { t } = useTranslation();
  const [hien, setHien] = useState(false);

  useEffect(() => {
    const onScroll = () => setHien(window.scrollY > NGUONG_HIEN);
    onScroll(); // tính ngay lần đầu, phòng khi trang mở ra đã ở giữa bài (link tới #heading)
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!hien) return null;

  const lenDau = () => {
    // Tôn trọng thiết lập "giảm chuyển động" của hệ điều hành — CSS scroll-behavior không
    // chi phối được lệnh cuộn bằng JS nên phải tự kiểm tra.
    const giamChuyenDong = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: giamChuyenDong ? 'auto' : 'smooth' });
  };

  return (
    <button type="button" className="back-to-top-btn" onClick={lenDau} aria-label={t('backToTop.label')} title={t('backToTop.label')}>
      ↑
    </button>
  );
}
