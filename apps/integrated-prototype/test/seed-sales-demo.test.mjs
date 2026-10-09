// 架空データ（scripts/seed-sales-demo.mjs）の試験。
// ・1回だけ投入され、2回目は何も足さないこと。組織1（既存の架空データ）からは見えないこと。
// ・帳票の数字（ロイヤリティ集計シート・報告書・委員会月次収支）を、ロイヤリティ・委員会のモデルの関数を使わずに、
//   元の行（売上明細と配賦・流通の区分・料率・窓口手数料・経費・持分）から計算し直して照合する。
//   計算の決まりは設計書 §3-2・§3-3・§4 と §8 の決めごとをそのまま書き下したもの。
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {foreignKeyViolations, openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {seedSalesDemo, SALES_DEMO} from '../scripts/seed-sales-demo.mjs';

// ---------- 独立に書いた計算 ----------
const pad = (n) => String(n).padStart(2, '0');
const addMonth = (ym, n) => {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
};
const monthsFromTo = (from, to) => {
  const out = [];
  for (let m = from; m <= to; m = addMonth(m, 1)) out.push(m);
  return out;
};
const endOfMonth = (ym) => `${ym}-${pad(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate())}`;
// 料率の額: 0に向かって1円未満を切り捨てる
const rateOf = (value, bps) => Number(BigInt(value) * BigInt(bps) / 10000n);
// 最大剰余法: 端数は余りの大きい順、同じなら parts の並び順
function largestRemainder(amount, parts) {
  const sign = amount < 0 ? -1 : 1;
  const whole = BigInt(Math.abs(amount));
  const rows = parts.map((part, index) => ({key: part.key, index, base: whole * BigInt(part.bps) / 10000n, rest: whole * BigInt(part.bps) % 10000n}));
  let left = whole - rows.reduce((n, row) => n + row.base, 0n);
  const order = [...rows].sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1));
  for (let j = 0; left > 0n; j += 1, left -= 1n) order[j % order.length].base += 1n;
  return new Map(rows.map((row) => [row.key, sign * Number(row.base)]));
}
// 流通の区分（設計書 §1 の表）。この架空データが使う流通コードだけを書く。
// 2026-09-26 から架空データは流通マスタの流通ID（流通名で区分が決まる）で分類する。旧区分は 2026-09-25 に入れた DB の分類
const CODE_GROUP = {theatrical: 'theatrical', package_rental: 'rental', package_sell: 'sell', svod: 'digital', tvod: 'digital', avod: 'digital',
  broadcast_free: 'broadcast', broadcast_bs: 'broadcast', other: 'other',
  H001: 'theatrical', R004: 'rental', S001: 'sell', S002: 'sell', D004: 'digital', D005: 'digital', D006: 'digital', B001: 'broadcast', A001: 'overseas', A003: 'overseas'};
const KIND_GROUP = {theatrical: 'theatrical', package: 'package', digital: 'digital', broadcast: 'broadcast', other: 'other'};
const WINDOW_OF_GROUP = {theatrical: 'theatrical', rental: 'package', sell: 'package', package: 'package', digital: 'digital', broadcast: 'broadcast', overseas: 'other', other: 'other'};
// 対象流通に入るか: true 入る／false 入らない／null 決められない（区分未確認のビデオグラムで、レンタルとセルの片方だけが対象）
function inTarget(channels, group) {
  if (!channels.length) return true;
  if (group === 'package') {
    const rental = channels.includes('rental');
    const sell = channels.includes('sell');
    return rental && sell ? true : rental || sell ? null : false;
  }
  return channels.includes(group);
}
// 計上月 → 締め月（設計書 §3-2 のプリセット）
function closeMonthOf(phase, month) {
  const kind = phase.cycle_kind;
  if (kind === 'monthly') return month;
  if (phase.first_close_immediate && month === phase.starts_month && ['quarterly', 'semiannual', 'annual', 'custom'].includes(kind)) return month;
  const step = {quarterly: 3, semiannual: 6, annual: 12}[kind];
  if (step) {
    for (let m = month; ; m = addMonth(m, 1)) if ((((Number(m.slice(5)) - phase.anchor_month) % step) + step) % step === 0) return m;
  }
  if (kind === 'custom') return phase.custom_close_months.split(',').sort().find((m) => m >= month) || null;
  return null;
}
const dueOf = (close, offset, day) => {
  const target = addMonth(close, offset);
  return day === 'eom' ? endOfMonth(target) : `${target}-${pad(Math.min(Number(day), Number(endOfMonth(target).slice(8))))}`;
};

// 元の行を読む（組織で絞る）
async function readRows(db, orgId) {
  const all = (sql) => db.all(sql, [orgId]);
  const data = {
    reports: await all('SELECT id, work_id, report_key, kind, status FROM report_imports WHERE org_id=?'),
    sales: await all('SELECT id, work_id, product_id, report_id, accounting_month, amount_ex_tax FROM sale_lines WHERE org_id=?'),
    productWorks: await all('SELECT product_id, work_id, allocation_bps FROM product_works WHERE org_id=? ORDER BY product_id, work_id'),
    classes: await all('SELECT sale_id, version_no, distribution_code, territory FROM sale_distribution_versions WHERE org_id=?'),
    expenses: await all('SELECT id, work_id, accounting_month, category, actual_ex_tax FROM expenses WHERE org_id=?'),
    agreements: await all('SELECT id, work_id, holder_partner_id, category, agreement_code FROM royalty_agreements WHERE org_id=? ORDER BY id'),
    terms: await all('SELECT * FROM royalty_term_versions WHERE org_id=?'),
    termChannels: await all('SELECT term_version_id, channel_group FROM royalty_term_channels WHERE org_id=?'),
    termCategories: await all('SELECT term_version_id, category FROM royalty_term_expense_categories WHERE org_id=?'),
    schedules: await all('SELECT id, agreement_id, version_no FROM royalty_schedule_versions WHERE org_id=?'),
    phases: await all('SELECT * FROM royalty_schedule_phases WHERE org_id=?'),
    manual: await all('SELECT id, agreement_id, accrual_month, amount_yen FROM royalty_manual_accruals WHERE org_id=?'),
    entries: await all('SELECT * FROM royalty_irregular_entries WHERE org_id=? ORDER BY id'),
    statements: await all('SELECT s.*, v.id AS void_id FROM royalty_statements s LEFT JOIN royalty_statement_voids v ON v.org_id=s.org_id AND v.statement_id=s.id WHERE s.org_id=? ORDER BY s.close_month, s.id'),
    events: await all('SELECT * FROM royalty_statement_events WHERE org_id=? ORDER BY id'),
    audit: await all('SELECT id, action, entity_type, entity_id, detail_json FROM audit_log WHERE org_id=? ORDER BY id'),
    contracts: await all('SELECT id, work_id FROM committee_contracts WHERE org_id=? ORDER BY id'),
    versions: await all('SELECT id, contract_id, version_no, manager_partner_id FROM committee_term_versions WHERE org_id=?'),
    windows: await all('SELECT * FROM committee_term_windows WHERE org_id=? ORDER BY id'),
    members: await all('SELECT term_version_id, partner_id, share_bps, member_order FROM committee_term_members WHERE org_id=?'),
    feeShares: await all('SELECT window_id, partner_id, share_bps FROM committee_term_window_fee_shares WHERE org_id=?'),
    investments: await all('SELECT term_version_id, partner_id, amount_yen FROM committee_term_investments WHERE org_id=?'),
  };
  // 登録の順（監査記録の番号）。報告書を作った時点で分かっていた行だけを、その報告書の計算に使う
  data.statementAudit = new Map();
  data.reportAudit = new Map();
  data.entryAudit = new Map();
  for (const row of data.audit) {
    if (row.entity_type === 'royalty_statement' && row.action === 'create') data.statementAudit.set(Number(row.entity_id), row.id);
    if (row.action === 'import') data.reportAudit.set(row.entity_id, row.id);
    if (row.entity_type === 'royalty_irregular_entry') data.entryAudit.set(row.action === 'reverse' ? JSON.parse(row.detail_json).reversalId : Number(row.entity_id), row.id);
  }
  return data;
}

// ある時点（監査記録の番号 cut より前）に分かっていた売上とイレギュラーの記録で、契約×計上月の発生額を計算する口
function makeView(data, cut = Infinity) {
  const reportKey = new Map(data.reports.map((report) => [report.id, report]));
  const sales = data.sales.filter((sale) => data.reportAudit.get(reportKey.get(sale.report_id).report_key) < cut);
  const latestClass = new Map();
  for (const row of data.classes) if (!latestClass.has(row.sale_id) || latestClass.get(row.sale_id).version_no < row.version_no) latestClass.set(row.sale_id, row);
  const groupOf = (sale) => {
    const cls = latestClass.get(sale.id);
    if (cls && cls.territory && !['日本', '国内'].includes(cls.territory)) return 'overseas';
    if (cls) return CODE_GROUP[cls.distribution_code];
    return KIND_GROUP[reportKey.get(sale.report_id).kind];
  };
  // 作品へ配賦した売上明細
  const linesByWork = new Map();
  for (const sale of sales) {
    const shares = data.productWorks.filter((row) => row.product_id === sale.product_id);
    const parts = shares.length ? shares : [{work_id: sale.work_id, allocation_bps: 10000}];
    const split = largestRemainder(sale.amount_ex_tax, parts.map((row) => ({key: row.work_id, bps: row.allocation_bps})));
    for (const [workId, amount] of split) {
      if (!linesByWork.has(workId)) linesByWork.set(workId, []);
      linesByWork.get(workId).push({saleId: sale.id, reportId: sale.report_id, month: sale.accounting_month, amount, group: groupOf(sale)});
    }
  }
  const expensesOf = (workId, month) => data.expenses.filter((row) => row.work_id === workId && row.accounting_month === month);
  // 製作委員会: 作品の最後の契約の最新の条件版
  const committeeOf = new Map();
  for (const contract of data.contracts) {
    const version = data.versions.filter((v) => v.contract_id === contract.id).sort((a, b) => b.version_no - a.version_no)[0];
    committeeOf.set(contract.work_id, {version, windows: data.windows.filter((w) => w.term_version_id === version.id),
      members: data.members.filter((m) => m.term_version_id === version.id).sort((a, b) => a.member_order - b.member_order || a.partner_id - b.partner_id)});
  }
  // 作品×計上月×区分の本委員会収入（PF控除は売上報告ごと、手数料は区分ごとに切り捨て）
  const cellCache = new Map();
  function cells(workId, month) {
    const key = `${workId}:${month}`;
    if (cellCache.has(key)) return cellCache.get(key);
    const committee = committeeOf.get(workId);
    const byGroup = new Map();
    for (const line of (linesByWork.get(workId) || []).filter((l) => l.month === month)) {
      if (!byGroup.has(line.group)) byGroup.set(line.group, new Map());
      const reports = byGroup.get(line.group);
      reports.set(line.reportId, (reports.get(line.reportId) || 0) + line.amount);
    }
    const out = [];
    for (const [group, reports] of byGroup) {
      const sales = [...reports.values()].reduce((n, v) => n + v, 0);
      const window = committee.windows.find((w) => w.kind === WINDOW_OF_GROUP[group]);
      if (!window) { out.push({group, sales, window: null, income: null}); continue; }
      const platformFee = [...reports.values()].reduce((n, v) => n + rateOf(v, window.platform_rate_bps), 0);
      const net = sales - platformFee;
      let windowFee;
      let managerFee;
      if (window.fee_order === 'window_first') {
        windowFee = rateOf(net, window.window_fee_bps);
        managerFee = rateOf(window.manager_fee_basis === 'after_window' ? net - windowFee : net, window.manager_fee_bps);
      } else {
        managerFee = rateOf(net, window.manager_fee_bps);
        windowFee = rateOf(window.window_fee_basis === 'after_manager' ? net - managerFee : net, window.window_fee_bps);
      }
      out.push({group, sales, window, platformFee, windowFee, managerFee, income: net - windowFee - managerFee});
    }
    cellCache.set(key, out);
    return out;
  }
  const termsOf = new Map();
  for (const agreement of data.agreements) {
    termsOf.set(agreement.id, data.terms.filter((t) => t.agreement_id === agreement.id).map((t) => ({...t,
      channels: data.termChannels.filter((c) => c.term_version_id === t.id).map((c) => c.channel_group),
      categories: data.termCategories.filter((c) => c.term_version_id === t.id).map((c) => c.category)})).sort((a, b) => a.effective_from.localeCompare(b.effective_from)));
  }
  const termAt = (agreementId, month) => termsOf.get(agreementId).filter((t) => t.effective_from <= month).at(-1) || null;
  const phasesOf = (agreementId) => {
    const schedule = data.schedules.filter((s) => s.agreement_id === agreementId).sort((a, b) => b.version_no - a.version_no)[0];
    return data.phases.filter((p) => p.schedule_version_id === schedule.id);
  };
  const phaseAt = (agreementId, month) => phasesOf(agreementId).find((p) => p.starts_month <= month && month <= (p.ends_month || '9999-12')) || null;
  // 契約×計上月の発生額（算定できない売上は入れない）
  const accrualCache = new Map();
  function accrual(agreement, month) {
    const key = `${agreement.id}:${month}`;
    if (accrualCache.has(key)) return accrualCache.get(key);
    const term = termAt(agreement.id, month);
    let value = null;
    if (term?.calc_method === 'manual') value = data.manual.filter((row) => row.agreement_id === agreement.id && row.accrual_month === month).reduce((n, row) => n + row.amount_yen, 0);
    else if (term?.calc_method === 'fixed_monthly') value = term.fixed_amount_yen;
    else if (term?.calc_method === 'rate') {
      const categoryOk = (category) => !term.categories.length || term.categories.includes(category);
      const expense = ['after_window_fee_and_expenses', 'committee_income_after_expenses'].includes(term.base_kind)
        ? expensesOf(agreement.work_id, month).filter((row) => categoryOk(row.category)).reduce((n, row) => n + row.actual_ex_tax, 0) : 0;
      let base;
      if (term.base_kind.startsWith('committee_income')) {
        base = cells(agreement.work_id, month).filter((cell) => cell.income !== null && inTarget(term.channels, cell.group) === true).reduce((n, cell) => n + cell.income, 0) - expense;
      } else {
        const target = (linesByWork.get(agreement.work_id) || []).filter((l) => l.month === month && inTarget(term.channels, l.group) === true).reduce((n, l) => n + l.amount, 0);
        const windowFee = ['after_window_fee', 'after_window_fee_and_expenses'].includes(term.base_kind) ? rateOf(target, term.window_fee_bps) : 0;
        base = target - windowFee - expense;
      }
      value = rateOf(base, term.rate_bps);
    }
    accrualCache.set(key, value);
    return value;
  }
  // 効いているイレギュラーの記録（取消の行と取り消された記録を除く）
  const knownEntries = data.entries.filter((entry) => data.entryAudit.get(entry.id) < cut);
  const reversed = new Set(knownEntries.filter((e) => e.reverses_entry_id).map((e) => e.reverses_entry_id));
  const live = knownEntries.filter((e) => !e.reverses_entry_id && !reversed.has(e.id));
  const held = new Map();
  const moves = new Map();
  for (const entry of live) {
    const key = `${entry.agreement_id}:${entry.accrual_month}`;
    if (entry.kind === 'hold') held.set(key, true);
    if (entry.kind === 'release') held.set(key, false);
    if (entry.kind === 'move_period') moves.set(key, entry.close_month);
  }
  const adjustments = knownEntries.filter((e) => e.kind === 'adjust_amount' && !e.reverses_entry_id).map((e) => ({...e, effective: reversed.has(e.id) ? 0 : e.amount_yen}));
  // 報告書に入れる締め月（計上無しは発生させない、締め月が決まらなければ null）
  function closeOf(agreement, month) {
    const phase = phaseAt(agreement.id, month);
    const key = `${agreement.id}:${month}`;
    if (moves.has(key)) return moves.get(key);
    return phase ? closeMonthOf(phase, month) : null;
  }
  const isNone = (agreement, month) => phaseAt(agreement.id, month)?.cycle_kind === 'none';
  const firstMonth = (agreement) => termsOf.get(agreement.id)[0].effective_from;
  return {linesByWork, cells, committeeOf, termAt, phaseAt, phasesOf, accrual, closeOf, isNone, firstMonth, held, moves, adjustments, expensesOf};
}

// 権利者の確定版を、締め月の古い順に作り直す（報告済みの額との差を次の報告書へ入れる決まり §8 を含む）
function expectedStatements(data, holderId) {
  const agreements = data.agreements.filter((a) => a.holder_partner_id === holderId);
  const list = data.statements.filter((s) => s.holder_partner_id === holderId && !s.void_id);
  const reported = new Map();
  const reportedAdjust = new Map();
  const recouped = new Map();
  let carry = 0;
  const views = new Map();
  return list.map((statement) => {
    const cut = data.statementAudit.get(statement.id);
    if (!views.has(cut)) views.set(cut, makeView(data, cut));
    const view = views.get(cut);
    const perAgreement = new Map();
    let royalty = 0;
    for (const agreement of agreements) {
      for (const month of monthsFromTo(view.firstMonth(agreement), statement.close_month)) {
        if (view.isNone(agreement, month)) continue;
        const value = view.accrual(agreement, month);
        const close = view.closeOf(agreement, month);
        const key = `${agreement.id}:${month}`;
        if (value === null || !close || close > statement.close_month || view.held.get(key)) continue;
        const delta = value - (reported.get(key) ?? 0);
        reported.set(key, value);
        royalty += delta;
        perAgreement.set(agreement.id, (perAgreement.get(agreement.id) ?? 0) + delta);
      }
    }
    let adjustment = 0;
    for (const entry of view.adjustments.filter((e) => e.holder_partner_id === holderId && e.close_month <= statement.close_month)) {
      adjustment += entry.effective - (reportedAdjust.get(entry.id) ?? 0);
      reportedAdjust.set(entry.id, entry.effective);
    }
    let recoup = 0;
    for (const agreement of agreements) {
      const advance = view.termAt(agreement.id, statement.close_month)?.advance_yen ?? 0;
      if (!advance) continue;
      const cumulative = [...reported].filter(([key]) => key.startsWith(`${agreement.id}:`)).reduce((n, [, v]) => n + v, 0);
      const now = Math.min(advance, Math.max(0, cumulative)) - (recouped.get(agreement.id) ?? 0);
      recouped.set(agreement.id, (recouped.get(agreement.id) ?? 0) + now);
      recoup += now;
    }
    const thresholds = agreements.map((a) => view.termAt(a.id, statement.close_month)).filter(Boolean).map((t) => t.min_payment_yen ?? 0);
    const minimum = thresholds.length ? Math.min(...thresholds) : 0;
    const balance = carry + royalty + adjustment - recoup;
    const payable = balance > 0 && balance >= minimum ? balance : 0;
    const carriedOut = balance - payable;
    // 報告・支払の期限: この締め月を作るフェーズ（締め月の変更を含む）のうち早いもの
    const dues = [];
    for (const agreement of agreements) {
      for (const month of monthsFromTo(view.firstMonth(agreement), statement.as_of.slice(0, 7))) {
        const phase = view.phaseAt(agreement.id, month);
        if (!phase || ['none', 'manual'].includes(phase.cycle_kind) || closeMonthOf(phase, month) !== statement.close_month) continue;
        dues.push([dueOf(statement.close_month, phase.report_offset_months, phase.report_day), dueOf(statement.close_month, phase.payment_offset_months, phase.payment_day)]);
      }
      for (const [key, close] of view.moves) {
        if (close !== statement.close_month || !key.startsWith(`${agreement.id}:`)) continue;
        const phase = view.phaseAt(agreement.id, key.split(':')[1]);
        dues.push([dueOf(close, phase.report_offset_months, phase.report_day), dueOf(close, phase.payment_offset_months, phase.payment_day)]);
      }
    }
    const result = {id: statement.id, closeMonth: statement.close_month, royaltyYen: royalty, adjustmentYen: adjustment, advanceRecoupedYen: recoup, carriedInYen: carry,
      payableYen: payable, carriedOutYen: carriedOut, reportDueOn: dues.map((d) => d[0]).sort()[0] ?? null, paymentDueOn: dues.map((d) => d[1]).sort()[0] ?? null, perAgreement};
    carry = carriedOut;
    return result;
  });
}

// ---------- 準備（1回投入した DB を全試験で使う） ----------
let db;
let app;
let seeded;
let data;
const login = async (email) => {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200, email);
  return response.headers.get('set-cookie').split(';')[0];
};
const call = async (cookie, path, payload) => {
  const response = await app.request(`/api${path}`, {method: payload ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: payload ? JSON.stringify(payload) : undefined});
  return {status: response.status, body: await response.json(), headers: response.headers};
};
const tableCounts = async (orgId) => {
  const out = {};
  for (const table of ['works', 'products', 'partners', 'report_imports', 'sale_lines', 'sale_distribution_versions', 'expenses', 'royalty_agreements', 'royalty_term_versions',
    'royalty_manual_accruals', 'royalty_irregular_entries', 'royalty_statements', 'royalty_statement_lines', 'royalty_statement_events', 'committee_contracts', 'audit_log']) {
    out[table] = Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`, [orgId])).n);
  }
  return out;
};

before(async (t) => {
  db = await openTestDb({t});
  seeded = await seedSalesDemo(db);
  app = createApp({db, mode: 'local'});
  data = await readRows(db, seeded.orgId);
});
after(() => db?.close());

test('架空データは別組織 DEMO-SALES に1回だけ入り、2回目は何も足さない', async () => {
  assert.equal(seeded.skipped, false);
  const org = await db.get('SELECT id, code, name FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  assert.equal(org.id, seeded.orgId);
  assert.equal(org.name, '架空データ（デモ）');
  assert.deepEqual({works: seeded.works, committeeWorks: seeded.committeeWorks, holders: seeded.holders, agreements: seeded.agreements}, {works: 20, committeeWorks: 8, holders: 20, agreements: 80});
  assert.ok(seeded.saleLines > 600 && seeded.statements > 100 && seeded.statementEvents > 150, JSON.stringify(seeded));
  const counts = await tableCounts(seeded.orgId);
  const others = await db.get('SELECT COUNT(*) AS n FROM sale_lines WHERE org_id<>?', [seeded.orgId]);
  const second = await seedSalesDemo(db);
  assert.deepEqual(second, {skipped: true, orgId: seeded.orgId});
  assert.deepEqual(await tableCounts(seeded.orgId), counts, '2回目は何も足さない');
  assert.deepEqual(await db.get('SELECT COUNT(*) AS n FROM sale_lines WHERE org_id<>?', [seeded.orgId]), others);
  // コード・名前はすべて架空
  for (const row of await db.all('SELECT code, name FROM partners WHERE org_id=?', [seeded.orgId])) {
    assert.match(row.code, /^DEMO-/);
    assert.match(row.name, /架空/);
  }
  for (const row of await db.all('SELECT code, title FROM works WHERE org_id=?', [seeded.orgId])) {
    assert.match(row.code, /^DEMO-W\d\d$/);
    assert.match(row.title, /（架空）$/);
  }
  assert.ok((await db.all('SELECT sku FROM products WHERE org_id=?', [seeded.orgId])).every((row) => row.sku.startsWith('DEMO-')));
  assert.ok((await db.all('SELECT agreement_code FROM royalty_agreements WHERE org_id=?', [seeded.orgId])).every((row) => row.agreement_code.startsWith('DEMO-')));
  assert.deepEqual(await foreignKeyViolations(db), []);
});

test('組織1からは架空データが見えず、切り替えた人だけが見える', async () => {
  const fixture = await login(SALES_DEMO.fixtureAdminEmail);
  assert.equal((await call(fixture, '/session')).body.user.orgId, 1, '既存の管理者は組織1で入る');
  const boot = (await call(fixture, '/bootstrap')).body;
  assert.equal(boot.works.filter((w) => w.code.startsWith('DEMO-')).length, 0);
  assert.equal(boot.partners.filter((p) => p.code.startsWith('DEMO-')).length, 0);
  assert.equal((await call(fixture, '/royalty/agreements')).body.agreements.filter((a) => a.code.startsWith('DEMO-')).length, 0);
  assert.equal((await call(fixture, '/royalty/statements?asOf=2026-09-25')).body.statements.length, 0);
  assert.equal((await call(fixture, '/reports/committee-monthly/works')).body.works.filter((w) => w.code.startsWith('DEMO-')).length, 0);
  const demoWork = await db.get("SELECT id FROM works WHERE org_id=? AND code='DEMO-W01'", [seeded.orgId]);
  assert.equal((await call(fixture, `/reports/committee-monthly?workId=${demoWork.id}&from=2024-07&to=2026-06`)).status, 403);
  assert.equal((await call(fixture, `/royalty/statements/${data.statements[0].id}`)).status, 404);
  assert.equal((await call(fixture, '/sales')).body.rows.filter((row) => row.work_id === demoWork.id).length, 0);
  // 既存の管理者は DEMO-SALES にも所属し、切り替えると見える
  const orgs = (await call(fixture, '/session/orgs')).body.orgs.map((o) => o.code);
  assert.deepEqual(orgs, ['demo', SALES_DEMO.orgCode]);
  const switched = await call(fixture, '/session/org', {orgId: seeded.orgId});
  assert.equal(switched.status, 200);
  const both = `${fixture}; ${switched.headers.get('set-cookie').split(';')[0]}`;
  assert.equal((await call(both, '/bootstrap')).body.works.filter((w) => w.code.startsWith('DEMO-W')).length, 20);
  // 架空の管理者は DEMO-SALES だけに所属する
  const demo = await login(SALES_DEMO.adminEmail);
  assert.deepEqual((await call(demo, '/session/orgs')).body.orgs.map((o) => o.code), [SALES_DEMO.orgCode]);
  assert.equal((await call(demo, '/bootstrap')).body.works.length, 20);
});

test('架空データは設計 §6 の場面をそろえている', async () => {
  const cycles = new Set(data.phases.map((p) => `${p.cycle_kind}:${p.anchor_month ?? ''}`));
  for (const kind of ['semiannual:6', 'quarterly:3', 'annual:6', 'annual:12', 'monthly:', 'custom:', 'manual:', 'none:']) assert.ok(cycles.has(kind), kind);
  assert.ok(data.phases.some((p) => p.first_close_immediate), '初月即締');
  assert.ok(data.phases.some((p) => p.payment_offset_months === 3), '翌々々月末払い');
  assert.ok(data.schedules.some((s) => s.version_no === 2), '途中でサイクルを変えた契約');
  assert.ok(data.terms.some((t) => t.version_no === 2), '途中で条件を変えた契約');
  assert.ok(data.terms.some((t) => t.advance_yen > 0) && data.terms.some((t) => t.min_payment_yen > 0), '前払金と支払の下限');
  for (const kind of ['adjust_amount', 'move_period', 'hold', 'release', 'note']) assert.ok(data.entries.some((e) => e.kind === kind), kind);
  assert.ok(data.entries.some((e) => e.reverses_entry_id) && data.manual.some((m) => m.amount_yen < 0), '取消の記録');
  const negativeMonths = await db.all(`SELECT s.work_id, s.accounting_month FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    WHERE s.org_id=? AND r.report_key LIKE '%-SEL-%' GROUP BY s.work_id, s.accounting_month HAVING SUM(s.amount_ex_tax) < 0`, [seeded.orgId]);
  assert.ok(negativeMonths.length >= 3, '返品が売上を上回ってマイナスになる計上月');
  assert.equal(seeded.committeeSnapshots, 2, '製作委員会の期間報告（保存済み）');
  assert.ok(data.productWorks.some((row) => row.allocation_bps < 10000), '2作品に配賦する商品');
  const statuses = (await call(await login(SALES_DEMO.adminEmail), `/royalty/periods?asOf=${SALES_DEMO.asOf}`)).body.counts;
  assert.ok(statuses.paid > 0 && statuses.reported > 0 && statuses.overdue > 0 && statuses.open > 0, JSON.stringify(statuses));
  const members = data.members;
  const majority = data.versions.filter((v) => members.some((m) => m.term_version_id === v.id && m.share_bps > 5000)).length;
  assert.ok(data.contracts.length === 8 && majority >= 1 && majority < 8, '過半の出資者がいる委員会と、いない委員会がある');
  assert.ok(data.versions.some((v) => members.filter((m) => m.term_version_id === v.id).length >= 4 && new Set(members.filter((m) => m.term_version_id === v.id).map((m) => m.share_bps)).size === 1), '均等の出資');
  assert.ok(new Set(data.feeShares.map((row) => row.window_id)).size >= 1 && data.feeShares.length >= 2, '窓口手数料を2社で分ける窓口');
});

test('FR-SETL-ACCR-023 集計シートの発生額・調整・前払金・支払・未払残を、元の行から計算し直した額と照合する', async () => {
  const cookie = await login(SALES_DEMO.adminEmail);
  const view = makeView(data);
  for (const to of ['2026-06', '2026-09']) {
    const {body: ledger} = await call(cookie, `/royalty/ledger?from=2024-07&to=${to}`);
    assert.equal(ledger.ok, true);
    assert.ok(ledger.checks.every((c) => c.value === 0), JSON.stringify(ledger.checks));
    // 明細（契約×計上月）の発生額
    const model = new Map(ledger.detail.map((row) => [`${row.agreementId}:${row.accrualMonth}`, row.royaltyYen]));
    for (const agreement of data.agreements) {
      for (const month of monthsFromTo(view.firstMonth(agreement), to)) {
        if (view.isNone(agreement, month)) { assert.equal(model.has(`${agreement.id}:${month}`), false, `${agreement.agreement_code} ${month} は計上無し`); continue; }
        const expected = view.accrual(agreement, month);
        const key = `${agreement.id}:${month}`;
        if (model.has(key)) assert.equal(model.get(key), expected, `${agreement.agreement_code} ${month}`);
        else assert.equal(expected, 0, `${agreement.agreement_code} ${month} の発生額が集計シートにありません`);
      }
    }
    // 権利者ごとの累計・調整・前払金の充当・支払・未払残
    const endDate = endOfMonth(to);
    for (const row of ledger.byHolder) {
      const own = data.agreements.filter((a) => a.holder_partner_id === row.holderId);
      let cumulative = 0;
      let recoup = 0;
      for (const agreement of own) {
        const months = monthsFromTo(view.firstMonth(agreement), to).filter((m) => !view.isNone(agreement, m));
        const total = months.reduce((n, m) => n + (view.accrual(agreement, m) ?? 0), 0);
        cumulative += total;
        const advance = view.termAt(agreement.id, to)?.advance_yen ?? 0;
        if (advance) recoup += Math.min(advance, Math.max(0, total));
      }
      const adjustment = view.adjustments.filter((e) => e.holder_partner_id === row.holderId && e.close_month <= to).reduce((n, e) => n + e.effective, 0);
      const statementIds = new Set(data.statements.filter((s) => s.holder_partner_id === row.holderId && !s.void_id).map((s) => s.id));
      const paid = data.events.filter((e) => statementIds.has(e.statement_id) && e.event_kind === 'paid' && e.occurred_on <= endDate)
        .reduce((n, e) => n + (e.reverses_event_id ? -e.amount_yen : e.amount_yen), 0);
      const label = `${row.holderName}（${to}）`;
      assert.equal(row.cumulativeYen, cumulative, `${label} 累計`);
      assert.equal(row.adjustmentYen, adjustment, `${label} 調整`);
      assert.equal(row.recoupYen, recoup, `${label} 前払金の充当`);
      assert.equal(row.paidYen, paid, `${label} 支払`);
      assert.equal(row.unpaidYen, cumulative + adjustment - recoup - paid, `${label} 未払残`);
      for (const month of ledger.months) {
        const expected = own.filter((a) => !view.isNone(a, month) && month >= view.firstMonth(a)).reduce((n, a) => n + (view.accrual(a, month) ?? 0), 0);
        assert.equal(row.months[month], expected, `${label} ${month}`);
      }
    }
    assert.equal(ledger.byHolder.length, 20);
  }
});

test('FR-SETL-STMT-010 FR-SETL-STMT-013 ロイヤリティ報告書（全権利者×全締め月）を、元の行から計算し直した額と照合する', async () => {
  const cookie = await login(SALES_DEMO.adminEmail);
  const holders = [...new Set(data.agreements.map((a) => a.holder_partner_id))];
  let compared = 0;
  let revisions = 0;
  for (const holderId of holders) {
    for (const expected of expectedStatements(data, holderId)) {
      const {body} = await call(cookie, `/royalty/statements/${expected.id}?asOf=${SALES_DEMO.asOf}`);
      assert.equal(body.ok, true);
      const s = body.statement;
      const label = `${s.holderName} ${expected.closeMonth}締め`;
      for (const key of ['royaltyYen', 'adjustmentYen', 'advanceRecoupedYen', 'carriedInYen', 'payableYen', 'carriedOutYen', 'reportDueOn', 'paymentDueOn']) {
        assert.equal(s[key], expected[key], `${label} ${key}`);
      }
      const byAgreement = new Map(body.calculation.rows.map((row) => [row.agreementId, row.current.amountYen]));
      for (const [agreementId, amount] of expected.perAgreement) assert.equal(byAgreement.get(agreementId) ?? 0, amount, `${label} 契約${agreementId}`);
      assert.ok(body.calculation.checks.every((c) => c.value === 0), `${label} ${JSON.stringify(body.calculation.checks)}`);
      revisions += body.calculation.lines.filter((line) => line.lineKind === 'revision').length;
      compared += 1;
    }
  }
  assert.equal(compared, data.statements.length);
  assert.ok(revisions >= 3, '保留の解除・遅れて届いた報告・締め月の変更が「報告後の修正」として入る');
});

test('委員会月次収支（8作品×全月）を、元の行から計算し直した額と照合する', async () => {
  const cookie = await login(SALES_DEMO.adminEmail);
  // 報告額の基準: 個別精算への紐付けは無く、委員会の期間報告で結んだ報告は控除前。どちらも無い報告は既定の控除前
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM settlement_report_links WHERE org_id=?', [seeded.orgId])).n), 0);
  const snapshotBasis = await db.all('SELECT DISTINCT report_basis FROM committee_snapshot_reports WHERE org_id=?', [seeded.orgId]);
  assert.deepEqual(snapshotBasis.map((row) => row.report_basis), ['gross'], '期間報告で結んだ報告は控除前');
  const view = makeView(data);
  const works = await db.all('SELECT id, code FROM works WHERE org_id=?', [seeded.orgId]);
  const from = '2024-01';
  const to = '2026-06';
  let deficitWorks = 0;
  for (const contract of data.contracts) {
    const work = works.find((w) => w.id === contract.work_id);
    const {body} = await call(cookie, `/reports/committee-monthly?workId=${work.id}&from=${from}&to=${to}`);
    assert.equal(body.ok, true, work.code);
    assert.equal(body.checksOk, true, `${work.code} ${JSON.stringify(body.report.checks.filter((c) => c.value !== 0))}`);
    const committee = view.committeeOf.get(work.id);
    const agreements = data.agreements.filter((a) => a.work_id === work.id);
    const months = monthsFromTo(from, to);
    assert.deepEqual(body.report.historyMonths, months);
    let cumPool = 0;
    let distributedBefore = 0;
    const cumAcquisition = new Map();
    for (const [index, month] of months.entries()) {
      const cells = view.cells(work.id, month);
      const known = cells.filter((cell) => cell.income !== null);
      const sum = (list, key) => list.reduce((n, cell) => n + cell[key], 0);
      const expense = view.expensesOf(work.id, month).reduce((n, row) => n + row.actual_ex_tax, 0);
      const royalty = agreements.filter((a) => month >= view.firstMonth(a) && !view.isNone(a, month)).reduce((n, a) => n + (view.accrual(a, month) ?? 0), 0);
      const income = sum(known, 'income');
      const pool = income - expense - royalty;
      cumPool += pool;
      const distributable = Math.max(0, cumPool);
      const distribution = distributable - distributedBefore;
      distributedBefore = distributable;
      const got = body.report.monthly[index];
      const label = `${work.code} ${month}`;
      assert.deepEqual({sales: got.sales, holdSales: got.holdSales, platformFee: got.platformFee, windowFee: got.windowFee, managerFee: got.managerFee, income: got.income,
        expense: got.expense, royalty: got.royalty, pool: got.pool, cumPool: got.cumPool, distribution: got.distribution, undistributed: got.undistributed},
      {sales: sum(cells, 'sales'), holdSales: sum(cells.filter((cell) => cell.income === null), 'sales'), platformFee: sum(known, 'platformFee'), windowFee: sum(known, 'windowFee'),
        managerFee: sum(known, 'managerFee'), income, expense, royalty, pool, cumPool, distribution, undistributed: cumPool - distributable}, label);
      for (const cell of cells) assert.equal(got.salesByChannel[cell.group], cell.sales, `${label} ${cell.group}`);
      // 出資者への分配（持分・最大剰余法）、窓口手数料の取り分、幹事手数料
      const acquisition = new Map();
      const add = (partnerId, key, amount) => {
        if (!acquisition.has(partnerId)) acquisition.set(partnerId, {distribution: 0, windowFee: 0, managerFee: 0});
        acquisition.get(partnerId)[key] += amount;
      };
      for (const [partnerId, amount] of largestRemainder(distribution, committee.members.map((m) => ({key: m.partner_id, bps: m.share_bps})))) add(partnerId, 'distribution', amount);
      for (const window of committee.windows) {
        const fee = known.filter((cell) => cell.window.id === window.id).reduce((n, cell) => n + cell.windowFee, 0);
        if (!fee) continue;
        const order = new Map(committee.members.map((m) => [m.partner_id, m.member_order]));
        const shares = data.feeShares.filter((row) => row.window_id === window.id).sort((a, b) => (order.get(a.partner_id) ?? 999) - (order.get(b.partner_id) ?? 999) || a.partner_id - b.partner_id);
        const parts = shares.length ? shares.map((row) => ({key: row.partner_id, bps: row.share_bps})) : [{key: window.window_partner_id, bps: 10000}];
        for (const [partnerId, amount] of largestRemainder(fee, parts)) add(partnerId, 'windowFee', amount);
      }
      add(committee.version.manager_partner_id, 'managerFee', sum(known, 'managerFee'));
      for (const [partnerId, expected] of acquisition) {
        const total = expected.distribution + expected.windowFee + expected.managerFee;
        cumAcquisition.set(partnerId, (cumAcquisition.get(partnerId) ?? 0) + total);
        assert.deepEqual(got.investors[partnerId], {...expected, acquisition: total, cumulativeAcquisition: cumAcquisition.get(partnerId)}, `${label} 取引先${partnerId}`);
      }
    }
    // 出資額・回収率・利益
    for (const investor of body.report.investors) {
      const invested = data.investments.find((row) => row.term_version_id === committee.version.id && row.partner_id === investor.partnerId)?.amount_yen ?? null;
      assert.equal(investor.investmentYen, invested);
      assert.equal(investor.cumulative.acquisition, cumAcquisition.get(investor.partnerId) ?? 0);
      if (invested) assert.equal(investor.profit, investor.cumulative.acquisition - invested);
    }
    if (body.report.summary.deficitMonths.length) deficitWorks += 1;
  }
  assert.equal(deficitWorks, 8, '公開前の宣伝費で、どの作品にも赤字の月がある');
  const flop = works.find((w) => w.code === 'DEMO-W15');
  const {body: flopReport} = await call(cookie, `/reports/committee-monthly?workId=${flop.id}&from=${from}&to=${to}`);
  assert.equal(flopReport.report.summary.cumulative.distribution, 0, '回収できていない作品は分配しない');
  assert.ok(flopReport.report.summary.cumulative.undistributed < 0);
});

test('FR-SETL-STMT-008 FR-SETL-STMT-026 期間の一覧・下書き・報告と支払の記録: 期限超過・未払・受付中が出て、照合はすべて0', async () => {
  const cookie = await login(SALES_DEMO.adminEmail);
  const {body} = await call(cookie, `/royalty/periods?asOf=${SALES_DEMO.asOf}`);
  assert.equal(body.counts.pending, 0, '基準日までに締めた期間はすべて確定版にした');
  assert.equal(body.counts.overdue, 1);
  assert.ok(body.periods.filter((p) => p.draft).every((p) => p.draft.checksOk), '受付中の期間の下書きの照合も0');
  assert.ok(body.periods.some((p) => p.status === 'open' && p.adjustmentYen === 50000), '基準日の後の締め月へ入れる調整');
  const {body: list} = await call(cookie, `/royalty/statements?asOf=${SALES_DEMO.asOf}`);
  const paymentOverdue = list.statements.filter((s) => s.unpaidYen > 0 && s.paymentDueOn < SALES_DEMO.asOf);
  assert.equal(paymentOverdue.length, 2, '支払期限を過ぎて未払の報告書が2通');
  assert.ok(list.statements.some((s) => s.status === 'overdue'));
  // 支払の取消を含めて、支払の記録は支払予定額を超えない
  for (const s of list.statements) assert.ok(s.paidYen <= s.payableYen, `${s.id}`);
  assert.ok(data.events.some((e) => e.reverses_event_id), '支払の取消の記録');
});
