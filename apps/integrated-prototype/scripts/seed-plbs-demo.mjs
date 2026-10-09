#!/usr/bin/env node
// PL・BS（管理会計の試算）を画面で確かめるための架空データを、組織 DEMO-SALES に足す。設計: docs/platform/team-development/pl-bs-design.md §6。
// 使い方: node scripts/seed-plbs-demo.mjs --db <SQLiteのパス>
// ・先に scripts/seed-sales-demo.mjs（売上の架空データ）を流しておく（必須）。
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番のD1・設定・秘密値は読まない。
// ・すべて API を通して登録する（検証・トリガー・監査は画面から登録したときと同じ）。DDL は流さない。1つの値は128KB未満（本番へ記録して再生できるように）。
// ・節ごとに目印を持ち、2回流しても増えない（目印のある節は何もしない）:
//   1. 会社の設定（目印: 法人情報の版がある）… 年度（期首5月・確認済み）、架空の法人情報（自社＝取引先 DEMO-SELF）、期首残高の基準月 2024-04、勘定科目の初期値
//   2. 自社作品の制作費（目印: 自社作品に費目「制作費」の経費がある）… 委員会でない12本に、案件の予算の残りを割り振った架空の額を公開月の3か月前から
//   3. 経費の出金日（目印: 経費の出金の記録がある）… 多くは計上月の翌月末。一部は未払のまま、1件は2回に分けて、1件は振込の誤りを取り消して払い直す
//   4. 委員会への出資の払込（目印: 出資の払込の記録がある）… 自社の出資額を公開の2か月前の月末（2本は2回に分けて）
//   5. 請求と入金（目印: 請求書がある）… 自社作品の売上報告を、計上月の翌月5日に請求し、翌々月末に入金（2026-04 計上分まで）
//   6. 手入力の額（目印: 手入力の額がある）… 期首残高（現預金3.5億・固定資産300万・資本金1億・借入金2億・繰越利益剰余金は差額）、
//      全社費用（月およそ350万円を9科目。課税の科目は消費税額10%も）、固定資産の月末残高（減価償却費の分だけ減る）、
//      追加の借入（制作と出資の支払に合わせて3回・計4億。借入金の月末残高）、支払利息（前月末の借入金×年1.08%）
//   7. 委員会からの受取（目印: 期間報告の自社への支払がある）… 保存済みの期間報告（DEMO-W01 の2件）の自社の分配
// ・名前はすべて「（架空）」付き、コードは DEMO-*。実在の社名・作品名・実データは使わない。
// ・減価償却費（月5万円）は現預金を動かさない科目で、見合う固定資産の月末残高も入れるので、会社BSの「説明のつかない差額」は0円になる（設計 §6）。
// ・現預金は期首の翌月から基準月の後まで、どの月末もマイナスにならない（制作費・出資の支払に合わせて借入を足す。どれも架空の額）。
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {expenseDemoWriter} from './seed-expense-support.mjs';
import {createApp} from '../src/app.mjs';
import {SALES_DEMO, addMonths} from './seed-sales-demo.mjs';

export const PLBS_DEMO = Object.freeze({
  asOf: SALES_DEMO.asOf,
  openingMonth: '2024-04', // 期首残高の基準月（年度 2024 は 2024-05 から）
  manualFrom: '2024-05', manualTo: '2026-08', // 全社費用・支払利息を入れる月
  billingTo: '2026-04', // 請求・入金を入れる計上月の終わり（直近2か月は売掛金に残る）
  profile: Object.freeze({legalName: '架空データ映像株式会社（架空）', address: '東京都架空区映像町1-2-3（架空）', postalCode: '100-0000', capitalYen: 100000000, selfPartnerCode: 'DEMO-SELF'}),
  opening: Object.freeze({cash: 350000000, capital: 100000000, loan: 200000000, fixedAssets: 3000000}),
  // 全社費用（月額・税抜）。合計 3,500,000円。旅費交通費と通信費は月で少し動かす
  overhead: Object.freeze([['6210', 800000], ['6220', 1600000], ['6230', 360000], ['6240', 380000], ['6250', 60000], ['6260', 120000], ['6270', 90000], ['6280', 50000], ['6290', 40000]]),
  // 課税仕入の科目（消費税額は税抜の10%・円未満切り捨て）。役員報酬・給与・法定福利費は不課税、減価償却費は現預金を動かさない
  taxableOverhead: Object.freeze(['6240', '6250', '6260', '6270', '6290']),
  depreciationCode: '6280',
  // 追加の借入（その月末に実行・架空）。制作費と委員会への出資の支払が続く時期に合わせる
  loanDrawdowns: Object.freeze([['2024-12', 150000000], ['2025-06', 150000000], ['2025-11', 100000000]]),
  interestRateBps: 108, // 支払利息は前月末の借入金×年1.08%÷12（期首の2億なら月18万円）
  interestYen: 180000,
});
// 月末の借入金（期首＋その月までに実行した借入）
export function loanBalanceAt(month) {
  return PLBS_DEMO.opening.loan + PLBS_DEMO.loanDrawdowns.filter(([m]) => m <= month).reduce((n, [, amount]) => n + amount, 0);
}
// その月の支払利息（前月末の借入金×年率÷12）
export const interestFor = (month) => Math.round(loanBalanceAt(addMonths(month, -1)) * PLBS_DEMO.interestRateBps / 10000 / 12);
// その月末の固定資産（期首の帳簿価額から、期首の翌月から毎月の減価償却費を引く）
export function fixedAssetsAt(month) {
  const depreciation = PLBS_DEMO.overhead.find(([code]) => code === PLBS_DEMO.depreciationCode)[1];
  let value = PLBS_DEMO.opening.fixedAssets;
  for (let m = addMonths(PLBS_DEMO.openingMonth, 1); m <= month; m = addMonths(m, 1)) value -= depreciation;
  return value;
}
export const overheadTax = (code, amount) => (PLBS_DEMO.taxableOverhead.includes(code) ? Math.trunc(amount / 10) : 0);

// 自社作品（委員会でない12本）の制作費。案件の予算から委員会作品の制作費を引いた残りを割り振った架空の額
export const PRODUCTION_COSTS = Object.freeze({
  'DEMO-W02': 30000000, 'DEMO-W05': 15000000, 'DEMO-W06': 25000000,
  'DEMO-W08': 25000000, 'DEMO-W09': 40000000, 'DEMO-W11': 25000000,
  'DEMO-W13': 35000000, 'DEMO-W14': 35000000, 'DEMO-W16': 35000000, 'DEMO-W17': 35000000,
  'DEMO-W19': 45000000, 'DEMO-W20': 45000000,
});
const PRODUCTION_SPLIT = [[-3, 3000], [-2, 4000], [-1, 3000]]; // 公開月の3か月前〜前月に 30%・40%・30%
const SPLIT_INVESTMENT = new Set(['DEMO-W04', 'DEMO-W18']); // 出資を2回に分けて払い込む委員会

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const endOf = (ym) => `${ym}-${pad(lastDay(ym))}`;
export const releaseOfCode = (code) => addMonths('2024-07', Number(code.slice(-2)) - 1); // DEMO-W01 が 2024-07、以後1か月ずつ（seed-sales-demo の作品と同じ）

export async function seedPlbsDemo(db, {log = () => {}} = {}) {
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  if (!org || !await db.get("SELECT 1 FROM works WHERE org_id=? AND code='DEMO-W01'", [org.id])) {
    throw new Error('先に scripts/seed-sales-demo.mjs で売上の架空データを入れてください');
  }
  const orgId = org.id;
  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  if (login.status !== 200) throw new Error(`架空の管理者でログインできません（${login.status}）`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`${method} ${path}: ${response.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
  const post = expenseDemoWriter(db,orgId,(path,payload)=>call('POST',path,payload));
  const get = (path) => call('GET', path);
  if ((await get('/session')).user.orgId !== orgId) throw new Error('架空の管理者が DEMO-SALES で入れていません');
  const count = async (sql, params = []) => Number((await db.get(sql, [orgId, ...params])).n);
  const done = {};

  const works = await db.all('SELECT id, code, title, project_id FROM works WHERE org_id=? ORDER BY code', [orgId]);
  const committeeWorkIds = new Set((await db.all('SELECT DISTINCT work_id FROM committee_contracts WHERE org_id=?', [orgId])).map((row) => row.work_id));
  const ownWorks = works.filter((work) => !committeeWorkIds.has(work.id));

  // 1. 会社の設定
  if (!await count('SELECT COUNT(*) AS n FROM org_profile_versions WHERE org_id=?')) {
    await call('PUT', '/settings/fiscal', {fiscalStartMonth: 5, confirmed: true});
    const self = await db.get('SELECT id FROM partners WHERE org_id=? AND code=?', [orgId, PLBS_DEMO.profile.selfPartnerCode]);
    if (!self) throw new Error('自社を表す取引先 DEMO-SELF がありません');
    await post('/pl-bs/profile-versions', {legalName: PLBS_DEMO.profile.legalName, postalCode: PLBS_DEMO.profile.postalCode, address: PLBS_DEMO.profile.address,
      capitalYen: PLBS_DEMO.profile.capitalYen, selfPartnerId: self.id, openingMonth: PLBS_DEMO.openingMonth, baseVersion: 0,
      reason: '架空データ（デモ）の会社の設定。法人番号・インボイス登録番号は実在の番号と重ならないよう空欄'});
    done.accounts = (await post('/pl-bs/accounts/defaults', {})).added;
    log(`会社の設定・勘定科目 ${done.accounts}件`);
  } else log('会社の設定は投入済み');

  // 2. 自社作品の制作費
  if (!await count("SELECT COUNT(*) AS n FROM expenses WHERE org_id=? AND category='制作費'")) {
    let n = 0;
    for (const work of ownWorks) {
      const total = PRODUCTION_COSTS[work.code];
      if (!total) continue;
      const release = releaseOfCode(work.code);
      const shares = PRODUCTION_SPLIT.map(([offset, bps]) => ({offset, amount: Math.round(total * bps / 10000)}));
      shares.at(-1).amount = total - shares.slice(0, -1).reduce((sum, row) => sum + row.amount, 0);
      for (const {offset, amount} of shares) {
        const month = addMonths(release, offset);
        const tax = Math.trunc(amount / 10);
        await post('/expenses', {project_id: work.project_id, work_id: work.id, incurred_on: `${month}-20`, accounting_month: month, category: '制作費',
          description: `撮影・編集などの制作費（${offset === -1 ? '仕上げ' : offset === -2 ? '撮影' : '準備'}・架空）`, budget_yen: null, actual_ex_tax: amount, tax_amount: tax, actual_inc_tax: amount + tax});
        n += 1;
      }
    }
    done.productionExpenses = n;
    log(`制作費 ${n}件`);
  } else log('制作費は投入済み');

  // 3. 経費の出金日
  if (!await count('SELECT COUNT(*) AS n FROM expense_payments WHERE org_id=?')) {
    const expenses = await db.all('SELECT id, work_id, accounting_month, category, actual_inc_tax FROM expenses WHERE org_id=? ORDER BY id', [orgId]);
    let paid = 0, unpaid = 0;
    const installments = expenses.find((row) => row.category === '制作費')?.id;
    const corrected = expenses.find((row) => row.category === 'P&A')?.id;
    for (const [index, expense] of expenses.entries()) {
      const due = endOf(addMonths(expense.accounting_month, 1));
      // 一部は未払のまま残す（事務費・海外素材費・宣伝費の一部と、基準日より後が期日のもの）
      const leaveUnpaid = ['事務費', '海外素材費', '宣伝費'].includes(expense.category) && index % 4 === 1;
      if (leaveUnpaid || due > PLBS_DEMO.asOf || expense.actual_inc_tax <= 0) { unpaid += 1; continue; }
      const method = expense.category === '事務費' ? 'cash' : 'transfer';
      if (expense.id === installments) {
        const first = Math.floor(expense.actual_inc_tax / 2);
        await post('/expense-payments', {expenseId: expense.id, paidOn: due, amountYen: first, method, note: '分割払い（1回目・架空）'});
        await post('/expense-payments', {expenseId: expense.id, paidOn: endOf(addMonths(expense.accounting_month, 2)), amountYen: expense.actual_inc_tax - first, method, note: '分割払い（2回目・架空）'});
        paid += 2;
        continue;
      }
      if (expense.id === corrected) {
        await post('/expense-payments', {expenseId: expense.id, paidOn: due, amountYen: expense.actual_inc_tax - 10000, method, note: '振込（架空）'});
        const wrong = (await get(`/expense-payments?workId=${expense.work_id}`)).rows.find((row) => row.id === expense.id).payments[0];
        await post(`/expense-payments/${wrong.id}/reverse`, {reversedOn: due, reason: '振込額を誤ったため取消（架空）'});
        paid += 2;
      }
      await post('/expense-payments', {expenseId: expense.id, paidOn: due, amountYen: expense.actual_inc_tax, method, note: '振込（架空）'});
      paid += 1;
    }
    done.expensePayments = paid;
    done.unpaidExpenses = unpaid;
    log(`経費の出金 ${paid}件（未払のまま ${unpaid}件）`);
  } else log('経費の出金は投入済み');

  // 4. 委員会への出資の払込
  if (!await count('SELECT COUNT(*) AS n FROM committee_investment_payments WHERE org_id=?')) {
    const self = await db.get('SELECT id FROM partners WHERE org_id=? AND code=?', [orgId, PLBS_DEMO.profile.selfPartnerCode]);
    let n = 0;
    for (const work of works.filter((row) => committeeWorkIds.has(row.id))) {
      const {rows} = await get(`/committee-investments?workId=${work.id}`);
      const mine = rows.find((row) => row.latest && row.partnerId === self.id);
      if (!mine) continue;
      const release = releaseOfCode(work.code);
      if (SPLIT_INVESTMENT.has(work.code)) {
        const first = Math.floor(mine.amountYen / 2);
        await post('/committee-investment-payments', {termVersionId: mine.termVersionId, partnerId: self.id, paidOn: endOf(addMonths(release, -3)), amountYen: first, method: 'transfer', note: '出資金の払込（1回目・架空）'});
        await post('/committee-investment-payments', {termVersionId: mine.termVersionId, partnerId: self.id, paidOn: endOf(addMonths(release, -1)), amountYen: mine.amountYen - first, method: 'transfer', note: '出資金の払込（2回目・架空）'});
        n += 2;
      } else {
        await post('/committee-investment-payments', {termVersionId: mine.termVersionId, partnerId: self.id, paidOn: endOf(addMonths(release, -2)), amountYen: mine.amountYen, method: 'transfer', note: '出資金の払込（架空）'});
        n += 1;
      }
    }
    done.investmentPayments = n;
    log(`出資の払込 ${n}件`);
  } else log('出資の払込は投入済み');

  // 5. 請求と入金（自社作品の売上だけ。委員会作品の売上は委員会の売上なので請求しない）
  if (!await count('SELECT COUNT(*) AS n FROM billing_invoices WHERE org_id=?')) {
    const partners = new Map((await db.all('SELECT id, code FROM partners WHERE org_id=?', [orgId])).map((row) => [row.id, row.code]));
    const invoices = [];
    for (const work of ownWorks) {
      const {candidates} = await get(`/billing?workId=${work.id}&asOf=${PLBS_DEMO.asOf}`);
      const eligible = candidates.filter((row) => row.eligible && row.accounting_month <= PLBS_DEMO.billingTo && row.workIds.every((id) => !committeeWorkIds.has(id)));
      const groups = new Map();
      for (const row of eligible) {
        const key = `${row.partner_id}|${row.accounting_month}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      for (const [key, rows] of groups) {
        const [partnerId, month] = key.split('|');
        for (let start = 0; start < rows.length; start += 10) {
          const chunk = rows.slice(start, start + 10);
          const invoiceDate = `${addMonths(month, 1)}-05`;
          const dueDate = endOf(addMonths(month, 2));
          const saved = await post('/billing/invoices', {workId: work.id, reportIds: chunk.map((row) => row.id), invoiceDate, dueDate, sourceAmountBasis: 'platform_net', note: `${month} 計上分の請求（架空）`});
          invoices.push({id: saved.invoiceId, partnerId: Number(partnerId), dueDate, amount: saved.amountIncTax});
        }
      }
    }
    // 入金: 取引先×入金日ごとに、請求を10件ずつまとめて消し込む
    const byPartnerDay = new Map();
    for (const invoice of invoices) {
      const key = `${invoice.partnerId}|${invoice.dueDate}`;
      if (!byPartnerDay.has(key)) byPartnerDay.set(key, []);
      byPartnerDay.get(key).push(invoice);
    }
    let receipts = 0;
    for (const [key, list] of byPartnerDay) {
      const [partnerId, receivedOn] = key.split('|');
      for (let start = 0, k = 1; start < list.length; start += 10, k += 1) {
        const chunk = list.slice(start, start + 10);
        await post('/billing/receipts', {partnerId: Number(partnerId), receivedOn, amountYen: chunk.reduce((n, row) => n + row.amount, 0),
          allocations: chunk.map((row) => ({invoiceId: row.id, amountYen: row.amount})), reference: `DEMO-RCV-${partners.get(Number(partnerId))}-${receivedOn}-${k}`, note: '振込入金（架空）'});
        receipts += 1;
      }
    }
    done.invoices = invoices.length;
    done.receipts = receipts;
    log(`請求 ${invoices.length}件・入金 ${receipts}件`);
  } else log('請求と入金は投入済み');

  // 6. 手入力の額（期首残高・全社費用・固定資産の月末残高・追加の借入・支払利息）
  if (!await count('SELECT COUNT(*) AS n FROM gl_manual_amounts WHERE org_id=?')) {
    const {opening} = PLBS_DEMO;
    const month = PLBS_DEMO.openingMonth;
    // 期首は現預金・固定資産・借入金・資本金のほかに残高が無いので、繰越利益剰余金は差額
    const retained = opening.cash + opening.fixedAssets - opening.loan - opening.capital;
    const entries = [
      {accountCode: '1100', month, amountYen: opening.cash, basis: '架空の期首残高（銀行残高・架空）', status: 'reviewed'},
      {accountCode: '1500', month, amountYen: opening.fixedAssets, basis: '架空の期首残高（撮影機材・事務所の内装の帳簿価額・架空）', status: 'reviewed'},
      {accountCode: '3100', month, amountYen: opening.capital, basis: '架空の期首残高（登記の資本金・架空）', status: 'reviewed'},
      {accountCode: '2500', month, amountYen: opening.loan, basis: '架空の期首残高（金銭消費貸借契約・架空）', status: 'reviewed'},
      {accountCode: '3200', month, amountYen: retained, basis: '架空（期首の貸借差で逆算: 現預金＋固定資産−借入金−資本金）', status: 'reviewed'},
    ];
    const months = [];
    for (let m = PLBS_DEMO.manualFrom; m <= PLBS_DEMO.manualTo; m = addMonths(m, 1)) months.push(m);
    months.forEach((m, k) => {
      for (const [code, base] of PLBS_DEMO.overhead) {
        const wobble = code === '6270' ? [0, 12000, -8000, 20000][k % 4] : code === '6250' ? [0, 3000, -2000][k % 3] : 0;
        const amount = base + wobble;
        const tax = overheadTax(code, amount);
        entries.push({accountCode: code, month: m, amountYen: amount, ...(tax ? {taxYen: tax} : {}),
          basis: `架空の全社費用（給与台帳・請求書の月額${tax ? '・税抜。消費税額は10%' : ''}・架空）`, status: 'reviewed'});
      }
      // 減価償却費に見合う固定資産の月末残高（現預金を動かさない科目どうしなので貸借が合う）
      entries.push({accountCode: '1500', month: m, amountYen: fixedAssetsAt(m), basis: '架空の固定資産の月末残高（固定資産台帳・減価償却後・架空）', status: 'reviewed'});
      entries.push({accountCode: '7500', month: m, amountYen: interestFor(m), basis: `架空の借入金の支払利息（前月末の借入金×年${PLBS_DEMO.interestRateBps / 100}%・架空）`, status: 'reviewed'});
    });
    for (const [m, amount] of PLBS_DEMO.loanDrawdowns) {
      entries.push({accountCode: '2500', month: m, amountYen: loanBalanceAt(m), basis: `架空の追加借入 ${amount.toLocaleString('ja-JP')}円を実行した後の月末残高（金銭消費貸借契約・架空）`, status: 'reviewed'});
    }
    for (let start = 0; start < entries.length; start += 150) await post('/pl-bs/manual', {entries: entries.slice(start, start + 150)});
    done.manualAmounts = entries.length;
    log(`手入力の額 ${entries.length}行`);
  } else log('手入力の額は投入済み');

  // 7. 委員会からの受取（目印: 委員会の期間報告の自社への支払の記録がある）… 保存済みの期間報告（DEMO-W01 の2件）の自社の分配を、報告の支払日に受け取る。
  //    ほかの委員会は期間報告が無いので受取の記録も無い（取得額は委員会からの未収に残る）
  const self = await db.get('SELECT id FROM partners WHERE org_id=? AND code=?', [orgId, PLBS_DEMO.profile.selfPartnerCode]);
  if (!await count('SELECT COUNT(*) AS n FROM rights_payment_events WHERE org_id=? AND committee_snapshot_id IS NOT NULL AND partner_id=?', [self.id])) {
    const snapshots = await db.all(`SELECT s.id, s.payment_on, (SELECT SUM(m.amount_yen) FROM committee_snapshot_member_amounts m WHERE m.org_id=s.org_id AND m.snapshot_id=s.id AND m.partner_id=?) AS amount
      FROM committee_report_snapshots s WHERE s.org_id=? ORDER BY s.id`, [self.id, orgId]);
    let n = 0;
    for (const snapshot of snapshots.filter((row) => Number(row.amount) > 0 && row.payment_on <= PLBS_DEMO.asOf)) {
      await post('/rights-reports/payments', {committeeSnapshotId: snapshot.id, partnerId: self.id, amountYen: Number(snapshot.amount), paidOn: snapshot.payment_on,
        reference: `DEMO-CMT-RCV-${snapshot.id}`, reason: '委員会の期間報告の自社への分配を受け取った（架空）'});
      n += 1;
    }
    done.committeeReceipts = n;
    log(`委員会からの受取 ${n}件`);
  } else log('委員会からの受取は投入済み');

  return {orgId, ...done,
    counts: {
      profiles: await count('SELECT COUNT(*) AS n FROM org_profile_versions WHERE org_id=?'), accounts: await count('SELECT COUNT(*) AS n FROM gl_accounts WHERE org_id=?'),
      expenses: await count('SELECT COUNT(*) AS n FROM expenses WHERE org_id=?'), expensePayments: await count('SELECT COUNT(*) AS n FROM expense_payments WHERE org_id=?'),
      investmentPayments: await count('SELECT COUNT(*) AS n FROM committee_investment_payments WHERE org_id=?'), invoices: await count('SELECT COUNT(*) AS n FROM billing_invoices WHERE org_id=?'),
      receipts: await count('SELECT COUNT(*) AS n FROM billing_receipts WHERE org_id=?'), manualAmounts: await count('SELECT COUNT(*) AS n FROM gl_manual_amounts WHERE org_id=?'),
    }};
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : null;
  };
  const target = option('--db');
  if (!target) {
    console.error('投入先のDBを --db で指定してください（例: --db C:/temp/demo-sales.sqlite）。既定のローカルDBへは書きません。');
    process.exit(2);
  }
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(target).toLowerCase() === resolve(mainDb).toLowerCase() && !process.argv.includes('--allow-main-db')) {
    console.error('data/integrated.sqlite への投入は --allow-main-db を付けたときだけ行います。');
    process.exit(2);
  }
  const db = new LocalDatabase(resolve(target));
  try {
    const started = Date.now();
    const result = await seedPlbsDemo(db, {log: (message) => console.log(`  ${message}`)});
    console.log(`投入しました（${((Date.now() - started) / 1000).toFixed(1)}秒）: ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}
