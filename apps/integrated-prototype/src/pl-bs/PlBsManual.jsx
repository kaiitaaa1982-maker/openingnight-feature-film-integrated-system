// PL・BS の「手入力」（勘定科目×月の表と、額の追加・取消）と「会社の設定」（法人情報の版・年度・勘定科目）。
// 入れられるのは管理者だけ（サーバーでも止める）。額は追加だけで、直すときは取消の行を足して入れ直す。
import React, {useEffect, useMemo, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {DataGrid} from '../ui/DataGrid.jsx';
import {Notice} from '../ui/Notice.jsx';
import {FormField} from '../ui/FormField.jsx';
import {parseYen} from '../ui/parse-input.mjs';
import {yen, dateTimeJst} from '../ui/format.mjs';
import {fiscalRuleText, monthsBetween} from '../ui/condition-model.mjs';
import {SECTION_LABELS, PL_SECTIONS, BS_SECTIONS, monthLabel} from '../reports/pl-bs-model.mjs';
import {manualMatrix, manualMatrixColumns, MANUAL_HISTORY_COLUMNS} from './pl-bs-view.mjs';

const blankEntry = (month) => ({accountId: '', month: month || '', amount: '', tax: '', workId: '', basis: '', status: 'unverified'});

export function ManualAmounts({from, to, works = [], canEdit, onChanged}) {
  const shell = useShell();
  const [state, setState] = useState({});
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState(() => blankEntry(to));
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reverse, setReverse] = useState(null);
  useEffect(() => {
    let live = true;
    if (!from || !to) return undefined;
    shell.request(`/pl-bs/manual?from=${from}&to=${to}`).then((body) => live && setState({body})).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [shell, from, to, revision]);
  const months = useMemo(() => (from && to ? monthsBetween(from, to) : []), [from, to]);
  const body = state.body;
  const matrix = useMemo(() => manualMatrix(body?.rows || [], months), [body, months]);
  const accountOptions = (body?.accounts || []).filter((account) => account.source === 'manual' || BS_SECTIONS.includes(account.section))
    .map((account) => ({value: String(account.id), label: `${account.code} ${account.name}（${SECTION_LABELS[account.section]}${account.source === 'system' ? '・期首残高だけ' : ''}）`}));
  const account = (body?.accounts || []).find((row) => String(row.id) === String(form.accountId));
  const isBalance = account ? BS_SECTIONS.includes(account.section) : false;
  // 消費税額の欄は、現預金を動かす PL の科目（発生額）だけ
  const takesTax = Boolean(account && !isBalance && account.cashEffect);

  async function save(event) {
    event.preventDefault();
    setNotice(null);
    const amount = parseYen(form.amount, {allowNegative: true});
    if (!amount.ok || amount.value === null) { setNotice({tone: 'error', message: '金額を円で入れてください（マイナスも入れられます）'}); return; }
    const tax = takesTax && String(form.tax || '').trim() ? parseYen(form.tax, {allowNegative: true}) : {ok: true, value: 0};
    if (!tax.ok || tax.value === null) { setNotice({tone: 'error', message: '消費税額を円で入れてください（非課税・不課税は空欄）'}); return; }
    setBusy(true);
    try {
      await shell.request('/pl-bs/manual', {method: 'POST', body: JSON.stringify({entries: [{accountId: Number(form.accountId), month: form.month, amountYen: amount.value, taxYen: tax.value,
        workId: form.workId ? Number(form.workId) : null, basis: form.basis, status: form.status}]})});
      setNotice({tone: 'ok', message: `${account?.name || '科目'}（${monthLabel(form.month)}・${isBalance ? '月末の残高' : '発生額'}）に ${yen(amount.value)} を入れました`});
      setForm(blankEntry(form.month));
      setRevision((n) => n + 1);
      onChanged?.();
    } catch (error) {
      setNotice({tone: 'error', error});
    } finally {
      setBusy(false);
    }
  }
  async function doReverse(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await shell.request(`/pl-bs/manual/${reverse.id}/reverse`, {method: 'POST', body: JSON.stringify({reason: reverse.reason})});
      setNotice({tone: 'ok', message: `${monthLabel(reverse.month)}の ${reverse.accountName} ${yen(reverse.amountYen)} を取り消しました。正しい額があれば入れ直してください`});
      setReverse(null);
      setRevision((n) => n + 1);
      onChanged?.();
    } catch (error) {
      setNotice({tone: 'error', error});
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card rp-report" aria-label="手入力">
      <header className="rp-head">
        <div>
          <h2>手入力の額（勘定科目×月）</h2>
          <p className="rp-muted">システムに無い科目（全社費用・営業外・特別・法人税等・借入金・資本金など）と、期首残高の基準月{body?.openingMonth ? `（${monthLabel(body.openingMonth)}）` : ''}の残高を入れます。PLの科目は税抜の発生額、BSの科目は月末の残高です。課税の費用・収益は消費税額も入れると、現預金は税込で動き、税額は未払消費税等（仮払・仮受）に入ります。取り消した行は表に入りません。</p>
        </div>
      </header>
      {state.error && <Notice error={state.error} />}
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {body && <DataGrid columns={manualMatrixColumns(months)} rows={matrix} rowKey="key" showTotals={false} persistKey="plbs-manual-matrix" ariaLabel="手入力の額（勘定科目×月）" emptyText="この期間の手入力の額はまだありません"
        exportSpec={{name: '手入力の額', title: `手入力の額（${monthLabel(from)}〜${monthLabel(to)}）`}} />}
      {canEdit && body && (
        <form className="plbs-form" onSubmit={save}>
          <h3>額を入れる</h3>
          <FormField type="select" label="勘定科目" required value={form.accountId} options={accountOptions} onChange={(value) => setForm({...form, accountId: value})}
            hint={account?.note || (account ? `${isBalance ? '月末の残高' : '発生額（PL）'}を入れます` : '')} />
          <FormField type="month" label="月" required value={form.month} onChange={(value) => setForm({...form, month: value})} />
          <FormField type="yen" label={isBalance ? '月末の残高（円）' : '発生額（税抜・円）'} required allowNegative value={form.amount} onChange={(value) => setForm({...form, amount: value})} hint={isBalance ? '' : '税抜'} />
          {takesTax && <FormField type="yen" label="消費税額（円）" allowNegative value={form.tax} onChange={(value) => setForm({...form, tax: value})} hint="課税の費用・収益だけ（非課税・不課税は空欄）" />}
          <FormField type="select" label="作品（任意）" value={form.workId} blankLabel="作品を付けない（会社全体）" options={works.map((work) => ({value: String(work.id), label: `${work.code}｜${work.title}`}))}
            onChange={(value) => setForm({...form, workId: value})} hint="作品に付けた費用・収益は、その作品のPLに入ります" />
          <FormField type="text" label="根拠" required wide value={form.basis} maxLength={500} onChange={(value) => setForm({...form, basis: value})} hint="資料名・計算の仕方（例: 給与台帳 2026年5月分）" />
          <FormField type="select" label="状態" value={form.status} includeBlank={false} options={[{value: 'unverified', label: '未確認'}, {value: 'reviewed', label: '確認済み'}]} onChange={(value) => setForm({...form, status: value})} />
          <button type="submit" disabled={busy || !form.accountId || !form.month || !form.basis}>{busy ? '保存中…' : '入れる'}</button>
        </form>
      )}
      {!canEdit && <p className="rp-muted">手入力の額を入れる・取り消すのは管理者だけです。</p>}
      {body && (
        <details className="plbs-history">
          <summary>入れた額の履歴（取消を含む {body.rows.length}行）</summary>
          <DataGrid columns={MANUAL_HISTORY_COLUMNS} rows={body.rows} rowKey="id" showTotals={false} persistKey="plbs-manual-history" ariaLabel="入れた額の履歴"
            onRowClick={canEdit ? (row) => setReverse(row.live ? {...row, reason: ''} : null) : undefined} exportSpec={{name: '手入力の履歴'}} />
          {canEdit && <p className="rp-muted">取り消す行を押すと、取消の理由を入れる欄が出ます。</p>}
        </details>
      )}
      {reverse && (
        <form className="plbs-form" onSubmit={doReverse}>
          <h3>{monthLabel(reverse.month)}の {reverse.accountName} {yen(reverse.amountYen)} を取り消す</h3>
          <FormField type="text" label="取り消す理由" required wide value={reverse.reason} maxLength={500} onChange={(value) => setReverse({...reverse, reason: value})} />
          <button type="submit" disabled={busy || !reverse.reason.trim()}>取消の行を足す</button>
          <button type="button" className="secondary" onClick={() => setReverse(null)}>やめる</button>
        </form>
      )}
    </section>
  );
}

const profileForm = (profile) => ({
  legalName: profile?.legalName || '', corporateNumber: profile?.corporateNumber || '', invoiceRegistrationNumber: profile?.invoiceRegistrationNumber || '',
  postalCode: profile?.postalCode || '', address: profile?.address || '', capitalYen: profile?.capitalYen == null ? '' : String(profile.capitalYen),
  selfPartnerId: profile?.selfPartnerId ? String(profile.selfPartnerId) : '', openingMonth: profile?.openingMonth || '', reason: '',
});

export function CompanySettings({canEdit, onChanged, onNavigate}) {
  const shell = useShell();
  const [state, setState] = useState({});
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState(null);
  const [account, setAccount] = useState({code: '', name: '', section: 'sga', cashEffect: true});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    shell.request('/pl-bs/settings').then((body) => { if (live) { setState({body}); setForm(profileForm(body.profile)); } }).catch((error) => live && setState({error}));
    return () => { live = false; };
  }, [shell, revision]);
  const body = state.body;
  const run = async (fn, message) => {
    setBusy(true);
    setNotice(null);
    try {
      const out = await fn();
      setNotice({tone: out?.warnings?.length ? 'warn' : 'ok', message: [message, ...(out?.warnings || [])].join(' ／ ')});
      setRevision((n) => n + 1);
      onChanged?.();
    } catch (error) {
      setNotice({tone: 'error', error});
    } finally {
      setBusy(false);
    }
  };
  function saveProfile(event) {
    event.preventDefault();
    const capital = form.capitalYen.trim() ? parseYen(form.capitalYen) : {ok: true, value: null};
    if (!capital.ok) { setNotice({tone: 'error', message: '資本金を円で入れてください'}); return; }
    run(() => shell.request('/pl-bs/profile-versions', {method: 'POST', body: JSON.stringify({...form, capitalYen: capital.value, selfPartnerId: form.selfPartnerId ? Number(form.selfPartnerId) : null,
      baseVersion: body.profile?.versionNo ?? 0})}), '会社の設定の新しい版を保存しました');
  }
  const accountColumns = [
    {key: 'code', label: '科目コード', type: 'code', sticky: true},
    {key: 'name', label: '科目', type: 'text', sticky: true},
    {key: 'section', label: '区分', type: 'text', value: (row) => SECTION_LABELS[row.section] || row.section},
    {key: 'source', label: '由来', type: 'text', value: (row) => (row.source === 'system' ? 'システムで計算' : '手入力')},
    {key: 'cashEffect', label: '現預金', type: 'text', value: (row) => (row.source === 'system' ? '—' : row.cashEffect ? '動かす' : '動かさない')},
    {key: 'note', label: '備考', type: 'text', wrap: true},
  ];
  if (state.error) return <Notice error={state.error} />;
  if (!body || !form) return <p className="rp-muted">読み込んでいます…</p>;
  const partnerOptions = body.partners.map((partner) => ({value: String(partner.id), label: `${partner.code}｜${partner.name}`}));
  return (
    <section className="card rp-report" aria-label="会社の設定">
      <header className="rp-head">
        <div>
          <h2>会社の設定</h2>
          <p className="rp-muted">このシステムを運用している会社の法人情報です。変えるたびに新しい版を足し、前の版は残ります。</p>
        </div>
      </header>
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      <dl className="plbs-kv">
        <div><dt>決算期（年度）</dt><dd>{fiscalRuleText(body.fiscal.fiscalStartMonth, {confirmed: body.fiscal.confirmed})}{!body.fiscal.confirmed && <strong className="rp-warn">（未確定）</strong>}
          <button type="button" className="text" onClick={() => onNavigate?.('帳票センター')}>帳票センターで年度の設定を変える</button></dd></div>
        <div><dt>いまの版</dt><dd>{body.profile ? `版${body.profile.versionNo}（${dateTimeJst(body.profile.createdAt)}・${body.profile.createdByName || ''}）` : '未登録'}</dd></div>
        <div><dt>自社を表す取引先</dt><dd>{body.profile?.selfPartnerName ? `${body.profile.selfPartnerCode}｜${body.profile.selfPartnerName}` : '未設定（委員会作品の自社の取り分を計算できません）'}</dd></div>
        <div><dt>期首残高の基準月</dt><dd>{body.profile?.openingMonth ? `${monthLabel(body.profile.openingMonth)}末` : '未設定'}</dd></div>
      </dl>
      <form className="plbs-form" onSubmit={saveProfile}>
        <h3>法人情報</h3>
        <FormField type="text" label="法人名" required value={form.legalName} disabled={!canEdit} onChange={(value) => setForm({...form, legalName: value})} />
        <FormField type="text" label="法人番号（13桁）" value={form.corporateNumber} disabled={!canEdit} onChange={(value) => setForm({...form, corporateNumber: value})} />
        <FormField type="text" label="インボイス登録番号" value={form.invoiceRegistrationNumber} disabled={!canEdit} placeholder="T1234567890123" onChange={(value) => setForm({...form, invoiceRegistrationNumber: value})} />
        <FormField type="text" label="郵便番号" value={form.postalCode} disabled={!canEdit} onChange={(value) => setForm({...form, postalCode: value})} />
        <FormField type="text" label="住所" wide value={form.address} disabled={!canEdit} onChange={(value) => setForm({...form, address: value})} />
        <FormField type="yen" label="資本金（円）" value={form.capitalYen} disabled={!canEdit} onChange={(value) => setForm({...form, capitalYen: value})} hint="会社BSの資本金は手入力の残高で入れます（ここは法人の情報）" />
        <FormField type="select" label="自社を表す取引先" value={form.selfPartnerId} disabled={!canEdit} options={partnerOptions} blankLabel="選ばない" onChange={(value) => setForm({...form, selfPartnerId: value})}
          hint="製作委員会の参加者のうち自社にあたる取引先。委員会作品の自社の取り分に使います" />
        <FormField type="month" label="期首残高の基準月" value={form.openingMonth} disabled={!canEdit} onChange={(value) => setForm({...form, openingMonth: value})} hint="この月の月末残高を手入力で入れ、その後の動きを足してBSを出します" />
        {canEdit && <FormField type="text" label="変更の理由" required wide value={form.reason} onChange={(value) => setForm({...form, reason: value})} />}
        {canEdit && <button type="submit" disabled={busy || !form.legalName.trim() || !form.reason.trim()}>新しい版を保存</button>}
      </form>
      <h3>勘定科目</h3>
      {canEdit && body.missingDefaults > 0 && (
        <p><button type="button" disabled={busy} onClick={() => run(() => shell.request('/pl-bs/accounts/defaults', {method: 'POST', body: '{}'}), '勘定科目の初期値を入れました')}>
          勘定科目の初期値を入れる（{body.missingDefaults}科目）</button></p>
      )}
      <DataGrid columns={accountColumns} rows={body.accounts} rowKey="id" showTotals={false} persistKey="plbs-accounts" emptyText="勘定科目がまだありません。初期値を入れてください" exportSpec={{name: '勘定科目'}} />
      {canEdit && (
        <form className="plbs-form" onSubmit={(event) => { event.preventDefault(); run(() => shell.request('/pl-bs/accounts', {method: 'POST', body: JSON.stringify(account)}), `科目 ${account.code} を足しました`); }}>
          <h3>手入力の科目を足す</h3>
          <FormField type="text" label="科目コード" required value={account.code} onChange={(value) => setAccount({...account, code: value})} />
          <FormField type="text" label="科目名" required value={account.name} onChange={(value) => setAccount({...account, name: value})} />
          <FormField type="select" label="区分" includeBlank={false} value={account.section} options={[...PL_SECTIONS, ...BS_SECTIONS].map((key) => ({value: key, label: SECTION_LABELS[key]}))} onChange={(value) => setAccount({...account, section: value})} />
          <FormField type="select" label="現預金" includeBlank={false} value={account.cashEffect ? '1' : '0'} options={[{value: '1', label: '動かす（その月に払う・受け取る）'}, {value: '0', label: '動かさない（減価償却費など）'}]}
            onChange={(value) => setAccount({...account, cashEffect: value === '1'})} />
          <button type="submit" disabled={busy || !account.code.trim() || !account.name.trim()}>科目を足す</button>
        </form>
      )}
    </section>
  );
}
