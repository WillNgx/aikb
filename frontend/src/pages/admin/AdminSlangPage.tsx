import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { slangApi } from '../../api';
import { useConfirm } from '../../components/ConfirmModal';

interface SlangEntry {
  id: string;
  slangTerm: string;
  normalizedEntity: string;
  targetType: 'provider' | 'bet_type' | 'platform' | 'category' | 'general';
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

// Nhãn giữ khoá dịch, đổi thành chữ lúc render.
const TYPE_LABELS: Record<string, { labelKey: string; icon: string }> = {
  provider: { labelKey: 'adminSlang.types.provider', icon: '🏢' },
  bet_type: { labelKey: 'adminSlang.types.betType', icon: '🎲' },
  platform: { labelKey: 'adminSlang.types.platform', icon: '📱' },
  category: { labelKey: 'adminSlang.types.category', icon: '📂' },
  general: { labelKey: 'adminSlang.types.general', icon: '🔤' },
};

const EMPTY_FORM = {
  slangTerm: '',
  normalizedEntity: '',
  targetType: 'general' as SlangEntry['targetType'],
  notes: '',
  isActive: true,
};

export default function AdminSlangPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  const { data: entries = [], isLoading } = useQuery<SlangEntry[]>({
    queryKey: ['admin-slang', typeFilter, search],
    queryFn: () => slangApi.list({ type: typeFilter, search: search || undefined }),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-slang'] });

  const createMutation = useMutation({
    mutationFn: () => slangApi.create(form),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: any) => setFormError(err?.response?.data?.error || t('adminSlang.createFailed')),
  });

  const updateMutation = useMutation({
    mutationFn: () => slangApi.update(editingId!, form),
    onSuccess: () => {
      invalidate();
      closeForm();
    },
    onError: (err: any) => setFormError(err?.response?.data?.error || t('adminSlang.updateFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => slangApi.delete(id),
    onSuccess: invalidate,
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => slangApi.update(id, { isActive }),
    onSuccess: invalidate,
  });

  const openCreateForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
    setShowForm(true);
  };

  const openEditForm = (entry: SlangEntry) => {
    setEditingId(entry.id);
    setForm({
      slangTerm: entry.slangTerm,
      normalizedEntity: entry.normalizedEntity,
      targetType: entry.targetType,
      notes: entry.notes || '',
      isActive: entry.isActive,
    });
    setFormError('');
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError('');
  };

  const handleSubmit = () => {
    if (!form.slangTerm.trim() || !form.normalizedEntity.trim()) {
      setFormError(t('adminSlang.requiredFields'));
      return;
    }
    if (editingId) updateMutation.mutate();
    else createMutation.mutate();
  };

  const handleExport = async () => {
    const data = await slangApi.export();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'slang-dictionary.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 className="page-title">
            🔤 {t('adminSlang.pageTitle')}
          </h1>
          <p className="page-subtitle">
            {t('adminSlang.subtitle', { n: entries.length })}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-secondary-custom" onClick={handleExport}>⬇️ {t('adminSlang.exportJson')}</button>
          <button className="btn-primary-custom" onClick={openCreateForm}>+ {t('adminSlang.addTerm')}</button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          className="text-input"
          placeholder={t('adminSlang.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: '260px' }}
        />
        <select
          className="text-input"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{ maxWidth: '200px' }}
        >
          <option value="all">{t('adminSlang.allTypes')}</option>
          {Object.entries(TYPE_LABELS).map(([key, { labelKey, icon }]) => (
            <option key={key} value={key}>{icon} {t(labelKey)}</option>
          ))}
        </select>
      </div>

      {/* Create/Edit Form */}
      {showForm && (
        <div className="card-custom card-section">
          <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '1rem' }}>
            {editingId ? `✏️ ${t('adminSlang.editTerm')}` : `➕ ${t('adminSlang.addTermTitle')}`}
          </h3>
          {formError && (
            <div className="alert-box alert-danger" style={{ marginBottom: '0.75rem' }}>⚠️ {formError}</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: '0.75rem' }}>
            <div>
              <label className="input-label">{t('adminSlang.slangLabel')}</label>
              <input
                type="text"
                className="text-input"
                placeholder={t('adminSlang.slangPlaceholder')}
                value={form.slangTerm}
                onChange={(e) => setForm({ ...form, slangTerm: e.target.value })}
              />
            </div>
            <div>
              <label className="input-label">{t('adminSlang.normalizedLabel')}</label>
              <input
                type="text"
                className="text-input"
                placeholder={t('adminSlang.normalizedPlaceholder')}
                value={form.normalizedEntity}
                onChange={(e) => setForm({ ...form, normalizedEntity: e.target.value })}
              />
            </div>
            <div>
              <label className="input-label">{t('adminSlang.typeLabel')}</label>
              <select
                className="text-input"
                value={form.targetType}
                onChange={(e) => setForm({ ...form, targetType: e.target.value as SlangEntry['targetType'] })}
              >
                {Object.entries(TYPE_LABELS).map(([key, { labelKey, icon }]) => (
                  <option key={key} value={key}>{icon} {t(labelKey)}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: '0.75rem' }}>
            <label className="input-label">{t('adminSlang.notesLabel')}</label>
            <input
              type="text"
              className="text-input"
              placeholder={t('adminSlang.notesPlaceholder')}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem', justifyContent: 'flex-end' }}>
            <button className="btn-cancel" onClick={closeForm}>{t('common.cancel')}</button>
            <button className="btn-primary-custom" onClick={handleSubmit} disabled={isSaving}>
              {isSaving
                ? t('wiki.saving')
                : editingId
                  ? `💾 ${t('adminSlang.saveChanges')}`
                  : `✓ ${t('adminSlang.createNew')}`}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card-custom" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: '3rem', textAlign: 'center' }}>
            <div className="spinner-custom" style={{ margin: '0 auto', width: 32, height: 32 }} />
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
            {t('adminSlang.empty')}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminSlang.colSlang')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminSlang.colNormalized')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminSlang.typeLabel')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminSlang.colNotes')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminUsers.colStatus')}</th>
                <th className="table-custom" style={{ textAlign: 'right' }}>{t('audit.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="table-custom" style={{ fontWeight: 600 }}>{entry.slangTerm}</td>
                  <td className="table-custom">→ {entry.normalizedEntity}</td>
                  <td className="table-custom">
                    {TYPE_LABELS[entry.targetType]?.icon}{' '}
                    {TYPE_LABELS[entry.targetType] ? t(TYPE_LABELS[entry.targetType].labelKey) : entry.targetType}
                  </td>
                  <td className="table-custom" style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                    {entry.notes || '—'}
                  </td>
                  <td className="table-custom">
                    <span className={`status-badge ${entry.isActive ? 'published' : 'unpublished'}`}>
                      {entry.isActive ? t('adminSlang.inUse') : t('adminSlang.off')}
                    </span>
                  </td>
                  <td className="table-custom" style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => toggleActiveMutation.mutate({ id: entry.id, isActive: entry.isActive })}
                        style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.3rem 0.6rem', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--color-text)' }}
                      >
                        {entry.isActive ? `🔇 ${t('adminSlang.off')}` : `✅ ${t('adminSlang.on')}`}
                      </button>
                      <button
                        onClick={() => openEditForm(entry)}
                        style={{ background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.3rem 0.6rem', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--color-text)' }}
                      >
                        ✏️ {t('common.edit')}
                      </button>
                      <button
                        onClick={async () => { if (await confirm(t('adminSlang.confirmDelete', { term: entry.slangTerm }))) deleteMutation.mutate(entry.id); }}
                        style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 6, padding: '0.3rem 0.6rem', cursor: 'pointer', fontSize: '0.75rem', color: 'var(--color-danger)' }}
                      >
                        🗑
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
