import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import i18n from '../../lib/i18n';
import { telegramApi, type TelegramUserDTO, type TelegramUserStatus } from '../../api';
import { useConfirm } from '../../components/ConfirmModal';
import { useKbList } from '../../api/kb';

type TabKey = TelegramUserStatus | 'all';

const TABS: Array<{ key: TabKey; labelKey: string; icon: string }> = [
  { key: 'pending', labelKey: 'adminTelegram.tabPending', icon: '⏳' },
  { key: 'approved', labelKey: 'adminTelegram.tabApproved', icon: '✅' },
  { key: 'rejected', labelKey: 'adminTelegram.tabRejected', icon: '🚫' },
  { key: 'all', labelKey: 'adminTelegram.tabAll', icon: '📋' },
];

const STATUS_BADGE: Record<TelegramUserStatus, { className: string; labelKey: string }> = {
  approved: { className: 'published', labelKey: 'adminTelegram.tabApproved' },
  pending: { className: 'draft', labelKey: 'adminTelegram.tabPending' },
  rejected: { className: 'unpublished', labelKey: 'adminTelegram.tabRejected' },
};

/** Nút hành động nhỏ trong bảng — dùng lại đúng khuôn của AdminSlangPage. */
const actionButtonStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  padding: '0.3rem 0.6rem',
  cursor: 'pointer',
  fontSize: '0.75rem',
  color: 'var(--color-text)',
};

const dangerButtonStyle: React.CSSProperties = {
  ...actionButtonStyle,
  background: 'rgba(239,68,68,.1)',
  border: '1px solid rgba(239,68,68,.3)',
  color: 'var(--color-danger)',
};

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminTelegramPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabKey>('pending');
  const [error, setError] = useState('');

  const { data: entries = [], isLoading } = useQuery<TelegramUserDTO[]>({
    queryKey: ['admin-telegram', tab],
    queryFn: () => telegramApi.list(tab),
  });

  // Đếm riêng để badge "Chờ duyệt" vẫn đúng kể cả khi đang đứng ở tab khác
  const { data: pending } = useQuery({
    queryKey: ['admin-telegram-pending-count'],
    queryFn: () => telegramApi.pendingCount(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-telegram'] });
    queryClient.invalidateQueries({ queryKey: ['admin-telegram-pending-count'] });
  };

  const onError = (err: unknown) => {
    const message =
      (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      t('adminTelegram.actionFailed');
    setError(message);
  };

  const mutationOptions = {
    onSuccess: () => {
      setError('');
      invalidate();
    },
    onError,
  };

  const approveMutation = useMutation({ mutationFn: telegramApi.approve, ...mutationOptions });
  const rejectMutation = useMutation({ mutationFn: telegramApi.reject, ...mutationOptions });
  const revokeMutation = useMutation({ mutationFn: telegramApi.revoke, ...mutationOptions });
  const deleteMutation = useMutation({ mutationFn: telegramApi.delete, ...mutationOptions });
  // Gán KB cho tài khoản Telegram — bot tra cột này để biết trả lời bằng dữ liệu của KB nào,
  // nhờ vậy chỉ cần MỘT bot token duy nhất cho mọi ngôn ngữ.
  const setKbMutation = useMutation({
    mutationFn: ({ id, kbCode }: { id: string; kbCode: string }) => telegramApi.setKb(id, kbCode),
    ...mutationOptions,
  });
  const { data: dsKb = [] } = useKbList();

  const isBusy =
    approveMutation.isPending ||
    rejectMutation.isPending ||
    revokeMutation.isPending ||
    deleteMutation.isPending;

  const pendingCount = pending?.count ?? 0;

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title">✈️ {t('layout.nav.telegram')}</h1>
        <p className="page-subtitle">{t('adminTelegram.subtitle')}</p>
      </div>

      {error && (
        <div className="alert-box alert-danger" role="alert" style={{ marginBottom: '1rem' }}>
          ⚠️ {error}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        {TABS.map(({ key, labelKey, icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={tab === key ? 'btn-primary-custom btn-sm' : 'btn-secondary-custom btn-sm'}
          >
            {icon} {t(labelKey)}
            {key === 'pending' && pendingCount > 0 && (
              <span
                style={{
                  marginLeft: '0.4rem',
                  background: 'var(--color-danger)',
                  color: '#fff',
                  borderRadius: 999,
                  padding: '0.05rem 0.4rem',
                  fontSize: 'var(--fs-xs)',
                  fontWeight: 700,
                }}
              >
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="card-custom" style={{ overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: '3rem', textAlign: 'center' }}>
            <div className="spinner-custom" style={{ margin: '0 auto', width: 32, height: 32 }} />
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
            {tab === 'pending' ? t('adminTelegram.emptyPending') : t('adminTelegram.emptyList')}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminTelegram.colUser')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>Telegram ID</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminTelegram.colRequestedAt')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminTelegram.colReviewedAt')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminUsers.colStatus')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>Knowledge Base</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>Knowledge Base</th>
                <th className="table-custom" style={{ textAlign: 'right' }}>{t('audit.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="table-custom">
                    <div style={{ fontWeight: 600 }}>{entry.displayName}</div>
                    {entry.username && (
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-xs)' }}>
                        @{entry.username}
                      </div>
                    )}
                  </td>
                  <td
                    className="table-custom"
                    style={{ fontFamily: 'monospace', fontSize: 'var(--fs-xs)' }}
                  >
                    {entry.telegramId}
                  </td>
                  <td className="table-custom" style={{ fontSize: 'var(--fs-xs)' }}>
                    {formatDateTime(entry.requestedAt)}
                  </td>
                  <td className="table-custom" style={{ fontSize: 'var(--fs-xs)' }}>
                    {formatDateTime(entry.reviewedAt)}
                  </td>
                  <td className="table-custom">
                    <span className={`status-badge ${STATUS_BADGE[entry.status].className}`}>
                      {t(STATUS_BADGE[entry.status].labelKey)}
                    </span>
                  </td>
                  <td className="table-custom">
                    {/* Bot tra cột này để biết trả lời tài khoản Telegram này bằng dữ liệu KB nào
                        — nhờ vậy chỉ cần MỘT bot token duy nhất cho mọi ngôn ngữ. */}
                    <select
                      className="kb-inline-select"
                      value={entry.kbCode}
                      disabled={isBusy}
                      onChange={(e) => setKbMutation.mutate({ id: entry.id, kbCode: e.target.value })}
                      title={t('adminTelegram.kbSelectTitle')}
                    >
                      {dsKb.length === 0 && <option value={entry.kbCode}>{entry.kbCode}</option>}
                      {dsKb.map((kb) => (
                        <option key={kb.code} value={kb.code}>
                          {kb.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="table-custom" style={{ textAlign: 'right' }}>
                    <div
                      style={{
                        display: 'flex',
                        gap: '0.4rem',
                        justifyContent: 'flex-end',
                        flexWrap: 'wrap',
                      }}
                    >
                      {entry.status === 'pending' && (
                        <>
                          <button
                            style={actionButtonStyle}
                            disabled={isBusy}
                            onClick={() => approveMutation.mutate(entry.id)}
                          >
                            ✅ {t('adminTelegram.approve')}
                          </button>
                          <button
                            style={actionButtonStyle}
                            disabled={isBusy}
                            onClick={() => rejectMutation.mutate(entry.id)}
                          >
                            🚫 {t('adminTelegram.reject')}
                          </button>
                        </>
                      )}

                      {entry.status === 'approved' && (
                        <button
                          style={actionButtonStyle}
                          disabled={isBusy}
                          onClick={async () => {
                            if (
                              await confirm(t('adminTelegram.confirmRevoke', { name: entry.displayName }))
                            ) {
                              revokeMutation.mutate(entry.id);
                            }
                          }}
                        >
                          ⛔ {t('adminTelegram.revoke')}
                        </button>
                      )}

                      {entry.status === 'rejected' && (
                        <button
                          style={actionButtonStyle}
                          disabled={isBusy}
                          onClick={() => approveMutation.mutate(entry.id)}
                        >
                          ✅ {t('adminTelegram.approveAgain')}
                        </button>
                      )}

                      <button
                        style={dangerButtonStyle}
                        disabled={isBusy}
                        onClick={async () => {
                          if (
                            await confirm(t('adminTelegram.confirmDelete', { name: entry.displayName }))
                          ) {
                            deleteMutation.mutate(entry.id);
                          }
                        }}
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
