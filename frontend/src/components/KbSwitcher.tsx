import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { useKbList } from '../api/kb';
import { getActiveKb, setActiveKb } from '../lib/kb';
import { syncUiLocale } from '../lib/i18n';

/**
 * Chuyển giữa các Knowledge Base (mỗi ngôn ngữ một KB: VNKB, ENKB, INDKB...).
 *
 * Đổi KB là đổi TOÀN BỘ ngữ cảnh làm việc: cây tài liệu, khuyến mãi, AI Chat. Vì vậy bắt buộc
 * phải XOÁ SẠCH cache của React Query — nếu không, cây tài liệu tiếng Việt vừa xem sẽ còn nằm
 * đó vài phút sau khi đã chuyển sang KB tiếng Anh, và người dùng không có cách nào biết mình
 * đang nhìn dữ liệu của KB nào.
 *
 * Chỉ hiện khi có từ 2 KB trở lên — hệ thống một ngôn ngữ thì nút này chỉ là nhiễu.
 */
export default function KbSwitcher() {
  const { t } = useTranslation();
  const { data: ds = [] } = useKbList();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const hienTai = getActiveKb();

  if (ds.length < 2) return null;

  const doi = (code: string) => {
    if (code === hienTai) return;
    setActiveKb(code);
    // Nút EN/VI chỉ có ở VNKB, KB khác giao diện luôn tiếng Anh — áp lại ngay (xem lib/i18n.ts).
    void syncUiLocale();
    // Xoá sạch cache: mọi dữ liệu đang giữ đều thuộc KB cũ.
    queryClient.clear();
    // Về trang danh sách tài liệu — id bài viết của KB cũ không tồn tại ở KB mới.
    navigate('/documents');
  };

  return (
    <div className="kb-picker">
      <label htmlFor="kb-picker-select" className="kb-picker-label">
        {t('kb.picker')}
      </label>
      <select
        id="kb-picker-select"
        className="kb-picker-select"
        value={hienTai}
        onChange={(e) => doi(e.target.value)}
      >
        {ds.map((kb) => (
          <option key={kb.code} value={kb.code}>
            {kb.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Nhắc người dùng khi đang làm việc trên KB KHÔNG phải KB mặc định của tài khoản mình.
 *
 * Cố ý chỉ CẢNH BÁO chứ không chặn: theo quyết định của chủ dự án, mọi tài khoản đọc và ghi
 * được trên mọi KB. Nhưng Admin của ENKB sửa nhầm bài tiếng Việt mà không đọc được nội dung
 * mình vừa sửa là rủi ro có thật, nên ít nhất phải cho họ thấy rõ mình đang ở đâu.
 */
export function KbContextBanner({ defaultKb }: { defaultKb: string }) {
  const { data: ds = [] } = useKbList();
  const hienTai = getActiveKb();

  if (ds.length < 2 || hienTai === defaultKb) return null;

  const ten = ds.find((k) => k.code === hienTai)?.name ?? hienTai;
  const tenMacDinh = ds.find((k) => k.code === defaultKb)?.name ?? defaultKb;

  return (
    <div className="kb-context-banner" role="status">
      {/* Dùng <Trans> chứ không ghép chuỗi: câu này có thẻ <b> nằm GIỮA câu, mà trật tự từ giữa
          các ngôn ngữ khác nhau — ghép tay sẽ ra câu sai ngữ pháp ở ngôn ngữ thứ ba. */}
      <Trans i18nKey="kb.banner" values={{ kb: ten, defaultKb: tenMacDinh }} components={{ b: <b /> }} />
    </div>
  );
}
