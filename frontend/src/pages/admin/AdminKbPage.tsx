import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { kbApi, useKbList } from '../../api/kb';

/**
 * Quản lý Knowledge Base — chỉ Quản trị hệ thống vào được (chặn ở route và ở backend).
 *
 * Nút "Tạo KB" dựng luôn chỗ chứa dữ liệu cho ngôn ngữ mới, không cần lập trình viên chạy
 * migration (xem `backend/src/modules/kb/kb.admin.service.ts`). KB tạo xong là trống: phải sang
 * KB đó tạo thư mục, nhập bài rồi Đăng thì nội dung mới vào Tìm kiếm và AI Chat.
 */
export default function AdminKbPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: dsKb = [], isLoading } = useKbList();

  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [formError, setFormError] = useState('');
  const [vuaTao, setVuaTao] = useState('');

  const createMutation = useMutation({
    mutationFn: () => kbApi.create({ code: code.trim(), name: name.trim(), systemPrompt }),
    onSuccess: (kb) => {
      // Danh sách KB được dùng ở nút chuyển KB và nhiều trang khác — nạp lại ngay để KB mới
      // xuất hiện mà không phải tải lại trang.
      queryClient.invalidateQueries({ queryKey: ['kb-list'] });
      setShowForm(false);
      setCode(''); setName(''); setSystemPrompt(''); setFormError('');
      setVuaTao(kb.name);
    },
    onError: (err: any) =>
      setFormError(err?.response?.data?.error || t('adminKb.createFailed')),
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 className="page-title">🗂 {t('layout.nav.kb')}</h1>
          <p className="page-subtitle">{t('adminKb.subtitle', { n: dsKb.length })}</p>
        </div>
        <button id="btn-new-kb" className="btn-primary-custom" onClick={() => { setShowForm(!showForm); setVuaTao(''); }}>
          {showForm ? `✕ ${t('common.close')}` : `+ ${t('adminKb.createButton')}`}
        </button>
      </div>

      {vuaTao && (
        <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
          ✅ {vuaTao} — {t('adminKb.emptyNote')}
        </div>
      )}

      {showForm && (
        <div className="card-custom card-section">
          <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '1rem' }}>{t('adminKb.createTitle')}</h3>
          {formError && (
            <div className="alert-box alert-danger" role="alert" style={{ marginBottom: '0.75rem' }}>⚠️ {formError}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label htmlFor="input-kb-code" style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>
                {t('adminKb.code')}
              </label>
              <input id="input-kb-code" className="input-custom" value={code} placeholder="kb_id"
                onChange={(e) => setCode(e.target.value)} />
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted-strong)', margin: '0.375rem 0 0' }}>
                {t('adminKb.codeHint')}
              </p>
            </div>
            <div>
              <label htmlFor="input-kb-name" style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>
                {t('adminKb.name')}
              </label>
              <input id="input-kb-name" className="input-custom" value={name} placeholder={t('adminKb.namePlaceholder')}
                onChange={(e) => setName(e.target.value)} />
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted-strong)', margin: '0.375rem 0 0' }}>
                {t('adminKb.localeNote')}
              </p>
            </div>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <label htmlFor="input-kb-prompt" style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>
              {t('adminKb.systemPrompt')}
            </label>
            <textarea id="input-kb-prompt" className="input-custom" rows={6} value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)} />
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted-strong)', margin: '0.375rem 0 0' }}>
              {t('adminKb.systemPromptHint')}
            </p>
          </div>

          <button id="btn-create-kb" className="btn-primary-custom" style={{ marginTop: '1rem' }}
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !code.trim() || !name.trim()}>
            {createMutation.isPending ? '⏳' : t('adminKb.create')}
          </button>
        </div>
      )}

      <div className="card-custom" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner-custom" style={{ margin: '0 auto' }} /></div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminKb.colCode')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminKb.colName')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminKb.colLocale')}</th>
              </tr>
            </thead>
            <tbody>
              {dsKb.map((kb) => (
                <tr key={kb.code}>
                  <td className="table-custom" style={{ fontFamily: 'monospace' }}>{kb.code}</td>
                  <td className="table-custom" style={{ fontWeight: 500 }}>{kb.name}</td>
                  <td className="table-custom" style={{ color: 'var(--color-text-muted)' }}>{kb.locale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
