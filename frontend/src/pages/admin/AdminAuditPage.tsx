import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { adminApi } from '../../api';

interface AuditLog {
  id: string;
  action: string;
  actorEmail: string | null;
  targetId: string | null;
  targetType: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

// Nhãn giữ khoá dịch, chỉ đổi thành chữ lúc render để đổi ngôn ngữ là bảng đổi theo.
const ACTION_LABELS: Record<string, { labelKey: string; icon: string; color: string }> = {
  content_create:    { labelKey: 'audit.actions.contentCreate',    icon: '📝', color: 'var(--color-primary)' },
  content_edit:      { labelKey: 'audit.actions.contentEdit',      icon: '✏️', color: 'var(--color-warning)' },
  content_delete:    { labelKey: 'audit.actions.contentDelete',    icon: '🗑',  color: 'var(--color-danger)' },
  content_publish:   { labelKey: 'audit.actions.contentPublish',   icon: '🚀', color: 'var(--color-success)' },
  content_unpublish: { labelKey: 'audit.actions.contentUnpublish', icon: '👁',  color: 'var(--color-text-muted)' },
  user_create:       { labelKey: 'audit.actions.userCreate',       icon: '👤', color: 'var(--color-primary)' },
  user_edit:         { labelKey: 'audit.actions.userEdit',         icon: '✏️', color: 'var(--color-warning)' },
  user_enable:       { labelKey: 'audit.actions.userEnable',       icon: '✅', color: 'var(--color-success)' },
  user_disable:      { labelKey: 'audit.actions.userDisable',      icon: '🔒', color: 'var(--color-danger)' },
  promotion_import:  { labelKey: 'audit.actions.promotionImport',  icon: '🎁', color: 'var(--color-primary)' },
  promotion_provider_edit: { labelKey: 'audit.actions.promotionProviderEdit', icon: '🏷', color: 'var(--color-warning)' },
  system_prompt_edit: { labelKey: 'audit.actions.systemPromptEdit', icon: '💬', color: 'var(--color-warning)' },
  user_delete:       { labelKey: 'audit.actions.userDelete',       icon: '🗑',  color: 'var(--color-danger)' },
  // node_* = thao tác trên cây Thư mục/Bài viết (nodes.service.ts); node_move gồm cả kéo thả sắp xếp
  node_create:       { labelKey: 'audit.actions.nodeCreate',       icon: '📝', color: 'var(--color-primary)' },
  node_edit:         { labelKey: 'audit.actions.nodeEdit',         icon: '✏️', color: 'var(--color-warning)' },
  node_delete:       { labelKey: 'audit.actions.nodeDelete',       icon: '🗑',  color: 'var(--color-danger)' },
  node_move:         { labelKey: 'audit.actions.nodeMove',         icon: '↕️', color: 'var(--color-primary)' },
  node_publish:      { labelKey: 'audit.actions.nodePublish',      icon: '🚀', color: 'var(--color-success)' },
  slang_create:      { labelKey: 'audit.actions.slangCreate',      icon: '🔤', color: 'var(--color-primary)' },
  slang_edit:        { labelKey: 'audit.actions.slangEdit',        icon: '✏️', color: 'var(--color-warning)' },
  slang_delete:      { labelKey: 'audit.actions.slangDelete',      icon: '🗑',  color: 'var(--color-danger)' },
  telegram_approve:  { labelKey: 'audit.actions.telegramApprove',  icon: '✅', color: 'var(--color-success)' },
  telegram_reject:   { labelKey: 'audit.actions.telegramReject',   icon: '⛔', color: 'var(--color-danger)' },
  telegram_revoke:   { labelKey: 'audit.actions.telegramRevoke',   icon: '🔒', color: 'var(--color-warning)' },
  telegram_delete:   { labelKey: 'audit.actions.telegramDelete',   icon: '🗑',  color: 'var(--color-danger)' },
  kb_create:         { labelKey: 'audit.actions.kbCreate',         icon: '🗂', color: 'var(--color-primary)' },
};

export default function AdminAuditPage() {
  const { t, i18n } = useTranslation();
  const { data: logs = [], isLoading } = useQuery<AuditLog[]>({
    queryKey: ['audit-logs'],
    queryFn: adminApi.getAuditLogs,
  });

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title">
          🔒 Audit Log
        </h1>
        <p className="page-subtitle">
          {t('audit.subtitle')}
        </p>
      </div>

      <div className="card-custom" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: '3rem', textAlign: 'center' }}>
            <div className="spinner-custom" style={{ margin: '0 auto', width: 32, height: 32 }} />
          </div>
        ) : logs.length === 0 ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--color-text-muted)' }}>
            {t('audit.empty')}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('audit.colTime')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('audit.colAction')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('audit.colActor')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('audit.colDetail')}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const actionInfo = ACTION_LABELS[log.action];
                const label = actionInfo ? t(actionInfo.labelKey) : log.action;
                const icon = actionInfo?.icon ?? '•';
                const color = actionInfo?.color ?? 'var(--color-text-muted)';
                return (
                  <tr key={log.id}>
                    <td className="table-custom" style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                      {new Date(log.createdAt).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN')}
                    </td>
                    <td className="table-custom">
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem', fontWeight: 500, color }}>
                        {icon} {label}
                      </span>
                    </td>
                    <td className="table-custom" style={{ fontSize: '0.875rem', color: 'var(--color-text)' }}>
                      {log.actorEmail ?? '—'}
                    </td>
                    <td className="table-custom" style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                      {log.meta ? JSON.stringify(log.meta) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
