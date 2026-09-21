import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { kbApi, type KbSystemPrompt } from '../../api/kb';

/**
 * System prompt của từng Knowledge Base.
 *
 * Mọi quản trị đều XEM được prompt của mọi KB, nhưng chỉ SỬA được KB mình phụ trách (Quản trị hệ
 * thống thì sửa được hết). Cờ `canEdit` do backend trả về — giao diện chỉ dùng để khoá ô nhập,
 * quyền thật vẫn chốt ở API.
 */
export default function AdminSystemPromptPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: items = [], isLoading } = useQuery<KbSystemPrompt[]>({
    queryKey: ['kb-system-prompts'],
    queryFn: kbApi.listSystemPrompts,
  });

  // Bản nháp đang gõ, theo từng KB. Chỉ giữ KB nào người dùng đã chạm vào — KB chưa sửa thì lấy
  // thẳng giá trị từ server, nhờ vậy lưu xong một KB không làm mất nội dung đang gõ ở KB khác.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [luuXong, setLuuXong] = useState('');
  const [loi, setLoi] = useState('');

  const saveMutation = useMutation({
    mutationFn: ({ code, prompt }: { code: string; prompt: string }) =>
      kbApi.saveSystemPrompt(code, prompt),
    onSuccess: (_data, bien) => {
      setLoi('');
      setLuuXong(bien.code);
      setDraft((d) => {
        const moi = { ...d };
        delete moi[bien.code];
        return moi;
      });
      queryClient.invalidateQueries({ queryKey: ['kb-system-prompts'] });
    },
    onError: (err: any) => {
      setLuuXong('');
      setLoi(err?.response?.data?.error || t('adminPrompt.saveFailed'));
    },
  });

  if (isLoading) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner-custom" style={{ margin: '0 auto' }} /></div>;
  }

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title">💬 {t('layout.nav.systemPrompt')}</h1>
        <p className="page-subtitle">{t('adminPrompt.subtitle')}</p>
      </div>

      {loi && (
        <div className="alert-box alert-danger" role="alert" style={{ marginBottom: '1rem' }}>⚠️ {loi}</div>
      )}

      {items.map((kb) => {
        const giaTri = draft[kb.code] ?? kb.systemPrompt;
        const daDoi = draft[kb.code] !== undefined && draft[kb.code] !== kb.systemPrompt;

        return (
          <div key={kb.code} className="card-custom card-section" style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.75rem' }}>
              <h3 style={{ fontWeight: 600, margin: 0, fontSize: '1rem' }}>
                {kb.name} <span style={{ fontFamily: 'monospace', fontWeight: 400, color: 'var(--color-text-muted)' }}>({kb.code})</span>
              </h3>
              {!kb.canEdit && (
                <span className="status-badge unpublished">{t('adminPrompt.readOnly')}</span>
              )}
            </div>

            {kb.isDefault && (
              <div className="alert-box alert-warning" role="status" style={{ marginBottom: '0.75rem' }}>
                {kb.locale === 'vi' ? t('adminPrompt.usingDefault') : t('adminPrompt.localeWarning')}
              </div>
            )}

            <textarea
              id={`prompt-${kb.code}`}
              className="input-custom"
              rows={10}
              value={giaTri}
              disabled={!kb.canEdit}
              placeholder={t('adminPrompt.placeholder')}
              onChange={(e) => setDraft((d) => ({ ...d, [kb.code]: e.target.value }))}
            />

            {kb.canEdit && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem' }}>
                <button
                  className="btn-primary-custom"
                  disabled={!daDoi || saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ code: kb.code, prompt: giaTri })}
                >
                  {saveMutation.isPending ? '⏳' : t('adminPrompt.save')}
                </button>
                {luuXong === kb.code && !daDoi && (
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted-strong)' }} role="status">
                    ✅ {t('adminPrompt.saved')}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
