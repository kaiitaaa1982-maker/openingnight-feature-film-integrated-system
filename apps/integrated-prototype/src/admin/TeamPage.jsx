// チーム（管理者）。メンバーを案件ごとの役割で招待し、参加の確定・取り消しを行う。
// 試作では末尾が .invalid の架空のメールだけを使い、外部へは送らない。期限は日本時間で入力・表示する。
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {EntityPicker} from '../ui/EntityPicker.jsx';
import {DataGrid} from '../ui/DataGrid.jsx';
import {toEntityItems} from '../ui/entity-match.mjs';
import {labelOf} from '../ui/labels.mjs';
import {dateTimeJst} from '../ui/format.mjs';
import {
  INVITE_ROLE_OPTIONS, defaultExpiryInput, validateInvitation, invitationRows, memberRows, revokeSummary, projectTitle,
} from './admin-model.mjs';
import './admin.css';

const ROLE_SHORT = Object.freeze(Object.fromEntries(INVITE_ROLE_OPTIONS.map((option) => [option.value, option.label])));
const noExpiry = (value) => (value ? dateTimeJst(value) : '期限なし');

function StatusBadge({state}) {
  return <span className={`adm-status adm-tone-${state.tone}`}>{state.label}</span>;
}

const MEMBER_COLUMNS = [
  {key: 'email', label: 'メール', type: 'text', sticky: true},
  {key: 'display_name', label: '表示名', type: 'text'},
  {key: 'role', label: '組織での役割', type: 'text', value: (row) => labelOf('role', row.role)},
  {key: 'active_label', label: '所属', type: 'text'},
  {key: 'expires_at', label: '所属の期限', type: 'text', value: (row) => noExpiry(row.expires_at)},
  {key: 'project_title', label: '案件', type: 'text'},
  {key: 'permission', label: '案件での権限', type: 'text', value: (row) => (row.permission ? labelOf('projectPermission', row.permission) : '—')},
  {key: 'project_expires_at', label: '案件の権限の期限', type: 'text', value: (row) => (row.project_id == null ? '—' : noExpiry(row.project_expires_at))},
];

export function TeamPage({data, request: requestProp}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const readOnly = Boolean(shell.readOnly);
  const projects = useMemo(() => (Array.isArray(data?.projects) ? data.projects : []), [data?.projects]);
  const projectItems = useMemo(() => toEntityItems(projects.map((project) => ({
    id: project.id, code: project.code, label: project.title, hint: project.status ? labelOf('projectStatus', project.status) : '',
  }))), [projects]);
  const [team, setTeam] = useState({loading: true, members: [], invitations: []});
  const [form, setForm] = useState(() => ({email: '', projectId: projects.length === 1 ? projects[0].id : null, role: 'editor', expiresAt: defaultExpiryInput()}));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const registerUnsaved = shell.registerUnsaved;

  const load = useCallback(async () => {
    setTeam((previous) => ({...previous, loading: true, error: null}));
    try {
      const body = await request('/team');
      setTeam({loading: false, members: body?.members || [], invitations: body?.invitations || []});
    } catch (error) {
      setTeam((previous) => ({...previous, loading: false, error}));
    }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const typing = form.email.trim() ? 1 : 0;
  useEffect(() => {
    registerUnsaved?.('team-invitation', typing, '招待の入力');
    return () => registerUnsaved?.('team-invitation', 0);
  }, [registerUnsaved, typing]);

  const now = new Date();
  const invitations = invitationRows(team.invitations, projects, now);
  const members = memberRows(team.members, projects);
  const forbidden = team.error && (team.error.kind === 'forbidden' || team.error.status === 403);

  const update = (key, value) => {
    setForm((previous) => ({...previous, [key]: value}));
    if (errors[key]) setErrors((previous) => ({...previous, [key]: undefined}));
  };

  async function invite(event) {
    event.preventDefault();
    const checked = validateInvitation(form, {projects});
    setErrors(checked.errors);
    if (!checked.ok) return;
    setBusy('invite');
    setResult(null);
    try {
      await request('/team/invitations', {method: 'POST', body: JSON.stringify(checked.payload)});
      const project = projectTitle(projects, checked.payload.projectId) || '選んだ案件';
      setResult({tone: 'ok', message: `${checked.payload.email} を「${project}」の${ROLE_SHORT[checked.payload.role]}として招待する準備をしました。試作のため外部へは送っていません。参加の確定は下の「招待」で行います。`});
      setForm((previous) => ({...previous, email: ''}));
      await load();
    } catch (error) {
      setResult({tone: 'error', error});
    } finally {
      setBusy('');
    }
  }

  async function act(row, action) {
    setBusy(`${action}-${row.id}`);
    setResult(null);
    try {
      await request(`/team/invitations/${encodeURIComponent(row.id)}/${action}`, {method: 'POST', body: '{}'});
      setResult({tone: 'ok', message: action === 'accept'
        ? `${row.email} の参加を確定しました（試作）。「${row.project_title}」を${ROLE_SHORT[row.role] || labelOf('role', row.role)}として扱えます。`
        : row.status === 'accepted'
          ? `${row.email} から「${row.project_title}」の権限を外しました。`
          : `${row.email} への招待を取り消しました。`});
      setConfirmRevoke(null);
      await load();
    } catch (error) {
      setResult({tone: 'error', error});
      setConfirmRevoke(null);
      await load();
    } finally {
      setBusy('');
    }
  }

  const invitationColumns = [
    {key: 'email', label: 'メール', type: 'text', sticky: true},
    {key: 'project_title', label: '案件', type: 'text'},
    {key: 'role', label: '役割', type: 'text', value: (row) => ROLE_SHORT[row.role] || labelOf('role', row.role)},
    {key: 'state_label', label: '状態', type: 'text', render: (row) => <StatusBadge state={row.state} />},
    {key: 'expires_at', label: '期限（日本時間）', type: 'text', value: (row) => dateTimeJst(row.expires_at)},
    {key: 'actions', label: '操作', type: 'text', searchable: false, sortable: false, value: () => '', render: (row) => (
      <span className="adm-row-actions">
        {row.state.canAccept && <button type="button" className="secondary" disabled={readOnly || Boolean(busy)} onClick={() => act(row, 'accept')}>{busy === `accept-${row.id}` ? '処理中…' : '参加を確定（試作）'}</button>}
        {row.state.canRevoke && <button type="button" className="text" disabled={readOnly || Boolean(busy)} onClick={() => setConfirmRevoke(row.id)}>{row.state.revokeLabel}</button>}
        {!row.state.canAccept && !row.state.canRevoke && <span className="adm-muted">—</span>}
      </span>
    )},
  ];
  const revoking = invitations.find((row) => row.id === confirmRevoke) || null;

  if (forbidden) {
    return (
      <div className="stack adm-page">
        <Notice tone="info" title="チームの管理は管理者が行います" message="メンバーの招待と権限の変更は管理者だけが扱えます。案件の担当を変えたいときは管理者に依頼してください。" />
      </div>
    );
  }

  return (
    <div className="stack adm-page">
      <section className="card">
        <h2>メンバーを招待する</h2>
        <p className="adm-muted">案件ごとに役割を決めて招待します。試作のため、末尾が .invalid の架空のメールだけを使い、外部へは送りません。</p>
        {readOnly && <Notice tone="info" message="設計キャンバスのプレビューです。招待・参加の確定・取り消しはできません（表示だけ）。" compact />}
        <form className="on-form-grid" onSubmit={invite} noValidate>
          <FormField type="email" label="メール" name="email" value={form.email} onChange={(value) => update('email', value)} required error={errors.email}
            placeholder="例: reviewer@pilot.invalid" hint="架空のメール（末尾 .invalid）だけ使えます。" disabled={readOnly} />
          <EntityPicker label="案件" items={projectItems} value={form.projectId} onChange={(id) => update('projectId', id)} required error={errors.projectId}
            emptyText={projects.length ? "未選択（候補から案件を選んでください）" : "選べる案件がありません"} hint="案件名かコードで探して選びます。" disabled={readOnly} />
          <FormField type="select" label="役割" name="role" value={form.role} onChange={(value) => update('role', value)} options={INVITE_ROLE_OPTIONS}
            required includeBlank={false} error={errors.role} disabled={readOnly}
            hint={INVITE_ROLE_OPTIONS.find((option) => option.value === form.role)?.description} />
          <FormField type="datetime" label="期限（日本時間）" name="expiresAt" value={form.expiresAt} onChange={(value) => update('expiresAt', value)} required
            error={errors.expiresAt} hint="この日時を過ぎると招待は使えなくなります。既定は7日後の23:59です。" disabled={readOnly} />
          <div className="on-form-actions on-field-wide">
            <button type="submit" disabled={readOnly || Boolean(busy)}>{busy === 'invite' ? '準備中…' : '招待を準備する'}</button>
          </div>
        </form>
        {projects.length === 0 && <Notice tone="warn" message="招待できる案件がありません。先に「案件・作品」で案件を登録してください。"
          actions={<button type="button" className="secondary" onClick={() => shell.navigate('企画・作品')}>案件・作品を開く</button>} />}
        {result && <Notice tone={result.tone} message={result.message} error={result.error} onDismiss={() => setResult(null)} />}
      </section>

      <section className="card">
        <header className="adm-section-head">
          <div>
            <h2>招待</h2>
            <p className="adm-muted">期限を過ぎた招待は「期限切れ」になり、参加を確定できません。必要なら新しく招待します。</p>
          </div>
          <button type="button" className="text" onClick={load} disabled={team.loading}>{team.loading ? '読み込み中…' : '再読込'}</button>
        </header>
        {team.error && <Notice error={team.error} onRetry={load} />}
        {revoking && (
          <div className="adm-confirm" role="group" aria-label="取り消しの確認">
            <p>{revokeSummary(revoking, projects)}</p>
            <div className="on-form-actions">
              <button type="button" onClick={() => act(revoking, 'revoke')} disabled={readOnly || busy === `revoke-${revoking.id}`}>
                {busy === `revoke-${revoking.id}` ? '処理中…' : revoking.status === 'accepted' ? 'この内容で権限を外す' : 'この内容で招待を取り消す'}
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmRevoke(null)}>戻る</button>
            </div>
          </div>
        )}
        <DataGrid columns={invitationColumns} rows={invitations} rowKey="id" persistKey="admin-team-invitations" maxHeight="50vh" showTotals={false}
          emptyText="まだ招待はありません" ariaLabel="招待の一覧" />
      </section>

      <section className="card">
        <h2>メンバー</h2>
        <p className="adm-muted">組織に所属している人と、案件ごとの権限です。1人が複数の案件に入っているときは案件ごとに1行になります。</p>
        <DataGrid columns={MEMBER_COLUMNS} rows={members} rowKey="key" persistKey="admin-team-members" maxHeight="50vh" showTotals={false}
          emptyText="メンバーはまだいません" ariaLabel="メンバーの一覧" />
      </section>
    </div>
  );
}

export default TeamPage;
