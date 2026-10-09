import {isDbConflict} from '../data-platform/db-errors.mjs';
import {expenseSource} from '../expense-sheet/expense-read.mjs';
// PL・BS（管理会計の試算）の API。設計: docs/platform/team-development/pl-bs-design.md。Worker でも動くよう node:* を import しない。
//   GET  /api/reports/pl-bs?from&to[&asOf]           作品別PL・作品別の残高（財務の権限がある作品）と、会社PL・会社BS（会社全体を見られる人だけ）
//   GET  /api/pl-bs/settings                          会社の法人情報（最新の版と履歴）・年度の設定・勘定科目・取引先（自社の候補）
//   POST /api/pl-bs/profile-versions                  会社の法人情報の新しい版（管理者だけ）
//   POST /api/pl-bs/accounts/defaults                 勘定科目の共通の初期値を組織に入れる（管理者だけ。入っている科目は足さない）
//   POST /api/pl-bs/accounts                          手入力の科目を足す（管理者だけ）
//   GET  /api/pl-bs/manual?from&to                    手入力の額（取消を含む履歴）
//   POST /api/pl-bs/manual                            手入力の額を足す（管理者だけ。1回200行まで）
//   POST /api/pl-bs/manual/:id/reverse                手入力の額の取消の行を足す（管理者だけ）
//   GET  /api/expense-payments[?workId]               経費ごとの出金の記録と未払（経費の財務権限がある案件）
//   POST /api/expense-payments                        出金を記録する
//   POST /api/expense-payments/:id/reverse            出金の取消の行を足す
//   GET  /api/committee-investments?workId            委員会の出資額（最新の条件版）と払込の記録（払込は委員会契約×参加者で全部の条件版をまとめる）
//   POST /api/committee-investment-payments           払込を記録する（最新の条件版にだけ。上限は最新の出資額−全部の版の払込）
//   POST /api/committee-investment-payments/:id/reverse 払込の取消の行を足す
// 権限: 制作担当は403。作品の数字は作品の財務権限（settlementWork）、会社PL・BSと手入力の一覧は会社全体の財務権限
// （管理者か、組織のすべての案件に財務の権限がある人）。会社の設定・勘定科目・手入力の登録は管理者だけ。書き込みはすべて監査（audit_log）に残す。
import {buildPlBs, DEFAULT_ACCOUNTS, PL_SECTIONS, BS_SECTIONS, PAYMENT_METHODS, SECTION_LABELS, isMonth, monthsFromTo, PL_BS_HEADING} from '../reports/pl-bs-model.mjs';
import {loadPlBsInput, latestProfile, profileFromRow, loadAccounts, liveManualRows} from './pl-bs-data.mjs';
import {corporateCheckDigitOk} from '../partners/partner-profile.mjs';
import {fiscalSetting} from '../reporting-annual.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MAX_REPORT_MONTHS = 120;
export const MAX_MANUAL_ROWS = 200;
const MANUAL_COLUMNS = 10; // 1行の値の数（org_id・科目・月・種類・金額・税額・作品・根拠・状態・作成者）。1文の値は100個まで

const json = (value) => JSON.stringify(value);
// 文字の項目は前後の空白だけを取る（法人名・住所・根拠の全角の括弧などは書いたとおりに残す）。番号・コードは呼び出し側で NFKC にそろえる
const text = (value, max, {required = false} = {}) => {
  const out = value === null || value === undefined ? '' : String(value).trim();
  if (required && !out) throw new Error('必須の項目が空です');
  if (out.length > max) throw new Error(`${max}文字以内で入れてください`);
  return out || null;
};
const positiveId = (value) => {
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value ?? '').trim()) ? Number(String(value).trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const yenInt = (value, {signed = false} = {}) => {
  const raw = typeof value === 'number' ? value : String(value ?? '').normalize('NFKC').replace(/[,円¥\s]/g, '');
  const n = typeof raw === 'number' ? raw : /^-?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) return null;
  if (!signed && n < 0) return null;
  return n;
};
const validDate = (value) => {
  if (!DATE.test(String(value ?? ''))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

export function registerPlBsRoutes(app, ctx) {
  const {db, bad, body, permittedProjects, settlementWork} = ctx;
  const denied = (i) => !i || i.role === 'production';
  const audit = (i, action, entity, entityId, detail) => ({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
    params: [i.org_id, i.user_id, action, entity, String(entityId), json(detail)]});

  // 財務の権限がある作品と、会社全体を見られるか（管理者か、組織のすべての案件に財務の権限がある人）
  async function financeScope(i) {
    const projects = new Set((await permittedProjects(db, i, true)).map((row) => row.id));
    const allProjects = await db.all('SELECT id FROM projects WHERE org_id=?', [i.org_id]);
    const works = await db.all('SELECT id, project_id FROM works WHERE org_id=?', [i.org_id]);
    const company = i.role === 'admin' || (allProjects.length > 0 && allProjects.every((row) => projects.has(row.id)));
    return {projects, company, workIds: works.filter((row) => projects.has(row.project_id)).map((row) => row.id)};
  }

  // ---------- 帳票 ----------
  app.get('/api/reports/pl-bs', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, 'PL・BSは財務担当の帳票です', 403);
    const from = c.req.query('from'), to = c.req.query('to'), asOf = c.req.query('asOf') || to;
    if (!MONTH.test(from || '') || !MONTH.test(to || '') || !MONTH.test(asOf || '')) return bad(c, '期間（from・to）とBSの基準月（asOf）を「2026-05」の形で指定してください');
    if (from > to) return bad(c, '期間の開始月が終了月より後になっています');
    if (monthsFromTo(from, to).length > MAX_REPORT_MONTHS) return bad(c, `期間は${MAX_REPORT_MONTHS}か月以内にしてください`);
    try {
      const scope = await financeScope(i);
      if (!scope.workIds.length && !scope.company) return bad(c, '財務の権限がある作品がありません', 403);
      const input = await loadPlBsInput(db, i, ctx, {from, to, asOf, workIds: scope.workIds, includeCompany: scope.company});
      const report = buildPlBs(input);
      const latest = await db.get("SELECT MAX(created_at) AS at FROM report_imports WHERE org_id=? AND status='active' AND kind<>'publicity'", [i.org_id]);
      const out = {
        ok: true, heading: PL_BS_HEADING, conditions: report.conditions, scope: {company: scope.company, workCount: scope.workIds.length},
        profile: input.profile ? {legalName: input.profile.legalName, selfPartnerName: input.profile.selfPartnerName, openingMonth: input.profile.openingMonth, versionNo: input.profile.versionNo} : null,
        fiscal: {fiscalStartMonth: input.fiscal.fiscalStartMonth, confirmed: input.fiscal.confirmed},
        // 会社全体の注意（現預金・期首残高など）と会社PL・BSの照合は、会社全体を見られる人だけに返す（範囲を絞った計算の額を会社の数字として見せない）
        headingNotes: report.headingNotes, notes: scope.company ? [...report.notes, ...report.companyNotes] : report.notes, months: report.months,
        workPl: report.workPl, workDetail: report.workDetail, workBalances: report.workBalances, bsUnavailable: report.bsUnavailable,
        expenseClassification: report.expenseClassification,
        companyPl: scope.company ? report.companyPl : null, companyBs: scope.company ? report.companyBs : null,
        checks: scope.company ? report.checks : report.checks.filter((row) => row.scope === 'work'),
        dataAsOf: {latestImportAt: latest?.at || null, generatedAt: new Date().toISOString()},
        calculationVersion: report.calculationVersion,
      };
      if (!scope.company) out.companyNote = '会社PL・会社BSは、組織のすべての案件に財務の権限がある人（管理者など）だけが見られます。';
      return c.json(out);
    } catch (error) {
      return bad(c, error.message, 400, undefined, error);
    }
  });

  // ---------- 会社の設定 ----------
  app.get('/api/pl-bs/settings', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '会社の設定は財務担当の画面です', 403);
    const scope = await financeScope(i);
    if (!scope.company) return bad(c, '会社の設定は、組織のすべての案件に財務の権限がある人だけが見られます', 403);
    const [versions, accounts, fiscal, partners] = await Promise.all([
      db.all(`SELECT v.*, p.code AS self_partner_code, p.name AS self_partner_name, u.display_name AS created_by_name FROM org_profile_versions v
        LEFT JOIN partners p ON p.org_id=v.org_id AND p.id=v.self_partner_id LEFT JOIN users u ON u.id=v.created_by WHERE v.org_id=? ORDER BY v.version_no DESC`, [i.org_id]),
      loadAccounts(db, i.org_id), fiscalSetting(db, i.org_id),
      db.all('SELECT id, code, name FROM partners WHERE org_id=? ORDER BY code, id', [i.org_id]),
    ]);
    const profiles = versions.map(profileFromRow);
    const codes = new Set(accounts.map((row) => row.code));
    const keys = new Set(accounts.map((row) => row.systemKey).filter(Boolean));
    return c.json({ok: true, canEdit: i.role === 'admin', profile: profiles[0] || null, versions: profiles, fiscal, accounts, partners,
      sections: SECTION_LABELS, paymentMethods: PAYMENT_METHODS,
      missingDefaults: DEFAULT_ACCOUNTS.filter((row) => !codes.has(row.code) && !(row.systemKey && keys.has(row.systemKey))).length});
  });

  app.post('/api/pl-bs/profile-versions', async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '会社の設定は管理者だけが変えられます', 403);
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const errors = [], warnings = [];
    const field = (key, label, fn) => { try { return fn(); } catch (error) { errors.push({field: key, message: `${label}: ${error.message}`}); return null; } };
    const legalName = field('legalName', '法人名', () => text(input.legalName, 200, {required: true}));
    const corporateNumber = field('corporateNumber', '法人番号', () => {
      const value = text(input.corporateNumber, 20)?.normalize('NFKC');
      if (!value) return null;
      const digits = value.replace(/[\s-]/g, '');
      if (!/^\d{13}$/.test(digits)) throw new Error('13桁の数字で入れてください');
      if (!corporateCheckDigitOk(digits)) warnings.push('法人番号の検査数字が合いません。国税庁の法人番号公表サイトで確かめてください');
      return digits;
    });
    const invoiceRegistrationNumber = field('invoiceRegistrationNumber', 'インボイス登録番号', () => {
      const value = text(input.invoiceRegistrationNumber, 20)?.normalize('NFKC');
      if (!value) return null;
      const v = value.toUpperCase().replace(/[\s-]/g, '');
      if (!/^T\d{13}$/.test(v)) throw new Error('「T」と13桁の数字で入れてください');
      return v;
    });
    const postalCode = field('postalCode', '郵便番号', () => {
      const value = text(input.postalCode, 10)?.normalize('NFKC');
      if (!value) return null;
      const digits = value.replace(/-/g, '');
      if (!/^\d{7}$/.test(digits)) throw new Error('「123-4567」の形で入れてください');
      return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    });
    const address = field('address', '住所', () => text(input.address, 300));
    const capitalYen = field('capitalYen', '資本金', () => {
      if (input.capitalYen === null || input.capitalYen === undefined || input.capitalYen === '') return null;
      const n = yenInt(input.capitalYen);
      if (n === null) throw new Error('0円以上の整数で入れてください');
      return n;
    });
    const openingMonth = field('openingMonth', '期首残高の基準月', () => {
      const value = text(input.openingMonth, 10)?.normalize('NFKC');
      if (!value) return null;
      if (!isMonth(value)) throw new Error('「2024-04」の形で入れてください');
      return value;
    });
    const reason = field('reason', '変更の理由', () => text(input.reason, 1000, {required: true}));
    let selfPartnerId = null;
    if (input.selfPartnerId !== null && input.selfPartnerId !== undefined && input.selfPartnerId !== '') {
      selfPartnerId = positiveId(input.selfPartnerId);
      if (!selfPartnerId || !await db.get('SELECT 1 FROM partners WHERE org_id=? AND id=?', [i.org_id, selfPartnerId])) errors.push({field: 'selfPartnerId', message: '自社を表す取引先は、この組織の取引先から選んでください'});
    }
    if (errors.length) return bad(c, errors.map((e) => e.message).join(' ／ '), 400, {errors});
    const latest = await db.get('SELECT MAX(version_no) AS v FROM org_profile_versions WHERE org_id=?', [i.org_id]);
    const current = Number(latest?.v || 0);
    const expected = input.baseVersion === undefined || input.baseVersion === null ? current : Number(input.baseVersion);
    if (expected !== current) return bad(c, '他の人が先に新しい版を作りました。再読込して直してください', 409);
    const versionNo = current + 1;
    const values = {legalName, corporateNumber, invoiceRegistrationNumber, postalCode, address, capitalYen, selfPartnerId, openingMonth};
    try {
      await db.batch([
        {sql: `INSERT INTO org_profile_versions(org_id,version_no,legal_name,corporate_number,invoice_registration_number,postal_code,address,capital_yen,self_partner_id,opening_month,reason,created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, params: [i.org_id, versionNo, legalName, corporateNumber, invoiceRegistrationNumber, postalCode, address, capitalYen, selfPartnerId, openingMonth, reason, i.user_id]},
        audit(i, 'version', 'org_profile', i.org_id, {versionNo, values, reason}),
      ]);
    } catch (error) {
      return bad(c, /連続/.test(error.message) || isDbConflict(error) ? '他の人が先に新しい版を作りました。再読込して直してください' : error.message, 409);
    }
    return c.json({ok: true, versionNo, warnings, profile: await latestProfile(db, i.org_id)}, 201);
  });

  // ---------- 勘定科目 ----------
  app.post('/api/pl-bs/accounts/defaults', async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '勘定科目は管理者だけが足せます', 403);
    const existing = await loadAccounts(db, i.org_id);
    const codes = new Set(existing.map((row) => row.code));
    const keys = new Set(existing.map((row) => row.systemKey).filter(Boolean));
    const adding = DEFAULT_ACCOUNTS.filter((row) => !codes.has(row.code) && !(row.systemKey && keys.has(row.systemKey)));
    if (!adding.length) return c.json({ok: true, added: 0, accounts: existing});
    const statements = [];
    const width = 10;
    const perStatement = Math.floor(100 / width);
    for (let start = 0; start < adding.length; start += perStatement) {
      const chunk = adding.slice(start, start + perStatement);
      statements.push({sql: `INSERT INTO gl_accounts(org_id,code,name,section,source,system_key,cash_effect,sort_order,note,created_by) VALUES ${chunk.map(() => `(${Array(width).fill('?').join(',')})`).join(',')}`,
        params: chunk.flatMap((row) => [i.org_id, row.code, row.name, row.section, row.source, row.systemKey, row.cashEffect ? 1 : 0, row.sortOrder, row.note, i.user_id])});
    }
    statements.push(audit(i, 'create', 'gl_accounts', 'defaults', {codes: adding.map((row) => row.code)}));
    try { await db.batch(statements); } catch (error) { return bad(c, `勘定科目を入れられませんでした（${error.message}）。再読込してください`, 409); }
    return c.json({ok: true, added: adding.length, accounts: await loadAccounts(db, i.org_id)}, 201);
  });

  app.post('/api/pl-bs/accounts', async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '勘定科目は管理者だけが足せます', 403);
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const errors = [];
    const code = String(input.code ?? '').normalize('NFKC').trim();
    if (!/^[0-9A-Za-z_-]{1,20}$/.test(code)) errors.push({field: 'code', message: '科目コードは英数字・「-」「_」の20文字以内で入れてください'});
    let name = null;
    try { name = text(input.name, 60, {required: true}); } catch { errors.push({field: 'name', message: '科目名を60文字以内で入れてください'}); }
    const section = String(input.section || '');
    if (![...PL_SECTIONS, ...BS_SECTIONS].includes(section)) errors.push({field: 'section', message: '区分を選んでください'});
    let note = null;
    try { note = text(input.note, 500); } catch { errors.push({field: 'note', message: '備考は500文字以内です'}); }
    if (errors.length) return bad(c, errors.map((e) => e.message).join(' ／ '), 400, {errors});
    if (await db.get('SELECT 1 FROM gl_accounts WHERE org_id=? AND code=?', [i.org_id, code])) return bad(c, `科目コード ${code} は使われています`, 409);
    const cashEffect = input.cashEffect === false || input.cashEffect === 0 || input.cashEffect === '0' ? 0 : 1;
    const sortOrder = Number.isSafeInteger(Number(input.sortOrder)) && Number(input.sortOrder) >= 0 && Number(input.sortOrder) <= 100000 ? Number(input.sortOrder) : 5000;
    try {
      await db.batch([
        {sql: 'INSERT INTO gl_accounts(org_id,code,name,section,source,system_key,cash_effect,sort_order,note,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)', params: [i.org_id, code, name, section, 'manual', null, cashEffect, sortOrder, note, i.user_id]},
        audit(i, 'create', 'gl_account', code, {code, name, section, cashEffect, sortOrder, note}),
      ]);
    } catch (error) {
      return bad(c, error.message, 409, undefined, error);
    }
    return c.json({ok: true, accounts: await loadAccounts(db, i.org_id)}, 201);
  });

  // ---------- 手入力の額 ----------
  app.get('/api/pl-bs/manual', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '手入力の額は財務担当の画面です', 403);
    const scope = await financeScope(i);
    if (!scope.company) return bad(c, '手入力の額は、組織のすべての案件に財務の権限がある人だけが見られます', 403);
    const from = c.req.query('from') || '0000-01', to = c.req.query('to') || '9999-12';
    if ((from !== '0000-01' && !MONTH.test(from)) || (to !== '9999-12' && !MONTH.test(to))) return bad(c, '期間を「2026-05」の形で指定してください');
    const [rows, accounts, profile] = await Promise.all([
      db.all(`SELECT m.*, a.code AS account_code, a.name AS account_name, a.section, w.code AS work_code, w.title AS work_title, u.display_name AS created_by_name
        FROM gl_manual_amounts m JOIN gl_accounts a ON a.org_id=m.org_id AND a.id=m.account_id LEFT JOIN works w ON w.org_id=m.org_id AND w.id=m.work_id
        LEFT JOIN users u ON u.id=m.created_by WHERE m.org_id=? AND m.month BETWEEN ? AND ? ORDER BY m.month, a.sort_order, m.id`, [i.org_id, from, to]),
      loadAccounts(db, i.org_id), latestProfile(db, i.org_id),
    ]);
    const live = new Set(liveManualRows(rows).map((row) => row.id));
    const reversedBy = new Map(rows.filter((row) => row.reverses_id != null).map((row) => [row.reverses_id, row.id]));
    return c.json({ok: true, canEdit: i.role === 'admin', accounts, openingMonth: profile?.openingMonth ?? null, rows: rows.map((row) => ({
      id: row.id, accountId: row.account_id, accountCode: row.account_code, accountName: row.account_name, section: row.section, month: row.month, kind: row.kind,
      amountYen: row.amount_yen, taxYen: row.tax_yen ?? 0, workId: row.work_id, workCode: row.work_code, workTitle: row.work_title, basis: row.basis, status: row.status,
      reversesId: row.reverses_id, reversedById: reversedBy.get(row.id) ?? null, live: live.has(row.id), createdAt: row.created_at, createdByName: row.created_by_name,
    }))});
  });

  app.post('/api/pl-bs/manual', async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '手入力の額は管理者だけが入れられます', 403);
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const list = Array.isArray(input.entries) ? input.entries : [];
    if (!list.length) return bad(c, '入れる額を1行以上送ってください');
    if (list.length > MAX_MANUAL_ROWS) return bad(c, `1回に入れられるのは${MAX_MANUAL_ROWS}行までです。分けて入れてください`, 413);
    const [accounts, profile, works] = await Promise.all([loadAccounts(db, i.org_id), latestProfile(db, i.org_id), db.all('SELECT id FROM works WHERE org_id=?', [i.org_id])]);
    const byId = new Map(accounts.map((row) => [row.id, row]));
    const byCode = new Map(accounts.map((row) => [row.code, row]));
    const workIds = new Set(works.map((row) => row.id));
    const errors = [];
    const rows = [];
    list.forEach((raw, index) => {
      const at = `${index + 1}行目`;
      const account = raw?.accountId != null ? byId.get(Number(raw.accountId)) : byCode.get(String(raw?.accountCode ?? ''));
      if (!account) { errors.push({row: index + 1, field: 'account', message: `${at}: 勘定科目がこの組織にありません`}); return; }
      const month = String(raw.month ?? '');
      if (!isMonth(month)) errors.push({row: index + 1, field: 'month', message: `${at}: 月を「2026-05」の形で入れてください`});
      const amount = yenInt(raw.amountYen, {signed: true});
      if (amount === null) errors.push({row: index + 1, field: 'amountYen', message: `${at}: 金額を整数の円で入れてください`});
      const kind = BS_SECTIONS.includes(account.section) ? 'balance' : 'flow';
      // 消費税額（発生額の税。課税の費用は仮払・課税の収益は仮受）。空欄は0。残高と、現預金を動かさない科目には入れられない
      const tax = raw.taxYen === undefined || raw.taxYen === null || raw.taxYen === '' ? 0 : yenInt(raw.taxYen, {signed: true});
      if (tax === null) errors.push({row: index + 1, field: 'taxYen', message: `${at}: 消費税額を整数の円で入れてください（無ければ空欄）`});
      else if (tax !== 0 && kind !== 'flow') errors.push({row: index + 1, field: 'taxYen', message: `${at}: 消費税額は発生額（PLの科目）にだけ入れられます`});
      else if (tax !== 0 && !account.cashEffect) errors.push({row: index + 1, field: 'taxYen', message: `${at}: 「${account.name}」は現預金を動かさない科目のため、消費税額を入れられません`});
      if (kind === 'flow' && account.source === 'system') errors.push({row: index + 1, field: 'account', message: `${at}: 「${account.name}」はシステムが計算する科目です。元の記録（売上・経費・ロイヤリティ・委員会）を直してください`});
      if (kind === 'balance' && account.source === 'system' && month !== profile?.openingMonth) {
        errors.push({row: index + 1, field: 'month', message: `${at}: 「${account.name}」はシステムが計算する科目のため、期首残高の基準月（${profile?.openingMonth || '未設定'}）の残高だけを入れられます`});
      }
      let workId = null;
      if (raw.workId !== null && raw.workId !== undefined && raw.workId !== '') {
        workId = positiveId(raw.workId);
        if (!workId || !workIds.has(workId)) errors.push({row: index + 1, field: 'workId', message: `${at}: 作品がこの組織にありません`});
      }
      let basis = null;
      try { basis = text(raw.basis, 500, {required: true}); } catch { errors.push({row: index + 1, field: 'basis', message: `${at}: 根拠（資料名・計算の仕方）を500文字以内で入れてください`}); }
      const status = raw.status === 'reviewed' ? 'reviewed' : raw.status === 'unverified' || raw.status === undefined || raw.status === null || raw.status === '' ? 'unverified' : null;
      if (!status) errors.push({row: index + 1, field: 'status', message: `${at}: 状態は「未確認」か「確認済み」です`});
      rows.push({accountId: account.id, accountCode: account.code, month, kind, amount, tax: tax ?? 0, workId, basis, status});
    });
    if (errors.length) return bad(c, errors.slice(0, 20).map((e) => e.message).join(' ／ '), 400, {errors});
    const statements = [];
    const perStatement = Math.floor(100 / MANUAL_COLUMNS);
    for (let start = 0; start < rows.length; start += perStatement) {
      const chunk = rows.slice(start, start + perStatement);
      statements.push({sql: `INSERT INTO gl_manual_amounts(org_id,account_id,month,kind,amount_yen,tax_yen,work_id,basis,status,created_by) VALUES ${chunk.map(() => `(${Array(MANUAL_COLUMNS).fill('?').join(',')})`).join(',')}`,
        params: chunk.flatMap((row) => [i.org_id, row.accountId, row.month, row.kind, row.amount, row.tax, row.workId, row.basis, row.status, i.user_id])});
    }
    statements.push(audit(i, 'create', 'gl_manual_amounts', `${rows.length}rows`, {count: rows.length, entries: rows.map(({accountCode, month, kind, amount, tax, workId, status}) => ({accountCode, month, kind, amount, tax, workId, status}))}));
    try { await db.batch(statements); } catch (error) { return bad(c, error.message, 409, undefined, error); }
    return c.json({ok: true, added: rows.length}, 201);
  });

  app.post('/api/pl-bs/manual/:id/reverse', async (c) => {
    const i = c.get('identity');
    if (i.role !== 'admin') return bad(c, '手入力の額は管理者だけが取り消せます', 403);
    const id = positiveId(c.req.param('id'));
    if (!id) return bad(c, '取り消す行を読み取れません');
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    let reason;
    try { reason = text(input.reason, 500, {required: true}); } catch { return bad(c, '取り消す理由を500文字以内で入れてください'); }
    const row = await db.get('SELECT * FROM gl_manual_amounts WHERE org_id=? AND id=?', [i.org_id, id]);
    if (!row) return bad(c, '手入力の額が見つかりません', 404);
    if (row.reverses_id != null) return bad(c, '取消の行は取り消せません。正しい額を入れ直してください', 409);
    if (await db.get('SELECT 1 FROM gl_manual_amounts WHERE org_id=? AND reverses_id=?', [i.org_id, id])) return bad(c, 'この行は取消済みです', 409);
    try {
      await db.batch([
        {sql: 'INSERT INTO gl_manual_amounts(org_id,account_id,month,kind,amount_yen,tax_yen,work_id,basis,status,reverses_id,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          params: [i.org_id, row.account_id, row.month, row.kind, -row.amount_yen, -(row.tax_yen ?? 0), row.work_id, `取消: ${reason}`.slice(0, 500), 'reviewed', id, i.user_id]},
        audit(i, 'reverse', 'gl_manual_amount', id, {reason, month: row.month, amount: row.amount_yen, tax: row.tax_yen ?? 0}),
      ]);
    } catch (error) {
      return bad(c, isDbConflict(error) ? 'この行は取消済みです' : error.message, 409);
    }
    return c.json({ok: true}, 201);
  });

  // ---------- 経費の出金 ----------
  async function expenseState(i, expenseIds) {
    if (!expenseIds.length) return new Map();
    const payments = await db.all('SELECT p.*, a.withheld_yen, a.cash_account_class_version_id, u.display_name AS created_by_name FROM expense_payments p LEFT JOIN expense_payment_accounting a ON a.org_id=p.org_id AND a.payment_id=p.id LEFT JOIN users u ON u.id=p.created_by WHERE p.org_id=? ORDER BY p.paid_on, p.id', [i.org_id]);
    const wanted = new Set(expenseIds);
    const byExpense = new Map();
    for (const row of payments.filter((item) => wanted.has(item.expense_id))) {
      if (!byExpense.has(row.expense_id)) byExpense.set(row.expense_id, []);
      byExpense.get(row.expense_id).push(row);
    }
    return byExpense;
  }
  const paymentView = (row, reversed) => ({id: row.id, paidOn: row.paid_on, amountYen: row.amount_yen, withheldYen: row.withheld_yen??null, cashAccountClassVersionId:row.cash_account_class_version_id??null, method: row.method, methodLabel: PAYMENT_METHODS[row.method] || row.method,
    note: row.note, reversesId: row.reverses_id, reversed: reversed.has(row.id), createdAt: row.created_at, createdByName: row.created_by_name ?? null});

  app.get('/api/expense-payments', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '経費の出金は財務担当の画面です', 403);
    const projects = new Set((await permittedProjects(db, i, true)).map((row) => row.id));
    const rawWork = c.req.query('workId');
    const workId = rawWork ? positiveId(rawWork) : null;
    if (rawWork && !workId) return bad(c, '作品の指定を読み取れません');
    let expenses = (await db.all(`SELECT e.id, e.project_id, e.work_id, e.accounting_month, e.incurred_on, e.category, e.description, e.actual_ex_tax, e.tax_amount, e.actual_inc_tax,
        w.code AS work_code, w.title AS work_title, p.name AS partner_name FROM ${expenseSource()} e LEFT JOIN works w ON w.org_id=e.org_id AND w.id=e.work_id
        LEFT JOIN partners p ON p.org_id=e.org_id AND p.id=e.partner_id WHERE e.org_id=? ORDER BY e.accounting_month, e.id`, [i.org_id])).filter((row) => projects.has(row.project_id));
    if (workId) {
      const work = await db.get('SELECT id, project_id FROM works WHERE org_id=? AND id=?', [i.org_id, workId]);
      if (!work || !projects.has(work.project_id)) return bad(c, '作品の財務権限がありません', 403);
      expenses = expenses.filter((row) => row.work_id === workId || (row.work_id == null && row.project_id === work.project_id));
    }
    const byExpense = await expenseState(i, expenses.map((row) => row.id));
    const rows = expenses.map((row) => {
      const list = byExpense.get(row.id) || [];
      const reversed = new Set(list.filter((item) => item.reverses_id != null).map((item) => item.reverses_id));
      const paid = list.reduce((n, item) => n + item.amount_yen, 0), withheld=list.reduce((n,item)=>n+(item.withheld_yen??0),0), settled=paid+withheld;
      const livePayments = list.filter((item) => item.reverses_id == null && !reversed.has(item.id));
      return {id: row.id, workId: row.work_id, workCode: row.work_code, workTitle: row.work_title, accountingMonth: row.accounting_month, incurredOn: row.incurred_on,
        category: row.category, description: row.description, partnerName: row.partner_name, exTax: row.actual_ex_tax, tax: row.tax_amount, incTax: row.actual_inc_tax,
        paidYen: paid, withheldYen:list.some(item=>item.withheld_yen==null)?null:withheld, withholdingState:list.some(item=>item.withheld_yen==null)?'unverified':'confirmed', unpaidYen: row.actual_inc_tax - settled, lastPaidOn: livePayments.map((item) => item.paid_on).sort().at(-1) || null,
        state: settled <= 0 ? '未払' : settled < row.actual_inc_tax ? '一部未払' : settled === row.actual_inc_tax ? '支払済み' : '払い過ぎ',
        payments: list.map((item) => paymentView(item, reversed))};
    });
    const unpaid = rows.filter((row) => row.unpaidYen > 0);
    return c.json({ok: true, rows, methods: PAYMENT_METHODS, summary: {count: rows.length, unpaidCount: unpaid.length, unpaidYen: unpaid.reduce((n, row) => n + row.unpaidYen, 0)}});
  });

  app.post('/api/expense-payments', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '制作担当は経費の出金を記録できません', 403);
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const expenseId = positiveId(input.expenseId);
    if (!expenseId) return bad(c, '経費を選んでください');
    const expense = await db.get('SELECT id, project_id, work_id, actual_inc_tax FROM expenses WHERE org_id=? AND id=?', [i.org_id, expenseId]);
    if (!expense) return bad(c, '経費が見つかりません', 404);
    if (!(await permittedProjects(db, i, true)).some((row) => row.id === expense.project_id)) return bad(c, '案件の財務編集権限がありません', 403);
    const errors = [];
    if (!validDate(input.paidOn)) errors.push({field: 'paidOn', message: '出金日を「2026-05-31」の形で入れてください'});
    const amount = yenInt(input.amountYen);
    if (!amount) errors.push({field: 'amountYen', message: '出金額を1円以上の整数で入れてください'});
    const method = String(input.method || 'transfer');
    if (!PAYMENT_METHODS[method]) errors.push({field: 'method', message: '方法（振込・現金・カード・相殺・その他）を選んでください'});
    let note = null;
    try { note = text(input.note, 500); } catch { errors.push({field: 'note', message: '備考は500文字以内です'}); }
    if (errors.length) return bad(c, errors.map((e) => e.message).join(' ／ '), 400, {errors});
    const paid = Number((await db.get('SELECT COALESCE(SUM(amount_yen),0) AS n FROM expense_payments WHERE org_id=? AND expense_id=?', [i.org_id, expenseId])).n);
    if (paid + amount > expense.actual_inc_tax) {
      return bad(c, `出金の合計が経費の税込額（${expense.actual_inc_tax.toLocaleString('ja-JP')}円）を超えます。記録済みの出金は${paid.toLocaleString('ja-JP')}円です`, 409);
    }
    try {
      await db.batch([
        {sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE (SELECT COALESCE(SUM(amount_yen),0) FROM expense_payments WHERE org_id=? AND expense_id=?)<>?', params: [i.org_id, expenseId, paid]},
        {sql: 'INSERT INTO transaction_guards(value) SELECT 0 WHERE EXISTS(SELECT 1 FROM expense_details WHERE org_id=? AND expense_id=?)',params:[i.org_id,expenseId]},
        {sql: 'INSERT INTO expense_payments(org_id,expense_id,paid_on,amount_yen,method,note,created_by) VALUES(?,?,?,?,?,?,?)', params: [i.org_id, expenseId, input.paidOn, amount, method, note, i.user_id]},
        audit(i, 'create', 'expense_payment', expenseId, {expenseId, paidOn: input.paidOn, amount, method, note}),
      ]);
    } catch (error) {
      return bad(c, '他の人が先に出金を記録しました。再読込して確かめてください', 409, {cause: error.message});
    }
    return c.json({ok: true}, 201);
  });

  app.post('/api/expense-payments/:id/reverse', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '制作担当は経費の出金を取り消せません', 403);
    const id = positiveId(c.req.param('id'));
    if (!id) return bad(c, '取り消す出金を読み取れません');
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const row = await db.get('SELECT p.*, e.project_id FROM expense_payments p JOIN expenses e ON e.org_id=p.org_id AND e.id=p.expense_id WHERE p.org_id=? AND p.id=?', [i.org_id, id]);
    if (!row) return bad(c, '出金の記録が見つかりません', 404);
    if (!(await permittedProjects(db, i, true)).some((item) => item.id === row.project_id)) return bad(c, '案件の財務編集権限がありません', 403);
    if (row.reverses_id != null) return bad(c, '取消の記録は取り消せません', 409);
    const reversedOn = String(input.reversedOn || '');
    if (!validDate(reversedOn) || reversedOn < row.paid_on) return bad(c, '取消日は出金日以後の日付で入れてください');
    let reason;
    try { reason = text(input.reason, 500, {required: true}); } catch { return bad(c, '取り消す理由を500文字以内で入れてください'); }
    try {
      await db.batch([
        {sql: 'INSERT INTO expense_payments(org_id,expense_id,paid_on,amount_yen,method,note,reverses_id,created_by) VALUES(?,?,?,?,?,?,?,?)', params: [i.org_id, row.expense_id, reversedOn, -row.amount_yen, row.method, reason, id, i.user_id]},
        audit(i, 'reverse', 'expense_payment', id, {expenseId: row.expense_id, reversedOn, reason, amount: row.amount_yen}),
      ]);
    } catch (error) {
      return bad(c, isDbConflict(error) ? 'この出金は取消済みです' : error.message, 409);
    }
    return c.json({ok: true}, 201);
  });

  // ---------- 委員会への出資の払込 ----------
  // 払込は「委員会契約×参加者」で全部の条件版をまとめて数え、最新の条件版の出資額（約定額）と比べる。新しい払込は最新の条件版にだけ記録する
  // （条件版を足すと出資額の行が版ごとに写されるため。PL・BS も約定額は最新の版、払込は全部の版の合計で数える）
  app.get('/api/committee-investments', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '委員会への出資は財務担当の画面です', 403);
    const workId = positiveId(c.req.query('workId'));
    if (!workId) return bad(c, '作品を選んでください');
    if (!await settlementWork(i, workId)) return bad(c, '作品の財務権限がありません', 403);
    const investments = await db.all(`SELECT inv.term_version_id, inv.partner_id, inv.amount_yen, v.version_no, v.contract_id, c.contract_code, c.title AS contract_title, p.code AS partner_code, p.name AS partner_name,
        (SELECT MAX(x.version_no) FROM committee_term_versions x WHERE x.org_id=v.org_id AND x.contract_id=v.contract_id) AS latest_version_no
      FROM committee_term_investments inv JOIN committee_term_versions v ON v.org_id=inv.org_id AND v.id=inv.term_version_id
      JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id JOIN partners p ON p.org_id=inv.org_id AND p.id=inv.partner_id
      WHERE inv.org_id=? AND c.work_id=? ORDER BY c.id, v.version_no, inv.partner_id`, [i.org_id, workId]);
    const payments = await db.all(`SELECT p.*, v.contract_id, v.version_no AS paid_version_no, u.display_name AS created_by_name FROM committee_investment_payments p JOIN committee_term_versions v ON v.org_id=p.org_id AND v.id=p.term_version_id
      JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id LEFT JOIN users u ON u.id=p.created_by WHERE p.org_id=? AND c.work_id=? ORDER BY p.paid_on, p.id`, [i.org_id, workId]);
    const profile = await latestProfile(db, i.org_id);
    const reversed = new Set(payments.filter((row) => row.reverses_id != null).map((row) => row.reverses_id));
    const rows = investments.map((row) => {
      const latest = row.version_no === row.latest_version_no;
      const base = {termVersionId: row.term_version_id, versionNo: row.version_no, latest, contractId: row.contract_id, contractCode: row.contract_code,
        contractTitle: row.contract_title, partnerId: row.partner_id, partnerCode: row.partner_code, partnerName: row.partner_name, isSelf: row.partner_id === profile?.selfPartnerId,
        amountYen: row.amount_yen};
      // 古い条件版の行は履歴（払込の累計・未払込は最新の条件版の行に全部の版をまとめて出す）
      if (!latest) return {...base, paidYen: null, unpaidYen: null, payments: []};
      const own = payments.filter((item) => item.contract_id === row.contract_id && item.partner_id === row.partner_id);
      const paid = own.reduce((n, item) => n + item.amount_yen, 0);
      return {...base, paidYen: paid, unpaidYen: row.amount_yen - paid,
        payments: own.map((item) => ({...paymentView(item, reversed), versionNo: item.paid_version_no}))};
    });
    return c.json({ok: true, rows, methods: PAYMENT_METHODS, selfPartnerId: profile?.selfPartnerId ?? null});
  });

  app.post('/api/committee-investment-payments', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '制作担当は出資の払込を記録できません', 403);
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const termVersionId = positiveId(input.termVersionId), partnerId = positiveId(input.partnerId);
    if (!termVersionId || !partnerId) return bad(c, '委員会の条件版と参加者を選んでください');
    const investment = await db.get(`SELECT inv.amount_yen, c.work_id, v.contract_id, v.version_no,
        (SELECT MAX(x.version_no) FROM committee_term_versions x WHERE x.org_id=v.org_id AND x.contract_id=v.contract_id) AS latest_version_no
      FROM committee_term_investments inv JOIN committee_term_versions v ON v.org_id=inv.org_id AND v.id=inv.term_version_id
      JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id WHERE inv.org_id=? AND inv.term_version_id=? AND inv.partner_id=?`, [i.org_id, termVersionId, partnerId]);
    if (!investment) return bad(c, 'この条件版の参加者の出資額が登録されていません', 404);
    if (!await settlementWork(i, investment.work_id)) return bad(c, '作品の財務権限がありません', 403);
    if (investment.version_no !== investment.latest_version_no) return bad(c, `最新の条件版（版${investment.latest_version_no}）に記録してください。払込は全部の条件版をまとめて数えます`, 409);
    const errors = [];
    if (!validDate(input.paidOn)) errors.push({field: 'paidOn', message: '払込日を「2026-05-31」の形で入れてください'});
    const amount = yenInt(input.amountYen);
    if (!amount) errors.push({field: 'amountYen', message: '払込額を1円以上の整数で入れてください'});
    const method = String(input.method || 'transfer');
    if (!PAYMENT_METHODS[method]) errors.push({field: 'method', message: '方法を選んでください'});
    let note = null;
    try { note = text(input.note, 500); } catch { errors.push({field: 'note', message: '備考は500文字以内です'}); }
    if (errors.length) return bad(c, errors.map((e) => e.message).join(' ／ '), 400, {errors});
    // 委員会契約×参加者の払込の合計（全部の条件版）
    const paidSql = `SELECT COALESCE(SUM(p.amount_yen),0) AS n FROM committee_investment_payments p JOIN committee_term_versions v ON v.org_id=p.org_id AND v.id=p.term_version_id
      WHERE p.org_id=? AND v.contract_id=? AND p.partner_id=?`;
    const paid = Number((await db.get(paidSql, [i.org_id, investment.contract_id, partnerId])).n);
    if (paid + amount > investment.amount_yen) return bad(c, `払込の合計が出資額（最新の条件版で${investment.amount_yen.toLocaleString('ja-JP')}円）を超えます。記録済みの払込は全部の条件版で${paid.toLocaleString('ja-JP')}円です`, 409);
    try {
      await db.batch([
        // 読んだ後に他の人が払込を記録した・条件版を足したときは止める
        {sql: `INSERT INTO transaction_guards(value) SELECT 0 WHERE (${paidSql})<>? OR (SELECT MAX(version_no) FROM committee_term_versions WHERE org_id=? AND contract_id=?)<>?`,
          params: [i.org_id, investment.contract_id, partnerId, paid, i.org_id, investment.contract_id, investment.latest_version_no]},
        {sql: 'INSERT INTO committee_investment_payments(org_id,term_version_id,partner_id,paid_on,amount_yen,method,note,created_by) VALUES(?,?,?,?,?,?,?,?)', params: [i.org_id, termVersionId, partnerId, input.paidOn, amount, method, note, i.user_id]},
        audit(i, 'create', 'committee_investment_payment', `${termVersionId}:${partnerId}`, {termVersionId, partnerId, workId: investment.work_id, paidOn: input.paidOn, amount, method, note}),
      ]);
    } catch (error) {
      return bad(c, '他の人が先に払込を記録したか、条件版を足しました。再読込して確かめてください', 409, {cause: error.message});
    }
    return c.json({ok: true}, 201);
  });

  app.post('/api/committee-investment-payments/:id/reverse', async (c) => {
    const i = c.get('identity');
    if (denied(i)) return bad(c, '制作担当は出資の払込を取り消せません', 403);
    const id = positiveId(c.req.param('id'));
    if (!id) return bad(c, '取り消す払込を読み取れません');
    let input;
    try { input = await body(c); } catch (error) { return bad(c, error.message, 400, undefined, error); }
    const row = await db.get(`SELECT p.*, c.work_id FROM committee_investment_payments p JOIN committee_term_versions v ON v.org_id=p.org_id AND v.id=p.term_version_id
      JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id WHERE p.org_id=? AND p.id=?`, [i.org_id, id]);
    if (!row) return bad(c, '払込の記録が見つかりません', 404);
    if (!await settlementWork(i, row.work_id)) return bad(c, '作品の財務権限がありません', 403);
    if (row.reverses_id != null) return bad(c, '取消の記録は取り消せません', 409);
    const reversedOn = String(input.reversedOn || '');
    if (!validDate(reversedOn) || reversedOn < row.paid_on) return bad(c, '取消日は払込日以後の日付で入れてください');
    let reason;
    try { reason = text(input.reason, 500, {required: true}); } catch { return bad(c, '取り消す理由を500文字以内で入れてください'); }
    try {
      await db.batch([
        {sql: 'INSERT INTO committee_investment_payments(org_id,term_version_id,partner_id,paid_on,amount_yen,method,note,reverses_id,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
          params: [i.org_id, row.term_version_id, row.partner_id, reversedOn, -row.amount_yen, row.method, reason, id, i.user_id]},
        audit(i, 'reverse', 'committee_investment_payment', id, {reversedOn, reason, amount: row.amount_yen}),
      ]);
    } catch (error) {
      return bad(c, isDbConflict(error) ? 'この払込は取消済みです' : error.message, 409);
    }
    return c.json({ok: true}, 201);
  });
}
