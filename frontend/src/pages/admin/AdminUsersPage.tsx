import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { adminApi, useAuthUser, type UserRole } from '../../api';
import { useKbList } from '../../api/kb';
import { useConfirm } from '../../components/ConfirmModal';

interface User {
  id: string;
  email: string;
  role: UserRole;
  enabled: boolean;
  defaultKb: string;
  createdAt: string;
}

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { t, i18n } = useTranslation();
  const { user: currentUser, isSuperAdmin } = useAuthUser();
  const { data: dsKb = [] } = useKbList();
  const [actionError, setActionError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [defaultKb, setDefaultKb] = useState('');
  const [formError, setFormError] = useState('');

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ['admin-users'],
    queryFn: adminApi.listUsers,
  });

  const tenKb = (code: string) => dsKb.find((k) => k.code === code)?.name ?? code;

  const nhanVaiTro: Record<UserRole, string> = {
    super_admin: `🛡 ${t('adminUsers.roleSuperAdmin')}`,
    admin: `👑 ${t('adminUsers.roleAdmin')}`,
    user: `👤 ${t('adminUsers.roleUser')}`,
  };

  /**
   * Quản trị KB chỉ thao tác được trên tài khoản Người dùng của chính KB mình — ẩn nút cho khỏi
   * bấm nhầm. Backend chặn lần nữa, đây chỉ là lớp giao diện.
   */
  const trongPhamVi = (u: User) =>
    isSuperAdmin || (u.role === 'user' && u.defaultKb === currentUser?.defaultKb);

  const createMutation = useMutation({
    mutationFn: () =>
      adminApi.createUser(
        isSuperAdmin
          ? { email, password, role, defaultKb: defaultKb || currentUser?.defaultKb }
          : { email, password, role: 'user' }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setShowForm(false);
      setEmail(''); setPassword(''); setRole('user'); setDefaultKb(''); setFormError('');
    },
    onError: (err: any) =>
      setFormError(err?.response?.data?.error || (err as Error).message),
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) => adminApi.setUserRole(id, role),
    onSuccess: () => {
      setActionError('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) =>
      setActionError(err?.response?.data?.error || t('adminUsers.actionFailed')),
  });

  const kbMutation = useMutation({
    mutationFn: ({ id, kb }: { id: string; kb: string }) => adminApi.setUserDefaultKb(id, kb),
    onSuccess: () => {
      setActionError('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) =>
      setActionError(err?.response?.data?.error || t('adminUsers.actionFailed')),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      enabled ? adminApi.disableUser(id) : adminApi.enableUser(id),
    onSuccess: () => {
      setActionError('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    // Backend chặn khoá Admin cuối cùng (422) — hiển thị nguyên văn lý do cho Admin biết
    onError: (err: any) =>
      setActionError(err?.response?.data?.error || t('adminUsers.actionFailed')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => adminApi.deleteUser(id),
    onSuccess: () => {
      setActionError('');
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: any) =>
      setActionError(err?.response?.data?.error || t('adminUsers.deleteFailed')),
  });

  /** Xoá cứng, không hoàn tác được → bắt buộc xác nhận và nói rõ hậu quả trước khi gọi API. */
  const handleDelete = async (u: User) => {
    // ConfirmModal render text phẳng (không giữ xuống dòng), nên viết thành đoạn văn liền
    // mạch thay vì gạch đầu dòng — gạch đầu dòng sẽ dính vào nhau, rất khó đọc.
    const ok = await confirm(t('adminUsers.confirmDelete', { email: u.email }));
    if (ok) deleteMutation.mutate(u.id);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div>
          <h1 className="page-title">👥 {t('layout.nav.users')}</h1>
          <p className="page-subtitle">{t('adminUsers.accountCount', { n: users.length })}</p>
        </div>
        <button id="btn-new-user" className="btn-primary-custom" onClick={() => setShowForm(!showForm)}>
          {showForm ? `✕ ${t('common.close')}` : `+ ${t('adminUsers.addUser')}`}
        </button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="card-custom card-section">
          <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '1rem' }}>{t('adminUsers.createTitle')}</h3>
          {formError && (
            <div className="alert-box alert-danger" role="alert" style={{ marginBottom: '0.75rem' }}>⚠️ {formError}</div>
          )}
          <div
            style={{
              display: 'grid',
              // Quản trị KB không chọn vai trò lẫn KB (bị ép sẵn), nên bớt 2 cột cho form gọn lại.
              gridTemplateColumns: isSuperAdmin ? '1fr 1fr 1fr 1fr auto' : '1fr 1fr auto',
              gap: '0.75rem',
              alignItems: 'end',
            }}
          >
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>Email</label>
              <input id="input-user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@company.com"
                className="input-custom" />
            </div>
            <div>
              <label style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>{t('login.password')}</label>
              <input id="input-user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••"
                className="input-custom" />
            </div>
            {isSuperAdmin && (
              <>
                <div>
                  <label htmlFor="select-user-role" style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>
                    {t('adminUsers.colRole')}
                  </label>
                  <select id="select-user-role" value={role} onChange={(e) => setRole(e.target.value as UserRole)}
                    className="input-custom" title={t('adminUsers.roleHint')}>
                    <option value="user">{t('adminUsers.roleUser')}</option>
                    <option value="admin">{t('adminUsers.roleAdmin')}</option>
                    <option value="super_admin">{t('adminUsers.roleSuperAdmin')}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="select-user-kb" style={{ fontSize: '0.8125rem', fontWeight: 600, display: 'block', marginBottom: '0.375rem' }}>
                    {t('adminUsers.colKb')}
                  </label>
                  <select id="select-user-kb" value={defaultKb || currentUser?.defaultKb || ''}
                    onChange={(e) => setDefaultKb(e.target.value)}
                    className="input-custom" title={t('adminUsers.kbHint')}>
                    {dsKb.map((kb) => (
                      <option key={kb.code} value={kb.code}>{kb.name}</option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <button id="btn-create-user" className="btn-primary-custom" onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !email || !password}>
              {createMutation.isPending ? '⏳' : t('adminUsers.create')}
            </button>
          </div>
          {!isSuperAdmin && (
            <p style={{ marginTop: '0.75rem', marginBottom: 0, fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted-strong)' }}>
              {t('adminUsers.roleUser')} · {tenKb(currentUser?.defaultKb ?? '')}
            </p>
          )}
        </div>
      )}

      {actionError && (
        <div className="alert-box alert-danger" role="alert" style={{ marginBottom: '1rem' }}>
          ⚠️ {actionError}
        </div>
      )}

      <div className="card-custom" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}><div className="spinner-custom" style={{ margin: '0 auto' }} /></div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="table-custom" style={{ textAlign: 'left' }}>Email</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminUsers.colRole')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminUsers.colKb')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminUsers.colStatus')}</th>
                <th className="table-custom" style={{ textAlign: 'left' }}>{t('adminUsers.colCreatedAt')}</th>
                <th className="table-custom" style={{ textAlign: 'right' }}>{t('audit.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="table-custom" style={{ fontWeight: 500 }}>{u.email}</td>
                  <td className="table-custom">
                    {/* Chỉ Quản trị hệ thống mới đổi được vai trò; người khác thấy nhãn tĩnh.
                        Không cho tự đổi vai trò của chính mình — backend cũng chặn. */}
                    {isSuperAdmin && u.id !== currentUser?.id ? (
                      <select
                        className="kb-inline-select"
                        value={u.role}
                        disabled={roleMutation.isPending}
                        title={t('adminUsers.roleHint')}
                        onChange={(e) => roleMutation.mutate({ id: u.id, role: e.target.value as UserRole })}
                      >
                        <option value="user">{t('adminUsers.roleUser')}</option>
                        <option value="admin">{t('adminUsers.roleAdmin')}</option>
                        <option value="super_admin">{t('adminUsers.roleSuperAdmin')}</option>
                      </select>
                    ) : (
                      <span className={`role-badge ${u.role === 'user' ? 'user' : 'admin'}`}>
                        {nhanVaiTro[u.role]}
                      </span>
                    )}
                  </td>
                  <td className="table-custom">
                    {isSuperAdmin ? (
                      <select
                        className="kb-inline-select"
                        value={u.defaultKb}
                        disabled={kbMutation.isPending}
                        title={`${t('adminUsers.kbHint')} ${t('adminUsers.kbNoteAfterChange')}`}
                        onChange={(e) => kbMutation.mutate({ id: u.id, kb: e.target.value })}
                      >
                        {/* KB của tài khoản có thể đã bị tắt — vẫn phải hiện để không ghi đè nhầm */}
                        {!dsKb.some((k) => k.code === u.defaultKb) && (
                          <option value={u.defaultKb}>{u.defaultKb}</option>
                        )}
                        {dsKb.map((kb) => (
                          <option key={kb.code} value={kb.code}>{kb.name}</option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ fontSize: '0.8125rem' }}>{tenKb(u.defaultKb)}</span>
                    )}
                  </td>
                  <td className="table-custom">
                    <span className={`status-badge ${u.enabled ? 'published' : 'unpublished'}`}>
                      {u.enabled ? t('adminUsers.statusActive') : t('adminUsers.statusLocked')}
                    </span>
                  </td>
                  <td className="table-custom" style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem' }}>
                    {new Date(u.createdAt).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'vi-VN')}
                  </td>
                  <td className="table-custom" style={{ textAlign: 'right' }}>
                    {u.id === currentUser?.id ? (
                      // Không tự khoá/xoá chính mình — backend cũng chặn, ẩn nút cho khỏi bấm nhầm
                      <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                        {t('adminUsers.yourAccount')}
                      </span>
                    ) : !trongPhamVi(u) ? (
                      <span style={{ fontSize: '0.8125rem', color: 'var(--color-text-muted)' }}>
                        {t('adminUsers.outOfScope')}
                      </span>
                    ) : (
                      <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                        <button
                          className="btn-ghost btn-sm"
                          onClick={() => toggleMutation.mutate({ id: u.id, enabled: u.enabled })}
                          disabled={toggleMutation.isPending || deleteMutation.isPending}
                        >
                          {u.enabled ? `🔒 ${t('adminUsers.lock')}` : `✅ ${t('adminUsers.unlock')}`}
                        </button>
                        <button
                          id={`btn-delete-user-${u.id}`}
                          className="btn-danger-custom btn-sm"
                          onClick={() => handleDelete(u)}
                          disabled={deleteMutation.isPending || toggleMutation.isPending}
                          title={t('adminUsers.deleteTitle')}
                        >
                          🗑 {t('common.delete')}
                        </button>
                      </div>
                    )}
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
