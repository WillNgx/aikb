import api from './client';

/**
 * Client gọi API Khuyến mãi.
 *
 * Dữ liệu chia 2 tầng giống cách trang mockup làm: `months` nhẹ (chỉ đếm số lượng) nạp ngay khi
 * mở trang, còn danh sách khuyến mãi thì gọi theo TỪNG THÁNG. Trang chỉ tự nạp 2 tháng gần nhất,
 * tháng cũ hơn chờ người dùng bấm mới gọi — để mở trang không phải kéo toàn bộ lịch sử về.
 */

export interface PromotionMonth {
  key: string;
  nam: string;
  thang: string;
  soLuong: number;
}

export interface PromotionMonths {
  months: PromotionMonth[];
  khongHan: number;
  tong: number;
  tongVersion: number;
}

export interface VersionChip {
  id: string;
  versionLabel: string;
  startDate: string | null;
}

export interface PromotionListItem {
  id: string;
  title: string;
  category: string;
  provider: string | null;
  providerLocked: boolean;
  startMonth: string;
  startDate: string | null;
  timeText: string | null;
  summary: string | null;
  versionLabel: string;
  versionCount: number;
  /** Mới nhất đứng đầu — để thẻ hiện dãy nhãn phiên bản và bấm thẳng vào một bản cũ. */
  versions: VersionChip[];
  nodeId: string | null;
}

export interface PromotionVersionSummary {
  id: string;
  versionLabel: string;
  startDate: string | null;
  timeText: string | null;
  importedAt: string;
  isLatest: boolean;
}

export interface PromotionDetail extends PromotionListItem {
  content: string;
  versions: PromotionVersionSummary[];
}

export interface ImportDiffEntry {
  title: string;
  provider: string | null;
  versionLabel: string;
  reason?: string;
}

export interface ImportDiff {
  total: number;
  created: ImportDiffEntry[];
  versioned: ImportDiffEntry[];
  unchangedCount: number;
  invalid: { title: string; reason: string }[];
}

export interface ImportProgress {
  status: 'idle' | 'running' | 'done';
  total: number;
  processed: number;
  success: number;
  failed: number;
  failedTitles: string[];
  startedAt: string | null;
  finishedAt: string | null;
}

/** Nhóm dành cho khuyến mãi không ghi thời hạn (toàn bộ nhóm Hoàn trả). */
export const KHONG_HAN = 'khong-han';

export const promotionsApi = {
  months: (): Promise<PromotionMonths> => api.get('/promotions/months').then((r) => r.data),

  byMonth: (month: string): Promise<PromotionListItem[]> =>
    api.get('/promotions', { params: { month } }).then((r) => r.data.items),

  detail: (id: string, versionId?: string): Promise<PromotionDetail> =>
    api.get(`/promotions/${id}`, { params: versionId ? { versionId } : undefined }).then((r) => r.data),

  providerOptions: (): Promise<string[]> =>
    api.get('/promotions/provider-options').then((r) => r.data.options),

  // ── Admin ──
  importPreview: (payload: unknown): Promise<ImportDiff> =>
    api.post('/admin/promotions/import/preview', { payload }).then((r) => r.data),

  importCommit: (payload: unknown, sourceFile: string): Promise<ImportDiff> =>
    api.post('/admin/promotions/import/commit', { payload, sourceFile }).then((r) => r.data),

  importProgress: (): Promise<ImportProgress> =>
    api.get('/admin/promotions/import/progress').then((r) => r.data),

  setProvider: (id: string, provider: string | null): Promise<void> =>
    api.patch(`/admin/promotions/${id}/provider`, { provider }).then(() => undefined),
};
