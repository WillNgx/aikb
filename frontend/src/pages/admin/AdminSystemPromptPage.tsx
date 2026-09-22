import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  AI_TEXT_KEYS,
  defaultChatText,
  kbApi,
  type AiTextKey,
  type AiTexts,
  type KbPromptFields,
  type KbSystemPrompt,
} from '../../api/kb';

/**
 * System prompt của từng Knowledge Base.
 *
 * Mọi quản trị đều XEM được prompt của mọi KB, nhưng chỉ SỬA được KB mình phụ trách (Quản trị hệ
 * thống thì sửa được hết). Cờ `canEdit` do backend trả về — giao diện chỉ dùng để khoá ô nhập,
 * quyền thật vẫn chốt ở API.
 *
 * Cùng một thẻ còn có câu chào mở đầu khung chat và các câu AI trả lời sẵn (không tìm thấy, hỏi lại
 * chọn sảnh…): mỗi thị trường tự viết bằng ngôn ngữ của mình.
 */

type FieldKey = 'systemPrompt' | 'chatGreeting' | AiTextKey;
const FIELDS: FieldKey[] = ['systemPrompt', 'chatGreeting', ...AI_TEXT_KEYS];

/** Chỗ chèn giá trị trong câu — hiện ở dòng gợi ý để Admin biết phải giữ lại. */
const PLACEHOLDERS: Partial<Record<AiTextKey, string>> = {
  clarify: '{{topic}}',
  providerNote: '{{provider}}',
};

function serverValue(kb: KbSystemPrompt, k: FieldKey): string {
  if (k === 'systemPrompt') return kb.systemPrompt;
  if (k === 'chatGreeting') return kb.chatGreeting ?? '';
  return kb.aiTexts?.[k] ?? '';
}

export default function AdminSystemPromptPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: items = [], isLoading } = useQuery<KbSystemPrompt[]>({
    queryKey: ['kb-system-prompts'],
    queryFn: kbApi.listSystemPrompts,
  });

  // Bản nháp đang gõ, theo từng KB và từng ô. Chỉ giữ ô nào người dùng đã chạm vào — ô chưa sửa
  // thì lấy thẳng giá trị từ server, nhờ vậy lưu xong một KB không làm mất nội dung đang gõ ở KB khác.
  const [draft, setDraft] = useState<Record<string, Partial<Record<FieldKey, string>>>>({});
  const [luuXong, setLuuXong] = useState('');
  const [loi, setLoi] = useState('');

  const value = (kb: KbSystemPrompt, k: FieldKey) => draft[kb.code]?.[k] ?? serverValue(kb, k);
  const setValue = (code: string, k: FieldKey, v: string) =>
    setDraft((d) => ({ ...d, [code]: { ...d[code], [k]: v } }));

  const saveMutation = useMutation({
    mutationFn: ({ code, data }: { code: string; data: KbPromptFields }) => kbApi.saveSystemPrompt(code, data),
    onSuccess: (_data, bien) => {
      setLoi('');
      setLuuXong(bien.code);
      setDraft((d) => {
        const moi = { ...d };
        delete moi[bien.code];
        return moi;
      });
      queryClient.invalidateQueries({ queryKey: ['kb-system-prompts'] });
      // Khung chat đọc câu chào từ danh sách KB — làm mới để câu chào mới hiện ngay
      queryClient.invalidateQueries({ queryKey: ['kb-list'] });
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
        const daDoi = FIELDS.some((k) => value(kb, k) !== serverValue(kb, k));
        const luu = () =>
          saveMutation.mutate({
            code: kb.code,
            data: {
              systemPrompt: value(kb, 'systemPrompt'),
              chatGreeting: value(kb, 'chatGreeting'),
              aiTexts: Object.fromEntries(AI_TEXT_KEYS.map((k) => [k, value(kb, k)])) as AiTexts,
            },
          });

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
              value={value(kb, 'systemPrompt')}
              disabled={!kb.canEdit}
              placeholder={t('adminPrompt.placeholder')}
              onChange={(e) => setValue(kb.code, 'systemPrompt', e.target.value)}
            />

            <label htmlFor={`greeting-${kb.code}`} className="input-label" style={{ marginTop: '1rem' }}>
              {t('adminPrompt.greetingLabel')}
            </label>
            <textarea
              id={`greeting-${kb.code}`}
              className="input-custom"
              rows={2}
              maxLength={1000}
              value={value(kb, 'chatGreeting')}
              disabled={!kb.canEdit}
              placeholder={defaultChatText(kb.locale, 'greeting')}
              onChange={(e) => setValue(kb.code, 'chatGreeting', e.target.value)}
            />
            <p className="field-hint">{t('adminPrompt.greetingHint')}</p>

            {/* Gập sẵn: ít khi phải sửa, mở hết ra thì mỗi thẻ KB dài gấp đôi */}
            <details style={{ marginTop: '1rem' }}>
              <summary className="input-label" style={{ display: 'list-item', cursor: 'pointer' }}>
                {t('adminPrompt.aiTextsTitle')}
              </summary>
              <p className="field-hint">{t('adminPrompt.aiTextsDesc')}</p>
              {AI_TEXT_KEYS.map((k) => (
                <div key={k} style={{ marginTop: '0.75rem' }}>
                  <label htmlFor={`${k}-${kb.code}`} className="input-label">
                    {t(`adminPrompt.aiText.${k}`)}
                  </label>
                  <textarea
                    id={`${k}-${kb.code}`}
                    className="input-custom"
                    rows={k === 'compareAll' ? 1 : 3}
                    maxLength={k === 'compareAll' ? 100 : 1000}
                    value={value(kb, k)}
                    disabled={!kb.canEdit}
                    placeholder={kb.aiTextDefaults?.[k]}
                    onChange={(e) => setValue(kb.code, k, e.target.value)}
                  />
                  {PLACEHOLDERS[k] && (
                    <p className="field-hint">
                      {t(`adminPrompt.aiTextHint.${k}`, { placeholder: PLACEHOLDERS[k] })}
                    </p>
                  )}
                </div>
              ))}
            </details>

            {kb.canEdit && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem' }}>
                <button
                  className="btn-primary-custom"
                  disabled={!daDoi || saveMutation.isPending}
                  onClick={luu}
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
