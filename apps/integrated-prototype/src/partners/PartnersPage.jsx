// 取引先。一覧（基本と請求・連絡先の最新の版）を上、行を押すと詳細と版の履歴、「新しい版を作る」で修正する。
// 新規登録は1件入力とExcel一括登録。コード・名称・区分の修正は「マスタの表編集」（承認）で行う。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {RecordForm} from '../ui/RecordForm.jsx';
import {Notice} from '../ui/Notice.jsx';
import {labelOf} from '../ui/labels.mjs';
import {dateTimeJst} from '../ui/format.mjs';
import '../reports/reports.css';
import {StationTypeEditor} from '../broadcast/BroadcastTerms.jsx';

const ROLE_OPTIONS = [['customer', '得意先'], ['supplier', '仕入先'], ['rights_holder', '権利元'], ['broadcaster', '放送局'], ['agency', '代理店']];
const roleText = (roles = []) => roles.map((role) => ROLE_OPTIONS.find(([key]) => key === role)?.[1] || role).join('・');

const COLUMNS = [
  {key: 'code', label: '取引先コード', type: 'code', sticky: true},
  {key: 'name', label: '名称', type: 'text'},
  {key: 'kind', label: '種類', type: 'text', value: (r) => labelOf('partnerKind', r.kind)},
  {key: 'roles', label: '取引の区分', type: 'text', value: (r) => roleText(r.profile?.roles) || '未設定'},
  {key: 'invoice', label: 'インボイス登録番号', type: 'code', value: (r) => r.profile?.invoice_registration_number || '未登録'},
  {key: 'contact', label: '担当者', type: 'text', value: (r) => r.profile?.contact_name || '未登録'},
  {key: 'email', label: '連絡先メール', type: 'text', value: (r) => r.profile?.contact_email || '未登録'},
  {key: 'region', label: '地域', type: 'text'},
  {key: 'version', label: '情報の版', type: 'text', value: (r) => (r.profile?.version_no ? `第${r.profile.version_no}版` : '未登録')},
];

const FIELDS = [
  {name: 'roles_text', label: '取引の区分（得意先・仕入先・権利元・放送局・代理店。複数は「・」で区切る）', type: 'text', wide: true, hint: '例: 得意先・放送局'},
  {name: 'invoice_registration_number', label: 'インボイス登録番号', type: 'text', placeholder: 'T1234567890123'},
  {name: 'contact_name', label: '担当者', type: 'text'},
  {name: 'contact_email', label: '連絡先メール', type: 'text'},
  {name: 'phone', label: '電話番号', type: 'text'},
  {name: 'postal_code', label: '郵便番号', type: 'text', placeholder: '123-4567'},
  {name: 'address', label: '住所', type: 'text', wide: true},
  {name: 'billing_note', label: '請求の備考', type: 'textarea', wide: true},
  {name: 'effective_from', label: '適用開始日', type: 'date'},
];

function toRoles(text) {
  return String(text || '').split(/[・,、\s]+/).map((part) => part.trim()).filter(Boolean)
    .map((part) => ROLE_OPTIONS.find(([key, label]) => key === part || label === part)?.[0] || part);
}

function ProfileDetail({partner, onSaved}) {
  const shell = useShell();
  const [state, setState] = useState({loading: true});
  const [warnings, setWarnings] = useState([]);
  const load = () => shell.request(`/partners/${partner.id}/profile`).then((body) => setState({body})).catch((error) => setState({error}));
  useEffect(() => { load(); }, [partner.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (state.loading) return <p className="rp-muted">読み込み中…</p>;
  if (state.error) return <Notice error={state.error} />;
  const {current, versions} = state.body;
  const initial = current ? {...current, roles_text: roleText(current.roles)} : {};
  return (
    <div className="rp-drill">
      <dl className="sl-detail">
        {[['取引の区分', roleText(current?.roles) || '未設定'], ['インボイス登録番号', current?.invoice_registration_number || '未設定'], ['担当者', current?.contact_name || '—'],
          ['連絡先メール', current?.contact_email || '—'], ['電話番号', current?.phone || '—'], ['住所', [current?.postal_code, current?.address].filter(Boolean).join(' ') || '—'],
          ['請求の備考', current?.billing_note || '—'], ['適用開始日', current?.effective_from || '—']].map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {warnings.map((w) => <Notice key={w} tone="warn" message={w} compact />)}
      {current?.roles?.includes('broadcaster') && <StationTypeEditor request={shell.request} partnerId={partner.id} readOnly={shell.readOnly} />}
      <div className="rw-editor-buttons">
        <button type="button" className="secondary" onClick={() => shell.navigate('取引先別リスト', {plpartner: String(partner.id)})}>この取引先の配信・販売リストを開く（営業基幹）</button>
      </div>
      {!shell.readOnly && (
        <RecordForm mode="create" openLabel={current ? '新しい版を作る' : '請求・連絡先を登録する'} submitLabel="この内容で新しい版を保存" allowContinue={false}
          title={`${partner.name}の請求・連絡先（版${(current?.version_no || 0) + 1}）`} fields={FIELDS} initialValues={initial} resetKey={current?.version_no || 0}
          successMessage="新しい版を保存しました（前の版は履歴に残ります）"
          onSubmit={async (values) => {
            const result = await shell.request(`/partners/${partner.id}/profile-versions`, {method: 'POST', body: JSON.stringify({...values, roles: toRoles(values.roles_text), baseVersion: current?.version_no || 0})});
            setWarnings(result.warnings || []);
            return result;
          }}
          onSaved={() => { load(); onSaved?.(); }} />
      )}
      {versions.length > 1 && (
        <details>
          <summary>版の履歴（{versions.length}版）</summary>
          <ul className="rp-muted">{versions.map((v) => <li key={v.version_no}>版{v.version_no}・{dateTimeJst(v.created_at)}・{v.created_by_name || ''}：{roleText(v.roles) || '区分なし'}／{v.invoice_registration_number || '番号なし'}／{v.contact_name || '担当なし'}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function PartnersPage({data, creationSlot, bulkSlot}) {
  const shell = useShell();
  const [profiles, setProfiles] = useState({});
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    shell.request('/partner-profiles').then((body) => setProfiles(Object.fromEntries(body.profiles.map((p) => [p.partner_id, p])))).catch(() => {});
  }, [shell, revision]);
  const rows = useMemo(() => (data.partners || []).map((p) => ({...p, profile: profiles[p.id]})), [data.partners, profiles]);
  return (
    <div className="stack">
      {bulkSlot}
      <section className="card rp-report" aria-label="取引先の一覧">
        <header className="rp-head">
          <div>
            <h2>取引先の一覧（{rows.length}件）</h2>
            <p className="rp-muted">行を押すと請求・連絡先の情報と版の履歴が開きます。コード・名称・種類の修正は「マスタの表編集」で承認して反映します。</p>
          </div>
          <button type="button" className="secondary" onClick={() => shell.navigate('業務データ編集')}>コード・名称を表で直す</button>
        </header>
        <DataGrid columns={COLUMNS} rows={rows} rowKey="id" persistKey="partners" exportSpec={{name: '取引先', title: '取引先の一覧'}}
          renderDetail={(row) => <ProfileDetail partner={row} onSaved={() => setRevision((n) => n + 1)} />} />
      </section>
      {creationSlot}
    </div>
  );
}

export default PartnersPage;
