import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { adminApi } from '../../api';
import { TREE_KEY } from '../../hooks/useTree';
import { useConfirm } from '../../components/ConfirmModal';

interface Analytics {
  period: string;
  searches: number;
  aiQuestions: number;
  noAnswers: number;
  topUnansweredQueries: { query: string; count: number }[];
}

interface ReindexProgress {
  status: 'idle' | 'running' | 'done';
  total: number;
  processed: number;
  success: number;
  failed: number;
  failedNodeIds: string[];
  currentItem: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface PublishAllProgress {
  status: 'idle' | 'running' | 'done';
  total: number;
  processed: number;
  success: number;
  failed: number;
  failedNodeIds: string[];
  currentItem: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  draftCount: number;
  totalArticleCount: number;
}

export default function AdminAnalyticsPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const { data, isLoading } = useQuery<Analytics>({
    queryKey: ['analytics'],
    queryFn: adminApi.getAnalytics,
  });

  const { data: keepAliveStatus } = useQuery({
    queryKey: ['keep-alive-status'],
    queryFn: adminApi.getKeepAliveStatus,
    refetchInterval: 60_000,
  });

  // Poll tiến trình mỗi 2s trong lúc đang chạy re-index toàn bộ, dừng poll khi idle/done.
  const { data: reindexProgress } = useQuery<ReindexProgress>({
    queryKey: ['admin-reindex-status'],
    queryFn: adminApi.getReindexStatus,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });

  const reindexMutation = useMutation({
    mutationFn: adminApi.reindexAll,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-reindex-status'] });
    },
  });

  const retryFailedMutation = useMutation({
    mutationFn: adminApi.retryFailedReindex,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-reindex-status'] });
    },
  });

  // Poll tiến trình "Đăng toàn bộ" mỗi 2s trong lúc đang chạy, dừng poll khi idle/done — cùng cơ
  // chế với admin-reindex-status ở trên.
  const { data: publishAllProgress } = useQuery<PublishAllProgress>({
    queryKey: ['admin-publish-all-status'],
    queryFn: adminApi.getPublishAllStatus,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });

  const publishAllMutation = useMutation({
    mutationFn: adminApi.publishAll,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-publish-all-status'] });
    },
  });

  // Khi lượt "Đăng toàn bộ" vừa hoàn tất, làm mới cây tài liệu (sidebar/danh sách bài viết) để
  // các bài vừa chuyển Published hiện đúng ngay, không cần F5 thủ công.
  const prevPublishAllStatusRef = useRef<PublishAllProgress['status'] | undefined>(undefined);
  useEffect(() => {
    if (prevPublishAllStatusRef.current === 'running' && publishAllProgress?.status === 'done') {
      queryClient.invalidateQueries({ queryKey: TREE_KEY });
    }
    prevPublishAllStatusRef.current = publishAllProgress?.status;
  }, [publishAllProgress?.status, queryClient]);

  const keepAliveMutation = useMutation({
    mutationFn: adminApi.keepAlive,
  });

  // Xoá xong phải nạp lại summary, nếu không các con số ở đầu trang vẫn hiện giá trị cũ
  // trong khi dữ liệu đã trống — người dùng sẽ tưởng nút không ăn.
  const deleteAnalyticsMutation = useMutation({
    mutationFn: adminApi.deleteAnalytics,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analytics'] }),
  });

  const statCard = (icon: string, label: string, value: number | string, color: string) => (
    <div className="card-custom" style={{ padding: '1.5rem', flex: 1, minWidth: '200px' }}>
      <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>{icon}</div>
      <div style={{ fontSize: '2rem', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>{label}</div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title">📊 {t('adminAnalytics.pageTitle')}</h1>
        <p className="page-subtitle">{t('adminAnalytics.subtitle')}</p>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}><div className="spinner-custom" style={{ margin: '0 auto', width: 32, height: 32 }} /></div>
      ) : (
        <>
          {/* Stat cards */}
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', flexWrap: 'wrap' }}>
            {statCard('🔍', t('adminAnalytics.statSearches'), data?.searches ?? 0, 'var(--color-primary)')}
            {statCard('🤖', t('adminAnalytics.statAiQuestions'), data?.aiQuestions ?? 0, 'var(--color-accent)')}
            {statCard('❓', t('adminAnalytics.statNoAnswer'), data?.noAnswers ?? 0, 'var(--color-warning)')}
          </div>

          {/* Top unanswered */}
          {(data?.topUnansweredQueries?.length ?? 0) > 0 && (
            <div className="card-custom card-section">
              <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '1rem' }}>❓ {t('adminAnalytics.topUnanswered')}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {data?.topUnansweredQueries.map((q, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.625rem 0.875rem', background: 'var(--color-surface-2)', borderRadius: 8 }}>
                    <span style={{ fontSize: '0.875rem', color: 'var(--color-text)' }}>{q.query}</span>
                    <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-warning)', background: 'rgba(245,158,11,.1)', padding: '0.2rem 0.5rem', borderRadius: 999 }}>{q.count}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Re-index toàn bộ */}
          <div className="card-custom card-section">
            <h3 className="card-section-title">🔄 {t('adminAnalytics.reindexTitle')}</h3>
            <p className="card-section-desc">{t('adminAnalytics.reindexDesc')}</p>

            {reindexProgress && reindexProgress.status !== 'idle' && (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '0.375rem', color: 'var(--color-text-muted)' }}>
                  <span>
                    {reindexProgress.status === 'running'
                      ? `⏳ ${t('adminAnalytics.running', { item: reindexProgress.currentItem ?? '...' })}`
                      : `✅ ${t('adminAnalytics.reindexDone')}`}
                  </span>
                  <span>{reindexProgress.processed}/{reindexProgress.total}</span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'var(--color-surface-2)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${reindexProgress.total > 0 ? (reindexProgress.processed / reindexProgress.total) * 100 : 0}%`,
                      background: reindexProgress.status === 'running' ? 'var(--color-primary)' : 'var(--color-success)',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.375rem' }}>
                  ✅ {t('adminAnalytics.successCount', { n: reindexProgress.success })}
                  {reindexProgress.failed > 0 && <> · ❌ {t('adminAnalytics.failedCount', { n: reindexProgress.failed })}</>}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button
                id="btn-reindex-all"
                className="btn-primary-custom"
                onClick={() => reindexMutation.mutate()}
                disabled={reindexMutation.isPending || reindexProgress?.status === 'running'}
                style={{ padding: '0.5rem 1.25rem' }}
              >
                {reindexProgress?.status === 'running'
                  ? `⏳ ${t('adminAnalytics.reindexing')}`
                  : `🔄 ${t('adminAnalytics.reindexTitle')}`}
              </button>

              {reindexProgress?.status === 'done' && (reindexProgress.failedNodeIds?.length ?? 0) > 0 && (
                <button
                  id="btn-reindex-retry-failed"
                  className="btn-primary-custom"
                  onClick={() => retryFailedMutation.mutate()}
                  disabled={retryFailedMutation.isPending}
                  style={{ padding: '0.5rem 1.25rem', background: 'var(--color-warning)' }}
                >
                  🔁 {t('adminAnalytics.retryFailed', { n: reindexProgress.failedNodeIds.length })}
                </button>
              )}

              <button
                id="btn-publish-all"
                className="btn-primary-custom"
                onClick={() => publishAllMutation.mutate()}
                disabled={
                  publishAllMutation.isPending ||
                  publishAllProgress?.status === 'running' ||
                  (publishAllProgress?.draftCount ?? 0) === 0
                }
                style={{ padding: '0.5rem 1.25rem', background: 'var(--color-success)' }}
                title={
                  (publishAllProgress?.draftCount ?? 0) === 0
                    ? t('adminAnalytics.noDraftToPublish')
                    : undefined
                }
              >
                {publishAllProgress?.status === 'running'
                  ? `⏳ ${t('adminAnalytics.publishing', {
                      processed: publishAllProgress.processed,
                      total: publishAllProgress.total,
                    })}`
                  : `🚀 ${t('adminAnalytics.publishAll', {
                      drafts: publishAllProgress?.draftCount ?? 0,
                      total: publishAllProgress?.totalArticleCount ?? 0,
                    })}`}
              </button>
            </div>
            {(reindexMutation.isError || retryFailedMutation.isError) && (
              <span style={{ marginLeft: '0.75rem', fontSize: '0.875rem', color: 'var(--color-danger, #ef4444)' }}>
                ❌ {t('adminAnalytics.reindexStartFailed')}
              </span>
            )}
            {publishAllMutation.isError && (
              <span style={{ marginLeft: '0.75rem', fontSize: '0.875rem', color: 'var(--color-danger, #ef4444)' }}>
                ❌ {t('adminAnalytics.publishAllStartFailed')}
              </span>
            )}
            {publishAllProgress?.status === 'done' && (
              <div style={{ marginTop: '0.75rem', fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                ✅ {t('adminAnalytics.lastPublishAll', { n: publishAllProgress.success })}
                {publishAllProgress.failed > 0 && <> · ❌ {t('adminAnalytics.failedCount', { n: publishAllProgress.failed })}</>}
              </div>
            )}
          </div>

          {/* Keep-alive (DEC-12) */}
          <div className="card-custom" style={{ padding: '1.5rem' }}>
            <h3 style={{ fontWeight: 600, marginBottom: '0.75rem', fontSize: '1rem' }}>💓 Keep-Alive Supabase</h3>
            <p style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>
              {t('adminAnalytics.keepAliveDesc')}{' '}
              <strong>
                {keepAliveStatus?.lastPingedAt
                  ? new Date(keepAliveStatus.lastPingedAt).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN')
                  : t('adminAnalytics.neverPinged')}
              </strong>
            </p>
            <button
              id="btn-keep-alive"
              className="btn-primary-custom"
              onClick={() => keepAliveMutation.mutate()}
              disabled={keepAliveMutation.isPending}
            >
              {keepAliveMutation.isPending ? `⏳ ${t('adminAnalytics.pinging')}` : `💓 ${t('adminAnalytics.pingNow')}`}
            </button>
            {keepAliveMutation.isSuccess && (
              <span style={{ marginLeft: '0.75rem', fontSize: '0.875rem', color: 'var(--color-success)' }}>
                ✅ {t('adminAnalytics.pingedAt', { time: new Date().toLocaleTimeString(i18n.language === 'en' ? 'en-GB' : 'vi-VN') })}
              </span>
            )}
          </div>

          {/* Xoá dữ liệu thống kê — đặt CUỐI trang vì đây là thao tác huỷ dữ liệu, không nên
              nằm lẫn giữa các thẻ cấu hình thông thường phía trên. */}
          <div className="card-custom card-section">
            <h3 className="card-section-title">🗑️ {t('adminAnalytics.deleteTitle')}</h3>
            <p className="card-section-desc">{t('adminAnalytics.deleteDesc')}</p>

            <div className="alert-box alert-warning" role="alert" style={{ marginBottom: '1rem' }}>
              ⚠️ {t('adminAnalytics.deleteWarning')}
            </div>

            {deleteAnalyticsMutation.isSuccess && (
              <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
                ✅ {t('adminAnalytics.deleted', {
                  n: deleteAnalyticsMutation.data.deleted.toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN'),
                })}
              </div>
            )}
            {deleteAnalyticsMutation.isError && (
              <div className="alert-box alert-danger" role="alert" style={{ marginBottom: '1rem' }}>
                ⚠️ {t('adminAnalytics.deleteFailed')}
              </div>
            )}

            <button
              className="btn-danger-custom"
              disabled={deleteAnalyticsMutation.isPending}
              onClick={async () => {
                const ok = await confirm(t('adminAnalytics.confirmDelete'));
                if (ok) deleteAnalyticsMutation.mutate();
              }}
            >
              {deleteAnalyticsMutation.isPending
                ? `⏳ ${t('adminAnalytics.deleting')}`
                : `🗑️ ${t('adminAnalytics.deleteAll')}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
