import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuthUser } from '../api';
import i18n from '../lib/i18n';
import {
  KHONG_HAN,
  promotionsApi,
  type ImportDiff,
  type PromotionDetail,
  type PromotionListItem,
} from '../api/promotions';
import { useAlert } from '../components/ConfirmModal';

/**
 * Trang Khuyến mãi.
 *
 * Dữ liệu chia theo THÁNG dựa trên ngày bắt đầu của khuyến mãi. Mở trang chỉ nạp 2 tháng gần
 * nhất + nhóm "Không giới hạn thời gian"; các tháng cũ hơn chỉ gọi API khi người dùng bấm, để
 * trang không phải kéo toàn bộ lịch sử về ngay từ đầu.
 *
 * Nhóm "Không giới hạn thời gian" CỐ Ý luôn nạp sẵn dù không thuộc 2 tháng gần nhất: toàn bộ
 * khuyến mãi Hoàn trả nằm trong đó (nội dung không ghi thời hạn) và đây là nhóm được tra nhiều
 * nhất — ẩn sau một nút bấm là hỏng việc.
 */

// ─── Tiện ích ─────────────────────────────────────────────────────────────────

function boDau(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function tenThang(key: string): string {
  if (key === KHONG_HAN) return i18n.t('promo.noTimeLimit');
  return i18n.t('promo.monthLabel', { month: Number(key.slice(5)), year: key.slice(0, 4) });
}

function ngayVn(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

// ─── Phân tích nội dung thô thành khối có cấu trúc ────────────────────────────
// Nội dung lưu nguyên văn dạng text (mỗi dòng một ý). Quy tắc nhận dạng giống hệt bên backend
// khi dựng tài liệu cho AI: dòng có tab -> hàng bảng, dòng viết hoa -> tiêu đề mục,
// dòng mở đầu bằng * hoặc ( -> ghi chú.

type Block =
  | { loai: 'de'; chu: string }
  | { loai: 'doan'; chu: string }
  | { loai: 'ghi-chu'; chu: string }
  | { loai: 'bang'; hang: string[][] };

function phanTichNoiDung(noiDung: string, tenKm: string): Block[] {
  const dong = noiDung.replace(/\r\n/g, '\n').split('\n');
  const khoi: Block[] = [];
  let bangTam: string[][] = [];

  const chotBang = () => {
    if (bangTam.length) {
      khoi.push({ loai: 'bang', hang: bangTam.slice() });
      bangTam = [];
    }
  };

  dong.forEach((raw, i) => {
    const d = raw.trim();
    if (!d) {
      chotBang();
      return;
    }
    if (i < 3 && (d === 'CHI TIẾT KHUYẾN MÃI' || d === tenKm)) return;

    if (raw.includes('\t')) {
      bangTam.push(raw.split('\t').map((o) => o.trim()));
      return;
    }
    chotBang();

    const chuCai = d.replace(/[^A-Za-zÀ-ỹ]/g, '');
    if (chuCai.length > 1 && chuCai === chuCai.toUpperCase() && d.length <= 70) {
      khoi.push({ loai: 'de', chu: d });
    } else if (/^[*(]/.test(d)) {
      khoi.push({ loai: 'ghi-chu', chu: d });
    } else {
      khoi.push({ loai: 'doan', chu: d });
    }
  });
  chotBang();
  return khoi;
}

function NoiDungKhuyenMai({ noiDung, tenKm }: { noiDung: string; tenKm: string }) {
  const khoi = useMemo(() => phanTichNoiDung(noiDung, tenKm), [noiDung, tenKm]);

  return (
    <>
      {khoi.map((k, i) => {
        if (k.loai === 'de') return <p key={i} className="promo-h">{k.chu}</p>;
        if (k.loai === 'ghi-chu') return <p key={i} className="promo-note">{k.chu}</p>;
        if (k.loai === 'doan') return <p key={i} className="promo-p">{k.chu}</p>;

        const soCot = Math.max(...k.hang.map((h) => h.length));
        // Hàng đầu chỉ là tiêu đề khi nó đủ cột và không mang số liệu.
        const coTieuDe =
          k.hang.length > 1 &&
          k.hang[0].length === soCot &&
          !k.hang[0].some((o) => /^[\d.,%]+$/.test(o));
        const hangThan = k.hang.slice(coTieuDe ? 1 : 0);

        return (
          <div key={i} className="promo-table-wrap">
            <table className="promo-table">
              {coTieuDe && (
                <thead>
                  <tr>
                    {Array.from({ length: soCot }, (_, c) => (
                      <th key={c}>{k.hang[0][c] ?? ''}</th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {hangThan.map((h, r) => (
                  <tr key={r}>
                    {Array.from({ length: soCot }, (_, c) => (
                      <td key={c}>{h[c] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

// ─── Badge sảnh áp dụng (Admin bấm vào để đổi) ────────────────────────────────

function ProviderBadge({
  promotion,
  isAdmin,
  onChanged,
}: {
  promotion: PromotionListItem;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [dangSua, setDangSua] = useState(false);
  const thongBao = useAlert();
  const { t } = useTranslation();
  const { data: options = [] } = useQuery({
    queryKey: ['promo-provider-options'],
    queryFn: promotionsApi.providerOptions,
    enabled: isAdmin,
    staleTime: Infinity,
  });

  const doiSanh = useMutation({
    mutationFn: (provider: string | null) => promotionsApi.setProvider(promotion.id, provider),
    onSuccess: () => {
      setDangSua(false);
      onChanged();
    },
    onError: () => thongBao(t('promo.setProviderFailed')),
  });

  if (dangSua) {
    return (
      <select
        className="promo-provider-select"
        autoFocus
        defaultValue={promotion.provider ?? ''}
        disabled={doiSanh.isPending}
        onBlur={() => setDangSua(false)}
        onChange={(e) => doiSanh.mutate(e.target.value || null)}
      >
        <option value="">— {t('promo.unclassified')} —</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  const nhan = promotion.provider ?? t('promo.unknownProvider');
  const lop = `promo-provider${promotion.provider ? '' : ' empty'}`;

  if (!isAdmin) return <span className={lop}>{nhan}</span>;

  return (
    <button
      type="button"
      className={lop}
      title={t('promo.changeProviderTitle')}
      onClick={(e) => {
        e.stopPropagation();
        setDangSua(true);
      }}
    >
      {nhan} ✎
    </button>
  );
}

// ─── Thẻ khuyến mãi ───────────────────────────────────────────────────────────

function PromotionCard({
  km,
  isAdmin,
  onOpen,
  onChanged,
}: {
  km: PromotionListItem;
  isAdmin: boolean;
  onOpen: (versionId?: string) => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  return (
    <article className="promo-card">
      <div className="promo-card-tags">
        <span className="promo-tag">{km.category}</span>
        <ProviderBadge promotion={km} isAdmin={isAdmin} onChanged={onChanged} />
        {km.versionCount > 1 && (
          <span className="promo-tag promo-tag-version">
            {t('promo.versionCount', { n: km.versionCount })}
          </span>
        )}
      </div>

      <h3>{km.title}</h3>
      <p className="promo-excerpt">{km.summary}</p>

      <div className="promo-meta">
        <div>
          {t('promo.startsAt')}: <b>{ngayVn(km.startDate)}</b>
        </div>
        <div>{km.timeText || t('promo.noTimeInContent')}</div>
      </div>

      {km.versionCount > 1 && (
        <div className="promo-versions">
          <span className="promo-versions-label">{t('promo.versions')}:</span>
          {km.versions.map((v, i) => (
            <button
              key={v.id}
              type="button"
              className={`promo-chip${i === 0 ? ' latest' : ''}`}
              title={
                (i === 0 ? `${t('promo.latest')} — ` : '') +
                (v.startDate
                  ? t('promo.startsAtShort', { date: ngayVn(v.startDate) })
                  : t('promo.noStartDate'))
              }
              onClick={() => onOpen(v.id)}
            >
              ver {v.versionLabel}
            </button>
          ))}
        </div>
      )}

      <div className="promo-card-actions">
        <button type="button" className="btn-secondary-custom btn-sm" onClick={() => onOpen()}>
          {t('promo.viewDetail')}
        </button>
      </div>
    </article>
  );
}

// ─── Hộp chi tiết ─────────────────────────────────────────────────────────────

function DetailModal({
  id,
  initialVersionId,
  onClose,
}: {
  id: string;
  initialVersionId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [versionId, setVersionId] = useState<string | undefined>(initialVersionId);
  const [moMenu, setMoMenu] = useState(false);

  const { data, isLoading } = useQuery<PromotionDetail>({
    queryKey: ['promo-detail', id, versionId ?? 'latest'],
    queryFn: () => promotionsApi.detail(id, versionId),
  });

  const banCu = !!data && !data.versions.find((v) => v.id === (versionId ?? data.versions[0]?.id))?.isLatest;

  return (
    <div className="promo-modal-backdrop" onClick={onClose} role="presentation">
      <div className="promo-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="promo-modal-head">
          <div style={{ minWidth: 0 }}>
            <h2>{data?.title ?? t('common.loading')}</h2>
            <div className="d-flex align-items-center gap-2 flex-wrap">
              {data && <span className="promo-tag">{data.category}</span>}
              {data && <span className="promo-provider">{data.provider ?? t('promo.unknownProvider')}</span>}
              {data && (
                <div className="promo-ver-picker">
                  <button
                    type="button"
                    className="promo-ver-badge"
                    disabled={data.versionCount < 2}
                    aria-expanded={moMenu}
                    onClick={() => setMoMenu((v) => !v)}
                  >
                    <span className="promo-ver-num">{data.versionCount}</span>
                    {data.versionCount > 1 ? t('promo.versionsWord') : t('promo.onlyVersion')} ▾
                  </button>

                  {moMenu && (
                    <div className="promo-ver-menu">
                      <div className="promo-ver-hint">
                        {t('promo.versionHint')}
                      </div>
                      {data.versions.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          className={`promo-ver-item${v.id === data.versions.find((x) => x.id === (versionId ?? data.versions[0].id))?.id ? ' active' : ''}`}
                          onClick={() => {
                            setVersionId(v.id);
                            setMoMenu(false);
                          }}
                        >
                          <span className="promo-ver-code">ver {v.versionLabel}</span>
                          <span className="promo-ver-desc">
                            {v.startDate
                              ? t('promo.versionDesc', {
                                  start: ngayVn(v.startDate),
                                  imported: ngayVn(v.importedAt),
                                })
                              : t('promo.versionDescNoStart', { imported: ngayVn(v.importedAt) })}
                          </span>
                          {v.isLatest && <span className="promo-ver-now">{t('promo.latestShort')}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <button type="button" className="promo-close" onClick={onClose} title={t('common.close')}>
            ✕
          </button>
        </div>

        <div className="promo-modal-body">
          {isLoading && <div className="spinner-custom mx-auto" />}
          {data && (
            <>
              <div className="promo-time">
                <span className="promo-time-label">{t('promo.timeLabel')}</span>
                <span className="promo-time-value">{data.timeText || t('promo.noTimeText')}</span>
                <span className="promo-soft-badge muted ms-auto">
                  {t('promo.viewingVersion', { ver: data.versionLabel })}{' '}
                  {banCu ? t('promo.oldVersionTag') : t('promo.latestVersionTag')}
                </span>
              </div>

              {banCu && (
                <div className="alert-box alert-warning" role="status">
                  {t('promo.oldVersionWarning', {
                    ver: data.versionLabel,
                    latest: data.versions.find((v) => v.isLatest)?.versionLabel,
                  })}
                </div>
              )}

              <NoiDungKhuyenMai noiDung={data.content} tenKm={data.title} />
            </>
          )}
        </div>

        <div className="promo-modal-foot">
          <button type="button" className="btn-primary-custom" onClick={onClose}>
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Hộp nhập dữ liệu (Admin) ─────────────────────────────────────────────────

type BuocNhap = 'chon-file' | 'ket-qua' | 'dang-chay';

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [buoc, setBuoc] = useState<BuocNhap>('chon-file');
  const [tenFile, setTenFile] = useState('');
  const [payload, setPayload] = useState<unknown>(null);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [loi, setLoi] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: progress } = useQuery({
    queryKey: ['promo-import-progress'],
    queryFn: promotionsApi.importProgress,
    enabled: buoc === 'dang-chay',
    refetchInterval: 1500,
  });

  const doiFile = (file: File | undefined) => {
    if (!file) return;
    setLoi('');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setPayload(JSON.parse(String(reader.result)));
        setTenFile(file.name);
      } catch {
        setLoi(t('promo.invalidJson'));
        setPayload(null);
      }
    };
    reader.readAsText(file);
  };

  const kiemTra = useMutation({
    mutationFn: () => promotionsApi.importPreview(payload),
    onSuccess: (d) => {
      setDiff(d);
      setBuoc('ket-qua');
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      setLoi(e.response?.data?.error ?? t('promo.readFileFailed')),
  });

  const chay = useMutation({
    mutationFn: () => promotionsApi.importCommit(payload, tenFile),
    onSuccess: (d) => {
      setDiff(d);
      setBuoc('dang-chay');
      onDone();
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      setLoi(e.response?.data?.error ?? t('promo.writeFailed')),
  });

  const soThayDoi = (diff?.created.length ?? 0) + (diff?.versioned.length ?? 0);

  return (
    <div className="promo-modal-backdrop" onClick={onClose} role="presentation">
      <div className="promo-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="promo-modal-head">
          <div>
            <h2>{t('promo.importTitle')}</h2>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}>
              {t('promo.importSubtitle')}
            </div>
          </div>
          <button type="button" className="promo-close" onClick={onClose} title={t('common.close')}>
            ✕
          </button>
        </div>

        <div className="promo-modal-body">
          {loi && (
            <div className="alert-box alert-danger" role="alert">
              {loi}
            </div>
          )}

          {buoc === 'chon-file' && (
            <div className="promo-field">
              <label htmlFor="promo-file">{t('promo.fileLabel')}</label>
              <input
                id="promo-file"
                ref={inputRef}
                className="input-custom"
                type="file"
                accept="application/json,.json"
                onChange={(e) => doiFile(e.target.files?.[0])}
              />
              <div className="promo-help">
                {t('promo.fileHelp')}
              </div>
            </div>
          )}

          {buoc === 'ket-qua' && diff && (
            <>
              <div className="promo-stats">
                <div className="promo-stat">
                  <b>{diff.total}</b>
                  <span>{t('promo.statRead')}</span>
                </div>
                <div className="promo-stat new">
                  <b>{diff.created.length}</b>
                  <span>{t('promo.statNew')}</span>
                </div>
                <div className="promo-stat ver">
                  <b>{diff.versioned.length}</b>
                  <span>{t('promo.statVersioned')}</span>
                </div>
                <div className="promo-stat same">
                  <b>{diff.unchangedCount}</b>
                  <span>{t('promo.statSkipped')}</span>
                </div>
              </div>

              <div className="alert-box alert-success" role="status">
                <b>
                  {diff.unchangedCount}/{diff.total}
                </b>{' '}
                {t('promo.skippedNotice')}
              </div>

              <div className="promo-difflist">
                {diff.created.map((m) => (
                  <div className="promo-diffitem" key={`c-${m.title}`}>
                    <span className="promo-pill promo-pill-new">{t('promo.pillNew')}</span>
                    <span className="promo-diffname">{m.title}</span>
                    <span className="promo-tag">{m.provider ?? t('promo.unknownProviderLower')}</span>
                  </div>
                ))}
                {diff.versioned.map((m) => (
                  <div className="promo-diffitem" key={`v-${m.title}`}>
                    <span className="promo-pill promo-pill-ver">{t('promo.pillNewVersion')}</span>
                    <span className="promo-diffname">
                      {m.title} · {m.reason}
                    </span>
                    <span className="promo-tag">ver {m.versionLabel}</span>
                  </div>
                ))}
                {diff.invalid.map((m) => (
                  <div className="promo-diffitem" key={`i-${m.title}`}>
                    <span className="promo-pill promo-pill-same">{t('promo.pillSkipped')}</span>
                    <span className="promo-diffname">
                      {m.title} · {m.reason}
                    </span>
                  </div>
                ))}
                <div className="promo-diffitem">
                  <span className="promo-pill promo-pill-same">{t('promo.pillSame')}</span>
                  <span className="promo-diffname">{t('promo.unchangedCount', { n: diff.unchangedCount })}</span>
                </div>
              </div>
            </>
          )}

          {buoc === 'dang-chay' && (
            <>
              <div
                className={`alert-box ${progress?.status === 'done' ? 'alert-success' : 'alert-warning'}`}
                role="status"
              >
                {progress?.status === 'done'
                  ? t('promo.importDone', { success: progress.success, total: progress.total })
                  : t('promo.importRunning')}
              </div>
              <div className="promo-progress">
                <div
                  style={{
                    width: `${progress && progress.total ? Math.round((progress.processed / progress.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="promo-p">
                {progress
                  ? t('promo.progressCount', { processed: progress.processed, total: progress.total })
                  : t('promo.starting')}
                {progress?.failed ? t('promo.progressFailed', { n: progress.failed }) : ''}
              </p>
              {!!progress?.failedTitles.length && (
                <div className="promo-difflist">
                  {progress.failedTitles.map((tieuDe) => (
                    <div className="promo-diffitem" key={tieuDe}>
                      <span className="promo-pill promo-pill-same">{t('promo.pillFailed')}</span>
                      <span className="promo-diffname">{tieuDe}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="promo-modal-foot">
          {buoc === 'chon-file' && (
            <>
              <button type="button" className="btn-cancel" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn-primary-custom"
                disabled={!payload || kiemTra.isPending}
                onClick={() => kiemTra.mutate()}
              >
                {kiemTra.isPending ? t('promo.checking') : t('promo.checkData')}
              </button>
            </>
          )}
          {buoc === 'ket-qua' && (
            <>
              <button type="button" className="btn-cancel" onClick={() => setBuoc('chon-file')}>
                {t('common.back')}
              </button>
              <button
                type="button"
                className="btn-primary-custom"
                disabled={soThayDoi === 0 || chay.isPending}
                onClick={() => chay.mutate()}
              >
                {soThayDoi === 0 ? t('promo.nothingToUpdate') : t('promo.importAndUpdate', { n: soThayDoi })}
              </button>
            </>
          )}
          {buoc === 'dang-chay' && (
            <button type="button" className="btn-primary-custom" onClick={onClose}>
              {t('common.close')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Trang chính ──────────────────────────────────────────────────────────────

export default function PromotionsPage() {
  const { t } = useTranslation();
  const { isAdmin } = useAuthUser();
  const queryClient = useQueryClient();

  const [thangDaMo, setThangDaMo] = useState<string[]>([]);
  const [thangDangChon, setThangDangChon] = useState<string>('tat-ca');
  const [danhMucDangChon, setDanhMucDangChon] = useState<string>('tat-ca');
  const [tuKhoa, setTuKhoa] = useState('');
  const [namMo, setNamMo] = useState<Record<string, boolean>>({});
  const [chiTiet, setChiTiet] = useState<{ id: string; versionId?: string } | null>(null);
  const [moNhap, setMoNhap] = useState(false);

  const { data: months, isLoading: dangTaiThang } = useQuery({
    queryKey: ['promo-months'],
    queryFn: promotionsApi.months,
  });

  // Mặc định mở 2 tháng gần nhất + nhóm không giới hạn thời gian.
  useEffect(() => {
    if (!months) return;
    const macDinh = months.months.slice(0, 2).map((m) => m.key);
    if (months.khongHan > 0) macDinh.push(KHONG_HAN);
    setThangDaMo((truoc) => Array.from(new Set([...truoc, ...macDinh])));
    setNamMo((truoc) => ({ ...Object.fromEntries(months.months.map((m) => [m.nam, true])), ...truoc }));
  }, [months]);

  const ketQua = useQueries({
    queries: thangDaMo.map((key) => ({
      queryKey: ['promo-month', key],
      queryFn: () => promotionsApi.byMonth(key),
      staleTime: 60_000,
    })),
  });

  const duLieuThang = useMemo(() => {
    const map: Record<string, PromotionListItem[]> = {};
    thangDaMo.forEach((key, i) => {
      map[key] = ketQua[i]?.data ?? [];
    });
    return map;
  }, [thangDaMo, ketQua]);

  const tatCaDaTai = useMemo(() => Object.values(duLieuThang).flat(), [duLieuThang]);

  const danhMucCo = useMemo(() => {
    const ds = Array.from(new Set(tatCaDaTai.map((k) => k.category)));
    return ds.sort((a, b) => a.localeCompare(b, 'vi'));
  }, [tatCaDaTai]);

  const loc = (ds: PromotionListItem[]): PromotionListItem[] => {
    const tk = boDau(tuKhoa.trim());
    return ds.filter((k) => {
      if (danhMucDangChon !== 'tat-ca' && k.category !== danhMucDangChon) return false;
      if (!tk) return true;
      return boDau(`${k.title} ${k.summary ?? ''} ${k.provider ?? ''}`).includes(tk);
    });
  };

  const moThang = (key: string) => {
    setThangDaMo((truoc) => (truoc.includes(key) ? truoc : [...truoc, key]));
    setThangDangChon(key);
  };

  const lamMoiDanhSach = () => {
    queryClient.invalidateQueries({ queryKey: ['promo-month'] });
    queryClient.invalidateQueries({ queryKey: ['promo-months'] });
  };

  // Nhóm sẽ vẽ ở khu nội dung
  const nhomHienThi =
    thangDangChon === 'tat-ca'
      ? [...(months?.months.map((m) => m.key) ?? []), ...(months?.khongHan ? [KHONG_HAN] : [])]
      : [thangDangChon];

  const theoNam = useMemo(() => {
    const map: Record<string, typeof months.months> = {};
    (months?.months ?? []).forEach((m) => {
      (map[m.nam] = map[m.nam] ?? []).push(m);
    });
    return map;
  }, [months]);

  return (
    <div className="promo-page">
      <header className="promo-topbar">
        <div>
          <h1>{t('promo.pageTitle')}</h1>
          <div className="promo-sub">
            {months
              ? t('promo.summary', {
                  promos: months.tong,
                  versions: months.tongVersion,
                  months: months.months.length,
                })
              : t('common.loading')}
          </div>
        </div>

        <div className="promo-search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
            <circle cx="7" cy="7" r="5" />
            <path d="M11 11l4 4" />
          </svg>
          <input
            className="input-custom"
            type="search"
            value={tuKhoa}
            onChange={(e) => setTuKhoa(e.target.value)}
            placeholder={t('promo.searchPlaceholder')}
          />
        </div>

        {isAdmin && (
          <button type="button" className="btn-primary-custom" onClick={() => setMoNhap(true)}>
            ⬆ {t('promo.importNew')}
          </button>
        )}
      </header>

      <div className="promo-layout">
        <aside className="promo-aside">
          <div className="promo-aside-group">
            <h2>{t('promo.byMonth')}</h2>
            <button
              type="button"
              className={`promo-row${thangDangChon === 'tat-ca' ? ' active' : ''}`}
              onClick={() => setThangDangChon('tat-ca')}
            >
              <span className="promo-caret" />
              <span className="promo-label">{t('promo.all')}</span>
              <span className="promo-count">{months?.tong ?? 0}</span>
            </button>

            {Object.keys(theoNam)
              .sort()
              .reverse()
              .map((nam) => (
                <div key={nam}>
                  <button
                    type="button"
                    className="promo-row promo-row-year"
                    onClick={() => setNamMo((v) => ({ ...v, [nam]: !v[nam] }))}
                  >
                    <span className={`promo-caret${namMo[nam] ? ' open' : ''}`}>▶</span>
                    <span className="promo-label">Năm {nam}</span>
                    <span className="promo-count">
                      {theoNam[nam].reduce((s, m) => s + m.soLuong, 0)}
                    </span>
                  </button>

                  {namMo[nam] && (
                    <div className="promo-children">
                      {theoNam[nam].map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          className={`promo-row${thangDangChon === m.key ? ' active' : ''}`}
                          onClick={() => moThang(m.key)}
                        >
                          <span className="promo-caret" />
                          <span className="promo-label">{tenThang(m.key)}</span>
                          {!thangDaMo.includes(m.key) && (
                            <span className="promo-lazy-dot" title={t('promo.notLoadedDot')} />
                          )}
                          <span className="promo-count">{m.soLuong}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}

            {!!months?.khongHan && (
              <button
                type="button"
                className={`promo-row${thangDangChon === KHONG_HAN ? ' active' : ''}`}
                onClick={() => moThang(KHONG_HAN)}
              >
                <span className="promo-caret" />
                <span className="promo-label">Không giới hạn thời gian</span>
                <span className="promo-count">{months.khongHan}</span>
              </button>
            )}
          </div>

          <div className="promo-aside-group">
            <h2>{t('promo.category')}</h2>
            <button
              type="button"
              className={`promo-row${danhMucDangChon === 'tat-ca' ? ' active' : ''}`}
              onClick={() => setDanhMucDangChon('tat-ca')}
            >
              <span className="promo-label">{t('promo.all')}</span>
              <span className="promo-count">{tatCaDaTai.length}</span>
            </button>
            {danhMucCo.map((dm) => (
              <button
                key={dm}
                type="button"
                className={`promo-row${danhMucDangChon === dm ? ' active' : ''}`}
                onClick={() => setDanhMucDangChon(dm)}
              >
                <span className="promo-label">{dm}</span>
                <span className="promo-count">{tatCaDaTai.filter((k) => k.category === dm).length}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="promo-main">
          {dangTaiThang && <div className="spinner-custom mx-auto" />}

          {nhomHienThi.map((key) => {
            const daMo = thangDaMo.includes(key);
            const viTri = thangDaMo.indexOf(key);
            const dangTai = daMo && ketQua[viTri]?.isLoading;
            const ds = daMo ? loc(duLieuThang[key] ?? []) : [];
            const soGoc = months?.months.find((m) => m.key === key)?.soLuong ?? months?.khongHan ?? 0;

            // Đang tìm kiếm thì ẩn hẳn nhóm rỗng cho đỡ rối
            if (daMo && !dangTai && ds.length === 0 && tuKhoa.trim()) return null;

            return (
              <section className="promo-month" key={key}>
                <div className="promo-month-head">
                  <h2>{tenThang(key)}</h2>
                  <span className="promo-count">{daMo ? ds.length : soGoc}</span>
                  {key === KHONG_HAN ? (
                    <span className="promo-soft-badge">{t('promo.alwaysShown')}</span>
                  ) : (
                    months &&
                    months.months.slice(0, 2).some((m) => m.key === key) && (
                      <span className="promo-soft-badge">{t('promo.preloaded')}</span>
                    )
                  )}
                </div>

                {!daMo ? (
                  <div className="promo-lazy">
                    <div className="promo-lazy-text">
                      <b>{t('promo.monthNotLoaded', { month: tenThang(key) })}</b>
                      <span>{t('promo.lazyExplain')}</span>
                    </div>
                    <button type="button" className="btn-primary-custom" onClick={() => moThang(key)}>
                      {t('promo.loadMonth', { month: tenThang(key) })}
                    </button>
                  </div>
                ) : dangTai ? (
                  <div className="promo-grid">
                    <div className="promo-skeleton" />
                    <div className="promo-skeleton" />
                    <div className="promo-skeleton" />
                  </div>
                ) : ds.length === 0 ? (
                  <div className="promo-empty">
                    <strong>{t('promo.emptyTitle')}</strong>
                    <div>{t('promo.emptyDesc')}</div>
                  </div>
                ) : (
                  <div className="promo-grid">
                    {ds.map((km) => (
                      <PromotionCard
                        key={km.id}
                        km={km}
                        isAdmin={isAdmin}
                        onOpen={(versionId) => setChiTiet({ id: km.id, versionId })}
                        onChanged={lamMoiDanhSach}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </main>
      </div>

      {chiTiet && (
        <DetailModal id={chiTiet.id} initialVersionId={chiTiet.versionId} onClose={() => setChiTiet(null)} />
      )}
      {moNhap && <ImportModal onClose={() => setMoNhap(false)} onDone={lamMoiDanhSach} />}
    </div>
  );
}
