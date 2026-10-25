// 会社への利益額（K-16）の受け口（フェーズ1の仕様書 #14b。要件 docs/requirements/accounting/company-profit.md）。
//   GET /api/accounting/profit?basis=accrual|cash[&from=YYYY-MM&to=YYYY-MM]
//   基準（basis）は accrual（既定。計上）か cash（入金）。ほかの値は 400。月の期間は省けば全期間（両方の基準で記録のある月）
//   GET /api/accounting/profit/sources?basis=accrual|cash[&from=YYYY-MM&to=YYYY-MM]
//   その源泉別の内訳（行動指標の計画 段B #2。FR-ACCT-PROFIT-013）。5つの源泉ごとの売上・出資額・経費・粗利を、実績の窓（期間の始まり〜期間の終わりと
//   締めた月の早い方）で出し、同じ窓・同じ基準の利益額と突き合わせる。源泉3〜5 は未接続。締めた月は予実の月の設定（移行 0018 の closed_month）の最新の版
// - 権限: 制作担当は 403。財務の権限がある案件（管理者は組織の全案件、編集担当は所属が edit の案件）の入出金だけを読む。財務の権限のある案件が
//   1つも無い編集担当は 403。案件不明の行は会社全体を見てよい人（管理者か、組織の全案件に財務の権限がある人）にだけ出す。組織は identity の org_id だけ
// - SQL は readProfitSources の1回の読み取りの一括（10文。認証の文は数えない）。期間を渡すと、売上明細・入金・経費・払込を期間で絞って読む。
//   源泉別は 締めた月の設定の1文と readSourceProfitSources の1回の読み取りの一括（9文）の固定の10文（案件・稟議・契約の版の数によらない）
// - sourceHash は応答の中身（作った時刻を除く）の SHA-256。同じ入力・同じ読む人で同じ値（画面の data-ready の照合に使う）
// Worker でも動くよう node:* を import しない
import {readProfitSources, readSourceProfitSources} from '../accounting-store.mjs';
import {readEffectiveChoices} from '../../revenue/revenue-store.mjs';
import {parseBasis} from '../../reports/pl-bs-cash-model.mjs';
import {buildCompanyProfit, profitRecordsFromSources} from './profit-model.mjs';
import {buildSourceProfit, sourceProfitInputFromSources} from './source-profit-model.mjs';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// 期間の引数を読む（省けば null。形の違う値・逆順は誤り）
export function parseProfitPeriod(rawFrom, rawTo) {
  const from = rawFrom === undefined || rawFrom === '' ? null : rawFrom;
  const to = rawTo === undefined || rawTo === '' ? null : rawTo;
  if (from !== null && !MONTH.test(from)) return {ok: false, field: 'from', error: '期間の開始月（from）は「2026-05」の形で指定してください'};
  if (to !== null && !MONTH.test(to)) return {ok: false, field: 'to', error: '期間の終了月（to）は「2026-05」の形で指定してください'};
  if (from !== null && to !== null && from > to) return {ok: false, field: 'from', error: '期間の開始月が終了月より後になっています'};
  return {ok: true, from, to};
}

// データの時点: 読んだ入金・出金・払込の日付の最後。期間を渡したときは期間の月に入る日付だけ
// （期間に入る経費の出金は期間の外の分も読むので、期間の外の出金日を時点にしない）
function lastMovement(sources, {from, to}) {
  const inRange = (on) => (from === null || on.slice(0, 7) >= from) && (to === null || on.slice(0, 7) <= to);
  const dates = [
    ...sources.receiptRows.flatMap((row) => [row.received_on, row.reversed_on]),
    ...sources.expenseRows.map((row) => row.paid_on),
    ...sources.committeePaymentRows.map((row) => row.paid_on),
    ...sources.ownInvestmentPaymentRows.map((row) => row.paid_on),
  ].filter((on) => on && inRange(String(on)));
  return dates.reduce((latest, on) => (latest === null || on > latest ? on : latest), null);
}

export function registerProfitRoutes(app, {db, bad, permittedProjectScope, sha256, canonical}) {
  if (!app || !db || typeof bad !== 'function' || typeof permittedProjectScope !== 'function' || typeof sha256 !== 'function' || typeof canonical !== 'function') {
    throw new Error('profit routes require app, db, bad, permittedProjectScope, sha256 and canonical');
  }

  app.get('/api/accounting/profit', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '会社への利益額は財務の画面です（制作担当は見られません）', 403);
    const basisRead = parseBasis(c.req.query('basis'));
    if (!basisRead.ok) return bad(c, basisRead.error, 400, {field: 'basis'});
    const period = parseProfitPeriod(c.req.query('from'), c.req.query('to'));
    if (!period.ok) return bad(c, period.error, 400, {field: period.field});
    const sources = await readProfitSources(db, identity.org_id, {scope: permittedProjectScope(identity, true), from: period.from, to: period.to});
    if (identity.role !== 'admin' && !sources.projectRows.length) return bad(c, '財務の権限がある案件がありません', 403);
    const includeCompany = identity.role === 'admin' || (sources.projectCount > 0 && sources.projectRows.length === sources.projectCount);
    const view = buildCompanyProfit(profitRecordsFromSources(sources), {basis: basisRead.basis, from: period.from, to: period.to, includeCompany});
    const dataAsOf = {label: '最後の入出金', at: lastMovement(sources, period)};
    const scope = {company: includeCompany, projectCount: sources.projectRows.length};
    const sourceHash = await sha256(canonical({...view, scope, dataAsOf}));
    return c.json({ok: true, ...view, scope, dataAsOf: {...dataAsOf, generatedAt: new Date().toISOString()}, sourceHash});
  });

  // 源泉別の内訳（行動指標の計画 段B #2）。権限と引数は利益額と同じ。締めた月より後の記録は読まない（実績の窓の外で、出資の回収の累計も締めた月まで）
  app.get('/api/accounting/profit/sources', async (c) => {
    const identity = c.get('identity');
    if (!identity || identity.role === 'production') return bad(c, '源泉別の利益額は財務の画面です（制作担当は見られません）', 403);
    const basisRead = parseBasis(c.req.query('basis'));
    if (!basisRead.ok) return bad(c, basisRead.error, 400, {field: 'basis'});
    const period = parseProfitPeriod(c.req.query('from'), c.req.query('to'));
    if (!period.ok) return bad(c, period.error, 400, {field: period.field});
    const choices = await readEffectiveChoices(db, identity.org_id);
    const closedMonth = choices.closedMonth ? String(choices.closedMonth.value).slice(0, 7) : null;
    const read = await readSourceProfitSources(db, identity.org_id, {scope: permittedProjectScope(identity, true), to: closedMonth ?? period.to});
    if (identity.role !== 'admin' && !read.profit.projectRows.length) return bad(c, '財務の権限がある案件がありません', 403);
    const includeCompany = identity.role === 'admin' || (read.profit.projectCount > 0 && read.profit.projectRows.length === read.profit.projectCount);
    const view = buildSourceProfit(sourceProfitInputFromSources(read), {basis: basisRead.basis, from: period.from, to: period.to, closedMonth, includeCompany});
    const actual = view.window;
    const dataAsOf = {label: '最後の入出金（実績の窓の中）', at: actual.empty ? null : lastMovement(read.profit, {from: actual.from, to: actual.to})};
    const scope = {company: includeCompany, projectCount: read.profit.projectRows.length};
    const sourceHash = await sha256(canonical({...view, scope, dataAsOf}));
    return c.json({ok: true, ...view, scope, dataAsOf: {...dataAsOf, generatedAt: new Date().toISOString()}, sourceHash});
  });
}
