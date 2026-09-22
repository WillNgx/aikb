import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import i18n from '../../lib/i18n';
import { adminApi } from '../../api';
import type {
  AIProviderSettings,
  AIProviderTestResult,
  CustomAIGateway,
  RateLimitSettings,
  TokenUsagePoint,
  TokenUsageReport,
} from '../../api';
import { useConfirm } from '../../components/ConfirmModal';

/**
 * Trang cấu hình AI (chỉ Admin) — gom toàn bộ thiết lập vận hành AI vào một chỗ:
 * provider/model, ngưỡng tương đồng, số link gợi ý, giới hạn truy cập, kèm biểu đồ token đã tiêu.
 *
 * Bốn khối cấu hình bên dưới được CHUYỂN NGUYÊN TRẠNG từ trang Thống kê sang, giữ nguyên hành vi
 * và id phần tử — nếu sửa logic ở đây thì không còn bản sao nào bên trang Thống kê nữa.
 */

type Granularity = 'day' | 'month';

/** Số cột hiển thị theo từng chế độ. 12 tháng khớp đúng hạn lưu trữ dữ liệu. */
const DAY_RANGE = 30;
const MONTH_RANGE = 12;

// ─── Tiện ích cho biểu đồ ────────────────────────────────────────────────────

/** 12.345 -> '12.3K', 1.234.567 -> '1.2M' — trục dọc hẹp nên không hiển thị số đầy đủ. */
function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatFull(n: number): string {
  return n.toLocaleString(i18n.language === 'en' ? 'en-GB' : 'vi-VN');
}

/** '2026-09-08' -> '08/09', '2026-09' -> '09/2026'. */
function formatPeriodLabel(period: string, granularity: Granularity): string {
  const parts = period.split('-');
  return granularity === 'day' ? `${parts[2]}/${parts[1]}` : `${parts[1]}/${parts[0]}`;
}

/**
 * Bù các mốc thời gian không có dữ liệu thành cột 0.
 *
 * Backend cố ý chỉ trả về mốc CÓ dữ liệu (không sinh chuỗi ngày rỗng), nhưng biểu đồ phải liền
 * mạch thì mới đọc được xu hướng — thiếu ngày sẽ làm 2 cột cách nhau 1 tuần đứng sát nhau.
 */
function fillMissingPeriods(
  points: TokenUsagePoint[],
  granularity: Granularity,
  range: number,
): TokenUsagePoint[] {
  const byPeriod = new Map(points.map((p) => [p.period, p]));
  const result: TokenUsagePoint[] = [];
  const now = new Date();

  for (let i = range - 1; i >= 0; i--) {
    let period: string;
    if (granularity === 'day') {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      period = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    } else {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    result.push(
      byPeriod.get(period) ?? {
        period,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0,
      },
    );
  }

  return result;
}

interface TokenChartProps {
  points: TokenUsagePoint[];
  granularity: Granularity;
  onSelect: (period: string) => void;
  selected: string | null;
}

/**
 * Biểu đồ cột chồng (input dưới, output trên) vẽ bằng SVG thuần.
 *
 * Cố ý KHÔNG dùng thư viện chart: dự án chưa có sẵn cái nào, và một biểu đồ cột đơn giản không
 * đáng để thêm vài trăm KB vào bundle chỉ cho một trang Admin. Màu lấy từ token CSS nên tự đúng
 * ở cả theme Sáng lẫn Tối.
 */
function TokenChart({ points, granularity, onSelect, selected }: TokenChartProps) {
  const { t } = useTranslation();
  // Toạ độ trong hệ viewBox cố định — SVG tự co giãn theo bề ngang thật của thẻ
  const width = 900;
  const height = 260;
  const padding = { top: 16, right: 12, bottom: 32, left: 56 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const maxTotal = Math.max(...points.map((p) => p.totalTokens), 1);
  // Làm tròn trần lên bậc "đẹp" để vạch trục không ra số lẻ khó đọc
  const step = Math.pow(10, Math.floor(Math.log10(maxTotal)));
  // Sàn 4: có 5 vạch chia đều, nên trần nhỏ hơn 4 sẽ làm tròn ra nhãn trùng nhau (0,0,1,1,1)
  const yMax = Math.max(Math.ceil(maxTotal / step) * step || 1, 4);

  const slot = plotW / points.length;
  const barW = Math.max(4, Math.min(38, slot * 0.62));

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  // Nhãn trục ngang: dày quá thì chồng chữ, nên chỉ hiện thưa ở chế độ ngày
  const labelEvery = granularity === 'day' ? Math.ceil(points.length / 10) : 1;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
      role="img"
      aria-label={t('adminAi.chartAria')}
    >
      {gridLines.map((g) => {
        const y = padding.top + plotH - g * plotH;
        return (
          <g key={g}>
            <line
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={padding.left - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--color-text-muted)"
            >
              {formatCompact(Math.round(yMax * g))}
            </text>
          </g>
        );
      })}

      {points.map((p, i) => {
        const x = padding.left + i * slot + (slot - barW) / 2;
        const inputH = (p.inputTokens / yMax) * plotH;
        const outputH = (p.outputTokens / yMax) * plotH;
        const isSelected = selected === p.period;
        const hasData = p.totalTokens > 0;

        return (
          <g
            key={p.period}
            onClick={() => onSelect(p.period)}
            style={{ cursor: hasData ? 'pointer' : 'default' }}
          >
            {/* Vùng bấm phủ cả chiều cao để cột thấp/rỗng vẫn dễ chọn */}
            <rect
              x={padding.left + i * slot}
              y={padding.top}
              width={slot}
              height={plotH}
              fill={isSelected ? 'var(--color-surface-2)' : 'transparent'}
            />
            <title>
              {t('adminAi.chartTooltip', {
                period: formatPeriodLabel(p.period, granularity),
                total: formatFull(p.totalTokens),
                input: formatFull(p.inputTokens),
                output: formatFull(p.outputTokens),
                requests: p.requestCount,
              })}
            </title>

            <rect
              x={x}
              y={padding.top + plotH - inputH}
              width={barW}
              height={inputH}
              fill="var(--color-primary)"
              rx={2}
            />
            <rect
              x={x}
              y={padding.top + plotH - inputH - outputH}
              width={barW}
              height={outputH}
              fill="var(--color-accent)"
              rx={2}
            />

            {i % labelEvery === 0 && (
              <text
                x={padding.left + i * slot + slot / 2}
                y={height - 12}
                textAnchor="middle"
                fontSize={11}
                fill="var(--color-text-muted)"
              >
                {formatPeriodLabel(p.period, granularity)}
              </text>
            )}
          </g>
        );
      })}

      <line
        x1={padding.left}
        y1={padding.top + plotH}
        x2={width - padding.right}
        y2={padding.top + plotH}
        stroke="var(--color-border)"
        strokeWidth={1}
      />
    </svg>
  );
}

// ─── Trang ────────────────────────────────────────────────────────────────────

export default function AdminAiSettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const [thresholdInput, setThresholdInput] = useState<number>(0.45);
  const [thresholdMsg, setThresholdMsg] = useState<string>('');
  const [linksCountInput, setLinksCountInput] = useState<number>(2);
  const [linksCountMsg, setLinksCountMsg] = useState<string>('');
  // Giới hạn request/IP — cửa sổ thời gian do backend quy định, ở đây chỉ chỉnh số lượng
  const [aiChatLimitInput, setAiChatLimitInput] = useState<number>(20);
  const [generalLimitInput, setGeneralLimitInput] = useState<number>(300);
  const [rateLimitMsg, setRateLimitMsg] = useState<string>('');
  const [rateLimitError, setRateLimitError] = useState<string>('');
  // Cấu hình provider cho AI Chat box
  const [providerInput, setProviderInput] = useState<string>('gemini');
  const [modelInput, setModelInput] = useState<string>('');
  const [aiProviderMsg, setAiProviderMsg] = useState<string>('');
  const [testResult, setTestResult] = useState<AIProviderTestResult | null>(null);
  // Danh sách model tải thẳng từ nhà cung cấp — null = chưa bấm tải lần nào
  const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
  const [modelsMsg, setModelsMsg] = useState<string>('');
  // Quản lý Cổng AI Custom (Public Gateways)
  const [showGatewayForm, setShowGatewayForm] = useState<boolean>(false);
  const [editingGatewayId, setEditingGatewayId] = useState<string | null>(null);
  const [gatewayForm, setGatewayForm] = useState({
    name: '',
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
    isActive: true,
  });
  const [gatewayFormError, setGatewayFormError] = useState<string>('');
  const [gatewaySuccessMsg, setGatewaySuccessMsg] = useState<string>('');
  const [directTestResult, setDirectTestResult] = useState<AIProviderTestResult | null>(null);
  const [directFetchedModels, setDirectFetchedModels] = useState<string[] | null>(null);
  const [directModelsMsg, setDirectModelsMsg] = useState<string>('');
  // Biểu đồ token
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const [tokenMsg, setTokenMsg] = useState<string>('');

  const range = granularity === 'day' ? DAY_RANGE : MONTH_RANGE;

  const { data: tokenData, isLoading: tokenLoading } = useQuery<TokenUsageReport>({
    queryKey: ['admin-token-usage', granularity, range],
    queryFn: () => adminApi.getTokenUsage(granularity, range),
  });

  const chartPoints = useMemo(
    () => fillMissingPeriods(tokenData?.points ?? [], granularity, range),
    [tokenData, granularity, range],
  );

  const selectedPoint = chartPoints.find((p) => p.period === selectedPeriod) ?? null;

  const deleteTokenMutation = useMutation({
    mutationFn: (target: { date: string } | { month: string } | { scope: 'all' }) =>
      adminApi.deleteTokenUsage(target),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['admin-token-usage'] });
      setSelectedPeriod(null);
      setTokenMsg(
        res.target === 'all'
          ? t('adminAi.deletedAllTokens', { n: res.deleted })
          : t('adminAi.deletedPeriodTokens', { target: res.target, n: res.deleted }),
      );
      setTimeout(() => setTokenMsg(''), 4000);
    },
  });

  const { data: thresholdData } = useQuery({
    queryKey: ['admin-threshold'],
    queryFn: adminApi.getThreshold,
  });

  useEffect(() => {
    if (thresholdData?.threshold !== undefined) {
      setThresholdInput(thresholdData.threshold);
    }
  }, [thresholdData]);

  const { data: linksCountData } = useQuery({
    queryKey: ['admin-related-links-count'],
    queryFn: adminApi.getRelatedLinksCount,
  });

  useEffect(() => {
    if (linksCountData?.count !== undefined) {
      setLinksCountInput(linksCountData.count);
    }
  }, [linksCountData]);

  const { data: rateLimitData } = useQuery<RateLimitSettings>({
    queryKey: ['admin-rate-limit'],
    queryFn: adminApi.getRateLimit,
  });

  useEffect(() => {
    if (rateLimitData) {
      setAiChatLimitInput(rateLimitData.aiChatLimit);
      setGeneralLimitInput(rateLimitData.generalLimit);
    }
  }, [rateLimitData]);

  const { data: aiProviderData } = useQuery<AIProviderSettings>({
    queryKey: ['admin-ai-provider'],
    queryFn: adminApi.getAIProvider,
  });

  useEffect(() => {
    if (aiProviderData) {
      setProviderInput(aiProviderData.providerId);
      setModelInput(aiProviderData.model);
    }
  }, [aiProviderData]);

  const selectedProvider = aiProviderData?.providers.find((p) => p.id === providerInput);

  /** Đổi provider thì đưa model về mặc định của provider đó (model id không dùng chung được). */
  const handleProviderChange = (nextProviderId: string) => {
    setProviderInput(nextProviderId);
    setTestResult(null);
    // Danh sách model của provider cũ không dùng được cho provider mới
    setFetchedModels(null);
    setModelsMsg('');
    const next = aiProviderData?.providers.find((p) => p.id === nextProviderId);
    setModelInput(
      nextProviderId === aiProviderData?.providerId
        ? (aiProviderData?.model ?? '')
        : (next?.defaultModel ?? '')
    );
  };

  const thresholdMutation = useMutation({
    mutationFn: (val: number) => adminApi.updateThreshold(val),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-threshold'] });
      setThresholdMsg(t('adminAi.thresholdSaved'));
      setTimeout(() => setThresholdMsg(''), 4000);
    },
  });

  const linksCountMutation = useMutation({
    mutationFn: (val: number) => adminApi.updateRelatedLinksCount(val),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-related-links-count'] });
      setLinksCountMsg(t('adminAi.linksSaved'));
      setTimeout(() => setLinksCountMsg(''), 4000);
    },
  });

  const rateLimitMutation = useMutation({
    mutationFn: () => adminApi.updateRateLimit(aiChatLimitInput, generalLimitInput),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-rate-limit'] });
      setRateLimitError('');
      setRateLimitMsg(t('adminAi.rateLimitSaved'));
      setTimeout(() => setRateLimitMsg(''), 4000);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setRateLimitMsg('');
      setRateLimitError(err?.response?.data?.error || t('adminAi.rateLimitSaveFailed'));
    },
  });

  const aiProviderMutation = useMutation({
    mutationFn: () => adminApi.updateAIProvider(providerInput, modelInput.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-ai-provider'] });
      setAiProviderMsg(t('adminAi.providerSaved'));
      setTimeout(() => setAiProviderMsg(''), 4000);
    },
  });

  const listModelsMutation = useMutation({
    mutationFn: () => adminApi.listAIProviderModels(providerInput),
    onSuccess: (res) => {
      setFetchedModels(res.models);
      setModelsMsg(
        !res.supported
          ? t('adminAi.modelsUnsupported')
          : res.models.length === 0
            ? t('adminAi.modelsEmpty')
            : t('adminAi.modelsLoaded', { n: res.models.length }),
      );
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setFetchedModels(null);
      setModelsMsg(err.response?.data?.error ?? t('adminAi.modelsLoadFailed'));
    },
  });

  const aiProviderTestMutation = useMutation({
    mutationFn: () => adminApi.testAIProvider(providerInput, modelInput.trim() || undefined),
    onSuccess: (result) => setTestResult(result),
    // Backend trả 400 kèm lý do cụ thể (sai model, thiếu key, hết quota) — hiển thị thẳng cho Admin
    onError: (err: { response?: { data?: { error?: string } } }) =>
      setTestResult({ ok: false, error: err.response?.data?.error ?? t('adminAi.testCallFailed') }),
  });

  // Custom AI Gateways queries & mutations
  // Thống kê token lưu cổng custom dưới dạng mã `custom_<id>` — hiện tên cổng cho dễ đọc. Cổng đã
  // bị xoá thì không còn tên để tra, giữ nguyên mã.
  const providerName = (id: string) =>
    customGatewaysData?.gateways.find((g) => `custom_${g.id}` === id)?.name ?? id;

  const { data: customGatewaysData, isLoading: customGatewaysLoading } = useQuery<{ gateways: CustomAIGateway[] }>({
    queryKey: ['admin-ai-gateways'],
    queryFn: adminApi.listCustomAIGateways,
  });

  const createGatewayMutation = useMutation({
    mutationFn: (data: Parameters<typeof adminApi.createCustomAIGateway>[0]) => adminApi.createCustomAIGateway(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-ai-gateways'] });
      queryClient.invalidateQueries({ queryKey: ['admin-ai-provider'] });
      closeGatewayForm();
      setGatewaySuccessMsg(t('adminAi.gatewaySaved'));
      setTimeout(() => setGatewaySuccessMsg(''), 4000);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setGatewayFormError(err.response?.data?.error || t('adminAi.gatewaySaveFailed'));
    },
  });

  const updateGatewayMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof adminApi.updateCustomAIGateway>[1] }) =>
      adminApi.updateCustomAIGateway(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-ai-gateways'] });
      queryClient.invalidateQueries({ queryKey: ['admin-ai-provider'] });
      closeGatewayForm();
      setGatewaySuccessMsg(t('adminAi.gatewaySaved'));
      setTimeout(() => setGatewaySuccessMsg(''), 4000);
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setGatewayFormError(err.response?.data?.error || t('adminAi.gatewaySaveFailed'));
    },
  });

  const deleteGatewayMutation = useMutation({
    mutationFn: (id: string) => adminApi.deleteCustomAIGateway(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-ai-gateways'] });
      queryClient.invalidateQueries({ queryKey: ['admin-ai-provider'] });
      setGatewaySuccessMsg(t('adminAi.gatewayDeleted'));
      setTimeout(() => setGatewaySuccessMsg(''), 4000);
    },
  });

  const directTestMutation = useMutation({
    mutationFn: () =>
      adminApi.testDirectCustomGateway({
        baseUrl: gatewayForm.baseUrl,
        apiKey: gatewayForm.apiKey,
        model: gatewayForm.defaultModel,
      }),
    onSuccess: (res) => setDirectTestResult(res),
    onError: (err: { response?: { data?: { error?: string } } }) =>
      setDirectTestResult({ ok: false, error: err.response?.data?.error || t('adminAi.testCallFailed') }),
  });

  const directListModelsMutation = useMutation({
    mutationFn: () =>
      adminApi.listDirectCustomGatewayModels({
        baseUrl: gatewayForm.baseUrl,
        apiKey: gatewayForm.apiKey,
      }),
    onSuccess: (res) => {
      setDirectFetchedModels(res.models);
      setDirectModelsMsg(
        !res.supported
          ? t('adminAi.modelsUnsupported')
          : res.models.length === 0
            ? t('adminAi.modelsEmpty')
            : t('adminAi.modelsLoaded', { n: res.models.length }),
      );
    },
    onError: (err: { response?: { data?: { error?: string } } }) => {
      setDirectFetchedModels(null);
      setDirectModelsMsg(err.response?.data?.error || t('adminAi.modelsLoadFailed'));
    },
  });

  const openCreateGatewayForm = () => {
    setEditingGatewayId(null);
    setGatewayForm({
      name: '',
      baseUrl: '',
      apiKey: '',
      defaultModel: '',
      isActive: true,
    });
    setGatewayFormError('');
    setDirectTestResult(null);
    setDirectFetchedModels(null);
    setDirectModelsMsg('');
    setShowGatewayForm(true);
  };

  const openEditGatewayForm = (gateway: CustomAIGateway) => {
    setEditingGatewayId(gateway.id);
    setGatewayForm({
      name: gateway.name,
      baseUrl: gateway.baseUrl,
      apiKey: '', // để trống nếu giữ nguyên key cũ
      defaultModel: gateway.defaultModel,
      isActive: gateway.isActive,
    });
    setGatewayFormError('');
    setDirectTestResult(null);
    setDirectFetchedModels(gateway.suggestedModels);
    setDirectModelsMsg('');
    setShowGatewayForm(true);
  };

  const closeGatewayForm = () => {
    setShowGatewayForm(false);
    setEditingGatewayId(null);
    setGatewayForm({
      name: '',
      baseUrl: '',
      apiKey: '',
      defaultModel: '',
      isActive: true,
    });
    setGatewayFormError('');
    setDirectTestResult(null);
    setDirectFetchedModels(null);
    setDirectModelsMsg('');
  };

  const handleSaveGateway = () => {
    if (!gatewayForm.name.trim() || !gatewayForm.baseUrl.trim() || !gatewayForm.defaultModel.trim()) {
      setGatewayFormError(t('adminAi.gatewayRequiredFields'));
      return;
    }
    if (!editingGatewayId && !gatewayForm.apiKey.trim()) {
      setGatewayFormError(t('adminAi.gatewayApiKeyRequired'));
      return;
    }

    if (editingGatewayId) {
      updateGatewayMutation.mutate({
        id: editingGatewayId,
        data: {
          name: gatewayForm.name,
          baseUrl: gatewayForm.baseUrl,
          apiKey: gatewayForm.apiKey.trim() || undefined,
          defaultModel: gatewayForm.defaultModel,
          suggestedModels: directFetchedModels ?? undefined,
          isActive: gatewayForm.isActive,
        },
      });
    } else {
      createGatewayMutation.mutate({
        ...gatewayForm,
        suggestedModels: directFetchedModels ?? [gatewayForm.defaultModel],
      });
    }
  };

  const handleDeleteGateway = async (gateway: CustomAIGateway) => {
    const ok = await confirm(
      t('adminAi.confirmDeleteGatewayMsg', { name: gateway.name }),
      {
        title: t('adminAi.confirmDeleteGatewayTitle'),
        confirmLabel: t('common.delete'),
      },
    );
    if (ok) {
      deleteGatewayMutation.mutate(gateway.id);
    }
  };

  const handleDeleteSelected = async () => {
    if (!selectedPoint) return;
    const label = formatPeriodLabel(selectedPoint.period, granularity);
    const ok = await confirm(
      t('adminAi.confirmDeletePeriod', { label, tokens: formatFull(selectedPoint.totalTokens) }),
      {
        title: granularity === 'day' ? t('adminAi.confirmDeleteDayTitle') : t('adminAi.confirmDeleteMonthTitle'),
        confirmLabel: t('common.delete'),
      },
    );
    if (!ok) return;

    deleteTokenMutation.mutate(
      granularity === 'day' ? { date: selectedPoint.period } : { month: selectedPoint.period },
    );
  };

  const handleDeleteAll = async () => {
    const ok = await confirm(
      t('adminAi.confirmDeleteAll'),
      { title: t('adminAi.confirmDeleteAllTitle'), confirmLabel: t('adminAi.deleteAllConfirmLabel') },
    );
    if (!ok) return;

    deleteTokenMutation.mutate({ scope: 'all' });
  };

  const statCard = (icon: string, label: string, value: string, color: string) => (
    <div className="card-custom" style={{ padding: '1.25rem', flex: 1, minWidth: '180px' }}>
      <div style={{ fontSize: '1.25rem', marginBottom: '0.375rem' }}>{icon}</div>
      <div style={{ fontSize: '1.75rem', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>{label}</div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 className="page-title">⚙️ {t('layout.nav.aiSettings')}</h1>
        <p className="page-subtitle">{t('adminAi.subtitle')}</p>
      </div>

      {/* Biểu đồ token */}
      <div className="card-custom card-section">
        <h3 className="card-section-title">📈 {t('adminAi.tokenTitle')}</h3>
        <p className="card-section-desc">
          <Trans
            i18nKey="adminAi.tokenDesc"
            values={{ months: tokenData?.retentionMonths ?? 12 }}
            components={{ b: <strong /> }}
          />
        </p>

        {tokenMsg && (
          <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
            ✅ {tokenMsg}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
          <button
            id="btn-token-granularity-day"
            className={granularity === 'day' ? 'btn-primary-custom btn-sm' : 'btn-ghost btn-sm'}
            onClick={() => { setGranularity('day'); setSelectedPeriod(null); }}
          >
            {t('adminAi.byDay', { n: DAY_RANGE })}
          </button>
          <button
            id="btn-token-granularity-month"
            className={granularity === 'month' ? 'btn-primary-custom btn-sm' : 'btn-ghost btn-sm'}
            onClick={() => { setGranularity('month'); setSelectedPeriod(null); }}
          >
            {t('adminAi.byMonth', { n: MONTH_RANGE })}
          </button>
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          {statCard('🔢', t('adminAi.totalTokens'), formatFull(tokenData?.totals.totalTokens ?? 0), 'var(--color-primary-text)')}
          {statCard('⬇️', t('adminAi.inputTokens'), formatFull(tokenData?.totals.inputTokens ?? 0), 'var(--color-text)')}
          {statCard('⬆️', t('adminAi.outputTokens'), formatFull(tokenData?.totals.outputTokens ?? 0), 'var(--color-accent-text)')}
          {statCard('💬', t('adminAi.requestCount'), formatFull(tokenData?.totals.requestCount ?? 0), 'var(--color-text)')}
        </div>

        {tokenLoading ? (
          <div style={{ textAlign: 'center', padding: '3rem' }}>
            <div className="spinner-custom" style={{ margin: '0 auto', width: 32, height: 32 }} />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '0.5rem', fontSize: '0.8125rem', color: 'var(--color-text-muted-strong)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--color-primary)' }} /> {t('adminAi.tokenIn')}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem' }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--color-accent)' }} /> {t('adminAi.tokenOut')}
              </span>
              <span style={{ marginLeft: 'auto' }}>
                {granularity === 'day' ? t('adminAi.pickDayHint') : t('adminAi.pickMonthHint')}
              </span>
            </div>

            {/* Biểu đồ nhiều cột không thu nhỏ được thêm trên màn hẹp — cho cuộn ngang trong khung riêng */}
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 520 }}>
                <TokenChart
                  points={chartPoints}
                  granularity={granularity}
                  selected={selectedPeriod}
                  onSelect={(p) => setSelectedPeriod((prev) => (prev === p ? null : p))}
                />
              </div>
            </div>
          </>
        )}

        {/* Xoá dữ liệu — độc lập hoàn toàn với nút "Xoá dữ liệu thống kê" bên trang Thống kê */}
        <div
          style={{
            marginTop: '1.25rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--color-border)',
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: '240px', fontSize: '0.875rem', color: 'var(--color-text-muted-strong)' }}>
            {selectedPoint
              ? t('adminAi.selectedPeriod', {
                  period: formatPeriodLabel(selectedPoint.period, granularity),
                  tokens: formatFull(selectedPoint.totalTokens),
                  requests: selectedPoint.requestCount,
                })
              : granularity === 'day'
                ? t('adminAi.noDaySelected')
                : t('adminAi.noMonthSelected')}
          </div>

          <button
            id="btn-delete-token-selected"
            className="btn-ghost btn-sm"
            onClick={handleDeleteSelected}
            disabled={!selectedPoint || selectedPoint.totalTokens === 0 || deleteTokenMutation.isPending}
          >
            🗑️ {granularity === 'day' ? t('adminAi.deleteSelectedDay') : t('adminAi.deleteSelectedMonth')}
          </button>

          <button
            id="btn-delete-token-all"
            className="btn-danger-custom btn-sm"
            onClick={handleDeleteAll}
            disabled={deleteTokenMutation.isPending}
          >
            🗑️ {t('adminAi.deleteAllTokens')}
          </button>
        </div>

        {(tokenData?.byModel.length ?? 0) > 0 && (
          <div style={{ marginTop: '1.25rem' }}>
            <h4 style={{ fontWeight: 600, fontSize: '0.9375rem', marginBottom: '0.625rem' }}>{t('adminAi.byModel')}</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
              {tokenData?.byModel.map((m) => (
                <div
                  key={`${m.provider}-${m.model}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    padding: '0.5rem 0.875rem',
                    background: 'var(--color-surface-2)',
                    borderRadius: 8,
                    fontSize: '0.875rem',
                  }}
                >
                  <span style={{ wordBreak: 'break-all' }}>
                    <strong>{providerName(m.provider)}</strong> / {m.model}
                  </span>
                  <span style={{ whiteSpace: 'nowrap', color: 'var(--color-text-muted-strong)' }}>
                    {t('adminAi.modelUsage', { tokens: formatFull(m.totalTokens), requests: m.requestCount })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Config: AI Chat Provider */}
      <div className="card-custom card-section">
        <h3 className="card-section-title">🤖 {t('adminAi.providerTitle')}</h3>

        {aiProviderMsg && (
          <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
            ✅ {aiProviderMsg}
          </div>
        )}

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div style={{ flex: '1', minWidth: '220px' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem', color: 'var(--color-text-muted)' }}>
              Provider
            </label>
            <select
              id="select-ai-provider"
              className="text-input"
              value={providerInput}
              onChange={(e) => handleProviderChange(e.target.value)}
              style={{ width: '100%' }}
            >
              {aiProviderData?.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} {p.hasApiKey ? '' : t('adminAi.noApiKeyTag')}
                </option>
              ))}
            </select>
          </div>

          <div style={{ flex: '2', minWidth: '260px' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem', color: 'var(--color-text-muted)' }}>
              Model
            </label>
            {/* Nhập tự do vì danh mục model của các cổng trung chuyển bị đổi/gỡ liên tục — danh sách
                gợi ý chỉ để tham khảo nhanh, không giới hạn lựa chọn của Admin. */}
            <input
              id="input-ai-model"
              className="text-input"
              list="ai-model-suggestions"
              value={modelInput}
              onChange={(e) => { setModelInput(e.target.value); setTestResult(null); }}
              placeholder={selectedProvider?.defaultModel ?? t('adminAi.modelPlaceholder')}
              style={{ width: '100%' }}
            />
            {/* Đã bấm tải thì dùng danh sách thật từ nhà cung cấp, chưa tải thì dùng gợi ý cứng */}
            <datalist id="ai-model-suggestions">
              {(fetchedModels ?? selectedProvider?.suggestedModels ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
              <button
                id="btn-load-ai-models"
                className="btn-ghost btn-sm"
                onClick={() => listModelsMutation.mutate()}
                disabled={listModelsMutation.isPending}
                type="button"
              >
                {listModelsMutation.isPending ? `⏳ ${t('adminAi.loadingModels')}` : `🔄 ${t('adminAi.loadModels')}`}
              </button>
              {modelsMsg && (
                <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted-strong)' }}>{modelsMsg}</span>
              )}
            </div>

            {(fetchedModels?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: '0.625rem' }}>
                {fetchedModels?.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={m === modelInput ? 'btn-primary-custom btn-sm' : 'btn-ghost btn-sm'}
                    onClick={() => { setModelInput(m); setTestResult(null); }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {selectedProvider && !selectedProvider.hasApiKey && (
          <div style={{ background: 'rgba(245,158,11,.1)', color: 'var(--color-warning)', padding: '0.625rem 1rem', borderRadius: 8, fontSize: '0.875rem', marginBottom: '1rem' }}>
            ⚠️{' '}
            <Trans
              i18nKey="adminAi.missingApiKey"
              values={{ provider: selectedProvider.label, envName: selectedProvider.apiKeyEnvName }}
              components={{ c: <code /> }}
            />
          </div>
        )}

        {testResult && (
          <div
            style={{
              background: testResult.ok ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)',
              color: testResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
              padding: '0.625rem 1rem',
              borderRadius: 8,
              fontSize: '0.875rem',
              marginBottom: '1rem',
              wordBreak: 'break-word',
            }}
          >
            {testResult.ok
              ? `✅ ${t('adminAi.testOk', { model: testResult.model, sample: testResult.sample })}`
              : `❌ ${testResult.error}`}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button
            id="btn-test-ai-provider"
            className="btn-secondary-custom"
            onClick={() => aiProviderTestMutation.mutate()}
            disabled={aiProviderTestMutation.isPending}
            style={{ padding: '0.5rem 1.25rem' }}
          >
            {aiProviderTestMutation.isPending ? `⏳ ${t('adminAi.testing')}` : `🔌 ${t('adminAi.testConnection')}`}
          </button>

          <button
            id="btn-save-ai-provider"
            className="btn-primary-custom"
            onClick={() => aiProviderMutation.mutate()}
            disabled={aiProviderMutation.isPending || !modelInput.trim()}
            style={{ padding: '0.5rem 1.25rem' }}
          >
            {aiProviderMutation.isPending ? `⏳ ${t('wiki.saving')}` : `💾 ${t('adminAi.saveProvider')}`}
          </button>
        </div>
      </div>

      {/* Config: Custom AI Gateways (Public Gateways) */}
      <div className="card-custom card-section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <h3 className="card-section-title" style={{ marginBottom: 0 }}>🌐 {t('adminAi.customGatewaysTitle')}</h3>
          </div>
          <button
            id="btn-add-custom-gateway"
            className="btn-primary-custom btn-sm"
            onClick={openCreateGatewayForm}
            type="button"
          >
            + {t('adminAi.addCustomGateway')}
          </button>
        </div>

        {gatewaySuccessMsg && (
          <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
            ✅ {gatewaySuccessMsg}
          </div>
        )}

        {/* Create / Edit Gateway Form */}
        {showGatewayForm && (
          <div
            style={{
              background: 'var(--color-surface-2)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              padding: '1.25rem',
              marginBottom: '1.25rem',
            }}
          >
            <h4 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '0.9375rem' }}>
              {editingGatewayId ? `✏️ ${t('adminAi.editGatewayTitle')}` : `➕ ${t('adminAi.createGatewayTitle')}`}
            </h4>

            {gatewayFormError && (
              <div className="alert-box alert-danger" style={{ marginBottom: '0.75rem' }}>
                ⚠️ {gatewayFormError}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
              <div>
                <label className="input-label" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}>
                  {t('adminAi.gatewayNameLabel')} *
                </label>
                <input
                  type="text"
                  className="text-input"
                  style={{ width: '100%' }}
                  placeholder={t('adminAi.gatewayNamePlaceholder')}
                  value={gatewayForm.name}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, name: e.target.value })}
                />
              </div>

              <div>
                <label className="input-label" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}>
                  {t('adminAi.gatewayBaseUrlLabel')} *
                </label>
                <input
                  type="text"
                  className="text-input"
                  style={{ width: '100%' }}
                  placeholder={t('adminAi.gatewayBaseUrlPlaceholder')}
                  value={gatewayForm.baseUrl}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, baseUrl: e.target.value })}
                />
              </div>

              <div>
                <label className="input-label" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}>
                  {t('adminAi.gatewayApiKeyLabel')} {editingGatewayId ? '' : '*'}
                </label>
                <input
                  type="password"
                  className="text-input"
                  style={{ width: '100%' }}
                  placeholder={editingGatewayId ? t('adminAi.gatewayApiKeyPlaceholder') : 'sk-...'}
                  value={gatewayForm.apiKey}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, apiKey: e.target.value })}
                />
              </div>

              <div>
                <label className="input-label" style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}>
                  {t('adminAi.gatewayDefaultModelLabel')} *
                </label>
                <input
                  type="text"
                  className="text-input"
                  list="gateway-direct-model-suggestions"
                  style={{ width: '100%' }}
                  placeholder={t('adminAi.gatewayDefaultModelPlaceholder')}
                  value={gatewayForm.defaultModel}
                  onChange={(e) => {
                    setGatewayForm({ ...gatewayForm, defaultModel: e.target.value });
                    setDirectTestResult(null);
                  }}
                />
                <datalist id="gateway-direct-model-suggestions">
                  {(directFetchedModels ?? []).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.875rem' }}>
                <input
                  type="checkbox"
                  checked={gatewayForm.isActive}
                  onChange={(e) => setGatewayForm({ ...gatewayForm, isActive: e.target.checked })}
                />
                <span>{t('adminAi.gatewayStatusLabel')}: {gatewayForm.isActive ? `🟢 ${t('adminAi.gatewayActive')}` : `⚪ ${t('adminAi.gatewayInactive')}`}</span>
              </label>

              <button
                type="button"
                className="btn-ghost btn-sm"
                onClick={() => directListModelsMutation.mutate()}
                disabled={directListModelsMutation.isPending || !gatewayForm.baseUrl.trim()}
              >
                {directListModelsMutation.isPending ? `⏳ ${t('adminAi.loadingModels')}` : `🔄 ${t('adminAi.loadModels')}`}
              </button>

              <button
                type="button"
                className="btn-secondary-custom btn-sm"
                onClick={() => directTestMutation.mutate()}
                disabled={directTestMutation.isPending || !gatewayForm.baseUrl.trim() || !gatewayForm.defaultModel.trim()}
              >
                {directTestMutation.isPending ? `⏳ ${t('adminAi.testing')}` : `🔌 ${t('adminAi.testConnection')}`}
              </button>

              {directModelsMsg && (
                <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted-strong)' }}>
                  {directModelsMsg}
                </span>
              )}
            </div>

            {(directFetchedModels?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '1rem' }}>
                {directFetchedModels?.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={m === gatewayForm.defaultModel ? 'btn-primary-custom btn-sm' : 'btn-ghost btn-sm'}
                    onClick={() => {
                      setGatewayForm({ ...gatewayForm, defaultModel: m });
                      setDirectTestResult(null);
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            {directTestResult && (
              <div
                style={{
                  background: directTestResult.ok ? 'rgba(16,185,129,.1)' : 'rgba(239,68,68,.1)',
                  color: directTestResult.ok ? 'var(--color-success)' : 'var(--color-danger)',
                  padding: '0.625rem 1rem',
                  borderRadius: 8,
                  fontSize: '0.875rem',
                  marginBottom: '1rem',
                  wordBreak: 'break-word',
                }}
              >
                {directTestResult.ok
                  ? `✅ ${t('adminAi.testOk', { model: directTestResult.model, sample: directTestResult.sample })}`
                  : `❌ ${directTestResult.error}`}
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn-primary-custom"
                onClick={handleSaveGateway}
                disabled={createGatewayMutation.isPending || updateGatewayMutation.isPending}
                style={{ padding: '0.4rem 1.25rem' }}
              >
                {createGatewayMutation.isPending || updateGatewayMutation.isPending ? `⏳ ${t('wiki.saving')}` : `💾 ${t('adminAi.saveGateway')}`}
              </button>
              <button
                type="button"
                className="btn-secondary-custom"
                onClick={closeGatewayForm}
                style={{ padding: '0.4rem 1rem' }}
              >
                {t('adminAi.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Gateways Table */}
        {customGatewaysLoading ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>⏳ {t('adminAi.gatewayLoading')}</div>
        ) : (customGatewaysData?.gateways.length ?? 0) === 0 ? (
          <div style={{ color: 'var(--color-text-muted)', fontSize: '0.875rem', fontStyle: 'italic', padding: '0.75rem 0' }}>
            {t('adminAi.gatewayNoGateways')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)', textAlign: 'left', color: 'var(--color-text-muted)' }}>
                  <th style={{ padding: '0.5rem 0.75rem' }}>{t('adminAi.gatewayNameLabel')}</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>Base URL</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>{t('adminAi.gatewayDefaultModelLabel')}</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>API Key</th>
                  <th style={{ padding: '0.5rem 0.75rem' }}>{t('adminAi.gatewayStatusLabel')}</th>
                  <th style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{t('adminAi.gatewayActionsCol')}</th>
                </tr>
              </thead>
              <tbody>
                {customGatewaysData?.gateways.map((g) => (
                  <tr key={g.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '0.625rem 0.75rem', fontWeight: 600 }}>{g.name}</td>
                    <td style={{ padding: '0.625rem 0.75rem', color: 'var(--color-text-muted-strong)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {g.baseUrl}
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem' }}>
                      <code style={{ fontSize: '0.8125rem' }}>{g.defaultModel}</code>
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem', color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                      {g.apiKeyMasked || '••••••••'}
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem' }}>
                      <span
                        style={{
                          fontSize: '0.75rem',
                          padding: '0.125rem 0.5rem',
                          borderRadius: 9999,
                          background: g.isActive ? 'rgba(16,185,129,.15)' : 'rgba(107,114,128,.15)',
                          color: g.isActive ? 'var(--color-success)' : 'var(--color-text-muted)',
                        }}
                      >
                        {g.isActive ? t('adminAi.gatewayActive') : t('adminAi.gatewayInactive')}
                      </span>
                    </td>
                    <td style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>
                      <div style={{ display: 'inline-flex', gap: '0.375rem' }}>
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => openEditGatewayForm(g)}
                          title={t('adminAi.editCustomGateway')}
                        >
                          ✏️ {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          style={{ color: 'var(--color-danger)' }}
                          onClick={() => handleDeleteGateway(g)}
                          title={t('adminAi.gatewayDeleteTitle')}
                        >
                          🗑️ {t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Config: Relevance Threshold */}
      <div className="card-custom card-section">
        <h3 className="card-section-title">🎯 {t('adminAi.thresholdTitle')}</h3>
        <p className="card-section-desc">
          <Trans i18nKey="adminAi.thresholdDesc" components={{ b: <strong /> }} />
          <br />
          <span style={{ fontSize: '0.8125rem' }}>
            • <Trans i18nKey="adminAi.thresholdLow" components={{ b: <strong /> }} />
            <br />• <Trans i18nKey="adminAi.thresholdHigh" components={{ b: <strong /> }} />
          </span>
        </p>

        {thresholdMsg && (
          <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
            ✅ {thresholdMsg}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: '1', minWidth: '240px' }}>
            <input
              type="range"
              min="0.10"
              max="0.90"
              step="0.05"
              value={thresholdInput}
              onChange={(e) => setThresholdInput(parseFloat(e.target.value))}
              style={{ flex: 1, cursor: 'pointer' }}
            />
            <span style={{ fontWeight: 700, fontSize: '1.125rem', minWidth: '45px', color: 'var(--color-primary)' }}>
              {thresholdInput.toFixed(2)}
            </span>
          </div>

          <button
            id="btn-save-threshold"
            className="btn-primary-custom"
            onClick={() => thresholdMutation.mutate(thresholdInput)}
            disabled={thresholdMutation.isPending}
            style={{ padding: '0.5rem 1.25rem' }}
          >
            {thresholdMutation.isPending ? `⏳ ${t('wiki.saving')}` : `💾 ${t('adminAi.saveThreshold')}`}
          </button>
        </div>
      </div>

      {/* Config: Related Links Count */}
      <div className="card-custom card-section">
        <h3 className="card-section-title">🔗 {t('adminAi.linksTitle')}</h3>
        <p className="card-section-desc">
          <Trans i18nKey="adminAi.linksDesc" components={{ b: <strong /> }} />
        </p>

        {linksCountMsg && (
          <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
            ✅ {linksCountMsg}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: '1', minWidth: '240px' }}>
            <input
              type="range"
              min="1"
              max="5"
              step="1"
              value={linksCountInput}
              onChange={(e) => setLinksCountInput(parseInt(e.target.value, 10))}
              style={{ flex: 1, cursor: 'pointer' }}
            />
            <span style={{ fontWeight: 700, fontSize: '1.125rem', minWidth: '25px', color: 'var(--color-primary)' }}>
              {linksCountInput}
            </span>
          </div>

          <button
            id="btn-save-links-count"
            className="btn-primary-custom"
            onClick={() => linksCountMutation.mutate(linksCountInput)}
            disabled={linksCountMutation.isPending}
            style={{ padding: '0.5rem 1.25rem' }}
          >
            {linksCountMutation.isPending ? `⏳ ${t('wiki.saving')}` : `💾 ${t('adminAi.saveLinks')}`}
          </button>
        </div>
      </div>

      {/* Config: Rate Limit — số request tối đa trên mỗi IP */}
      <div className="card-custom card-section">
        <h3 className="card-section-title">🚦 {t('adminAi.rateLimitTitle')}</h3>
        <p className="card-section-desc">
          <Trans i18nKey="adminAi.rateLimitDesc" components={{ b: <strong /> }} />
          <br />
          <span style={{ fontSize: '0.8125rem' }}>
            ⚠️ <Trans i18nKey="adminAi.rateLimitWarning" components={{ b: <strong /> }} />
          </span>
        </p>

        {rateLimitMsg && (
          <div className="alert-box alert-success" role="status" style={{ marginBottom: '1rem' }}>
            ✅ {rateLimitMsg}
          </div>
        )}
        {rateLimitError && (
          <div className="alert-box alert-danger" role="alert" style={{ marginBottom: '1rem' }}>
            ⚠️ {rateLimitError}
          </div>
        )}

        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <div style={{ flex: '1', minWidth: '220px' }}>
            <label
              htmlFor="input-ai-chat-limit"
              style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}
            >
              🤖 {t('adminAi.aiChatLimitLabel', { seconds: Math.round((rateLimitData?.aiChatWindowMs ?? 60000) / 1000) })}
            </label>
            <input
              id="input-ai-chat-limit"
              type="number"
              min={rateLimitData?.aiChatRange.min ?? 1}
              max={rateLimitData?.aiChatRange.max ?? 200}
              value={aiChatLimitInput}
              onChange={(e) => setAiChatLimitInput(parseInt(e.target.value, 10) || 0)}
              className="input-custom"
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
              {t('adminAi.rangeHint', {
                min: rateLimitData?.aiChatRange.min ?? 1,
                max: rateLimitData?.aiChatRange.max ?? 200,
                def: 20,
              })}
            </div>
          </div>

          <div style={{ flex: '1', minWidth: '220px' }}>
            <label
              htmlFor="input-general-limit"
              style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, marginBottom: '0.375rem' }}
            >
              🌐 {t('adminAi.generalLimitLabel', { minutes: Math.round((rateLimitData?.generalWindowMs ?? 900000) / 60000) })}
            </label>
            <input
              id="input-general-limit"
              type="number"
              min={rateLimitData?.generalRange.min ?? 10}
              max={rateLimitData?.generalRange.max ?? 2000}
              value={generalLimitInput}
              onChange={(e) => setGeneralLimitInput(parseInt(e.target.value, 10) || 0)}
              className="input-custom"
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', marginTop: '0.25rem' }}>
              {t('adminAi.rangeHint', {
                min: rateLimitData?.generalRange.min ?? 10,
                max: rateLimitData?.generalRange.max ?? 2000,
                def: 300,
              })}
            </div>
          </div>
        </div>

        <button
          id="btn-save-rate-limit"
          className="btn-primary-custom"
          onClick={() => rateLimitMutation.mutate()}
          disabled={rateLimitMutation.isPending}
          style={{ padding: '0.5rem 1.25rem' }}
        >
          {rateLimitMutation.isPending ? `⏳ ${t('wiki.saving')}` : `💾 ${t('adminAi.saveRateLimit')}`}
        </button>
      </div>
    </div>
  );
}
