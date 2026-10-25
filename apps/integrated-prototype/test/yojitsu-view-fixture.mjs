// 案件収支の予実の架空の種（test/fixtures/yojitsu/seed.json）と、入金の確認の架空の請求・入金（test/fixtures/receipt-matching/。自動で一致した119件）を、
// 試験の DB の表に入れる部品（フェーズ1 #14 の予実の4段の試験。#11・#13 の golden の試験の入れ方と同じ形）。
// - 期間・目標の版・計画の版と採用の記録・設定の行（1件あたりの額・次の段へ進む率・着地確度）・稼ぎ方の既定の売上率・語を選ぶ設定（採用するシナリオなど）、
//   区分マスタ・案件（型・稼ぎ方・段階・売上率）・作品・予測の版・行動のステップの細目・活動記録は store（revenue-store・planning-store）で入れる
// - 制作受託の案件の率は受託の契約の版の受託費率（FR-REV-YOJITSU-044）なので、種の案件の売上率（Excel の案件の売上率）を受託費率にした契約の版を足す
//   （節目は始めた日の月に1つ。契約前の段階の案件にも足す。契約前の扱いは要件の要確認1）
// - 請求と入金（入金の確認の計画 #6 の前の形）は、報告・売上明細・請求・請求明細・作品の配賦・入金・消込の古い形の表へ試験の準備として SQL で入れる。
//   消込は入金の確認の正解表（answers.json）の自動で一致した入金だけ（確認が要る入金は承認するまで登録しない。yojitsu-actuals.json と同じ）
// 架空のデータだけを使う。目標・計画の額は種の fictional: true の架空額
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import * as planning from '../src/planning/planning-store.mjs';
import * as store from '../src/revenue/revenue-store.mjs';
import {normalizeProjectInput} from '../src/planning/project/project-model.mjs';
import {normalizeContractVersionInput} from '../src/planning/contract-production/contract-production-model.mjs';
import {normalizeChoiceInput, normalizeTargetInput} from '../src/revenue/yojitsu/yojitsu-model.mjs';
import {normalizeForecastVersionInput} from '../src/revenue/yojitsu/forecast-model.mjs';
import {normalizeActivityInput} from '../src/revenue/yojitsu/activity-model.mjs';

const read = (folder, name) => JSON.parse(readFileSync(new URL(`./fixtures/${folder}/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
export const yojitsuSeed = () => read('yojitsu', 'seed.json');
export const yojitsuGolden = () => read('yojitsu', 'expected.json');
export const SEED_OWNER = 'demo-admin@openingnight.invalid'; // 種の目標・計画の持ち主（行動指標の計画 A-4 の利用者。架空のアドレス）

// 種の語 → 表の語
export const STEP_CODE = Object.freeze({面談: 'meeting', 提案: 'proposal', 契約: 'contract'});
const PROJECT_TYPE = {製作: 'production', 買付: 'acquisition', 受託配給: 'agency', 受託制作: 'contract_production'};
const SCENARIO = {even: 'even', good: 'good', MAX: 'max', 単一: 'single'};
const MONTHLY_SCOPE = {企画中も含む: 'all', 着地: 'landing', 契約済み: 'contracted'};
const STATUS = {確認済み: 'confirmed', 監督申告: 'director_reported', 報道値: 'press_reported', 仮置き: 'provisional'};
const RESULT = {進んだ: 'advanced', 保留: 'on_hold', 失注: 'lost'};
const KIND = {本人: 'self', 会社: 'company'};
const SCOPE = {全体: 'all', 制作の取り分: 'production_share'};
const UNIT = {期間の合計: 'period_total', 毎月: 'monthly'};
const BASIS = {額: 'amount', '人件費×倍率': 'labor_cost_multiple'};
const CATEGORY_CODE = {流通売上: 'distribution_sales', 販売委託の売上: 'consignment_sales', 受託収益: 'contract_revenue', クラウドファンディングの支援金: 'crowdfunding_support',
  出資: 'investment', 買付: 'acquisition_payment', 制作の実費: 'production_cost', '作り手・権利元への分配': 'creator_share', クラウドファンディングの費用: 'crowdfunding_cost'};
const K17_SOURCE = '施策の既定の予測行（計画の K-17 の形）';
// 0.8 のような小数の率を、文字のまま bp に読む（浮動小数を掛けない）
export const ratioToBps = (ratio) => {
  const [whole, fraction = ''] = String(ratio).split('.');
  assert.ok(/^\d+$/.test(whole) && /^\d{0,4}$/.test(fraction), `率 ${ratio} は bp で表せない`);
  return Number(whole) * 10000 + Number(fraction.padEnd(4, '0'));
};
const monthEnd = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

// 種を組織1に入れる。返り値: 持ち主の利用者 ID、案件コード → ID、稼ぎ方の名前 → コード、作品コード → ID、入れた入金の件数。
// allInvoices: true なら、入金の無い請求（と売上明細）も全部入れる（会社への利益額の計上の売上は全部の請求明細の計上月から。フェーズ1 #14b）
export async function loadYojitsuSeed(db, {seed = yojitsuSeed(), allInvoices = false} = {}) {
  const owner = Number((await db.get("INSERT INTO users(email,display_name) VALUES(?, '架空デモ管理者') RETURNING id", [SEED_OWNER])).id);
  await db.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,?,'admin')", [owner]);
  const by = {createdBy: owner};

  // 期間・目標・計画と採用の記録（#11 の golden の試験と同じ入れ方）
  await store.definePeriods(db, 1, seed.設定.期間.map((p, i) => ({yearNo: i + 1, startsOn: p.始め})), by);
  const periodId = new Map((await store.listPeriods(db, 1)).map((p) => [`${p.yearNo}年目`, p.id]));
  for (const t of [...seed.目標].sort((a, b) => a.版 - b.版)) {
    assert.equal(t.fictional, true);
    const n = normalizeTargetInput({periodId: periodId.get(t.期間), previousVersionNo: t.版 - 1, kind: KIND[t.目標の種類], scope: SCOPE[t.稼ぎ方],
      unit: UNIT[t.単位], basisKind: BASIS[t.target_basis], amountYen: t['目標額（円）'], status: 'provisional', decidedOn: t.決めた日,
      decidedBy: t.決めた人, basis: t.根拠, ownerUserId: owner});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addTargetVersion(db, 1, n.value, by);
  }
  const earningTypes = await planning.listEarningTypes(db);
  const earningCode = new Map(earningTypes.map((e) => [e.label, e.code]));
  const made = new Set();
  for (const a of [...seed.plan_adoptions].sort((x, y) => x.adopted_on.localeCompare(y.adopted_on) || x.version_no - y.version_no)) {
    const key = `${a.period}|${a.version_no}`;
    if (made.has(key)) {
      await store.adoptPlanVersion(db, 1, {periodId: periodId.get(a.period), versionNo: a.version_no, adoptedOn: a.adopted_on}, by);
      continue;
    }
    const rows = seed.計画.filter((p) => p.期間 === a.period && p.版 === a.version_no);
    assert.ok(rows.length && rows.every((p) => p.fictional === true));
    await store.addPlanVersion(db, 1, {periodId: periodId.get(a.period), previousVersionNo: a.version_no - 1, ownerUserId: owner, status: 'provisional',
      basis: rows[0].根拠, createdOn: rows[0].作った日, adoptedOn: a.adopted_on,
      amounts: rows.map((p) => ({earningType: earningCode.get(p.稼ぎ方), amountYen: p['計画額（円・税別）']}))}, by);
    made.add(key);
  }

  // 設定の行（行動の1件あたりの額と2つの率・着地確度）、稼ぎ方の既定の売上率（制作受託は受託の契約の版の率で、ここには無い）、語を選ぶ設定
  for (const r of seed.行動) {
    const earningType = earningCode.get(r.稼ぎ方);
    const status = STATUS[r.状態];
    await store.addSettingVersion(db, 1, {variableKey: 'unit_amount', scope: 'earning_type', earningType, previousVersionNo: 0,
      value: {kind: 'yen', value: r['1件あたりの額（円・税別）']}, status, basis: r['1件あたりの中身']}, by);
    for (const [step, column] of [['meeting', '面談→提案の率'], ['proposal', '提案→契約の率']]) {
      await store.addSettingVersion(db, 1, {variableKey: 'conversion_rate', scope: 'earning_type_step', earningType, step, previousVersionNo: 0,
        value: {kind: 'bps', value: ratioToBps(r[column])}, status}, by);
    }
  }
  await store.addSettingVersion(db, 1, {variableKey: 'landing_probability', scope: 'all', previousVersionNo: 0,
    value: {kind: 'bps', value: ratioToBps(seed.設定.着地確度)}, status: 'provisional'}, by);
  for (const v of seed.vocabulary.earning_types) {
    const type = earningTypes.find((e) => e.label === v.name);
    if (type.rate_source !== 'project') continue;
    await planning.addRevenueRateVersion(db, 1, {earningType: type.code, revenueRateBps: v.default_sales_rate_bps, status: STATUS[v.rate_status], basis: v.rate_basis, createdBy: owner});
  }
  for (const [choiceKey, value] of [['adopted_scenario', SCENARIO[seed.設定.採用シナリオ]], ['monthly_scope', MONTHLY_SCOPE[seed.設定.月別の予測範囲]],
    ['closed_month', seed.設定.締めた月]]) {
    const n = normalizeChoiceInput({choiceKey, value, basis: '架空の種の設定'});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addChoiceVersion(db, 1, n.value, by);
  }

  // 区分マスタ・案件・受託の契約の版・作品
  const categories = [];
  for (const [i, k] of seed.vocabulary.kubun.entries()) {
    const direction = k.direction === '入金' ? 'in' : 'out';
    const id = await planning.addCashflowCategory(db, 1, {code: CATEGORY_CODE[k.name], label: k.name, direction, countsAsRevenue: k.sales_source === 'はい' ? 1 : 0, sortOrder: i + 1});
    categories.push({id, label: k.name, direction});
  }
  const categoryId = new Map(categories.map((c) => [c.label, c.id]));
  const stages = await planning.listProjectStages(db);
  const stageCode = new Map(stages.map((s) => [s.label, s.code]));
  const projectId = new Map();
  for (const p of seed.案件) {
    const earningType = earningCode.get(p.稼ぎ方);
    const type = earningTypes.find((e) => e.code === earningType);
    const n = normalizeProjectInput({code: p.案件コード, title: p.案件名, projectType: PROJECT_TYPE[p.project_type], earningType,
      baseAmountYen: p['基準額（円・税別）'], revenueRateBps: type.rate_source === 'project' ? p.rate_bps : null, startedOn: p.始めた日,
      stage: {code: stageCode.get(p.段階), enteredOn: p.始めた日, reason: p.段階 === '見送り' ? '架空の見送りの理由' : null}}, {earningTypes, stages});
    assert.equal(n.ok, true, `${p.案件コード}: ${JSON.stringify(n.errors)}`);
    const id = await planning.createProject(db, 1, n.value, by);
    projectId.set(p.案件コード, id);
    if (type.rate_source === 'contract' && p['基準額（円・税別）'] !== null) {
      const c = normalizeContractVersionInput({budgetYen: p['基準額（円・税別）'], markupBps: p.rate_bps, contractReference: '架空の受託の契約書',
        milestones: [{dueOn: `${p.始めた日.slice(0, 7)}-01`, shareBps: 10000}]});
      assert.equal(c.ok, true, `${p.案件コード}: ${JSON.stringify(c.errors)}`);
      await planning.addContractVersion(db, 1, id, c.value, by);
    }
  }
  const workId = new Map();
  for (const w of seed.works) {
    workId.set(w.work_code, Number((await db.get('INSERT INTO works(org_id,project_id,code,title) VALUES(1,?,?,?) RETURNING id', [projectId.get(w.project_code), w.work_code, w.title])).id));
  }

  // 予測（案件ごとに、種の版を作った日の順に 1, 2 … で足す。#13 の golden の試験と同じ）
  const byProject = new Map();
  for (const f of seed.予測) {
    if (!byProject.has(f.案件コード)) byProject.set(f.案件コード, new Map());
    const versions = byProject.get(f.案件コード);
    const key = `${f.作った日}|${f.版}`;
    if (!versions.has(key)) versions.set(key, []);
    versions.get(key).push(f);
  }
  for (const [code, versions] of byProject) {
    const ordered = [...versions].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [i, [, rows]] of ordered.entries()) {
      const n = normalizeForecastVersionInput({projectId: projectId.get(code), previousVersionNo: i, label: rows[0].版,
        sourceKind: rows[0].出所 === K17_SOURCE ? 'initiative' : 'manual', source: rows[0].出所, createdOn: rows[0].作った日,
        lines: rows.map((f) => ({scenario: SCENARIO[f.シナリオ], month: f.月, categoryId: categoryId.get(f.区分), item: f.項目, counterparty: f.相手,
          amountYen: f['金額（円・税別）'], status: STATUS[f.状態]}))}, {categories});
      assert.equal(n.ok, true, `${code}: ${JSON.stringify(n.errors.slice(0, 3))}`);
      await store.addForecastVersion(db, 1, n.value, by);
    }
  }

  // 行動のステップの細目と活動記録（#13 の golden の試験と同じ）
  const stepOf = new Map();
  let order = 100;
  for (const s of seed.vocabulary.activity_stages) {
    const key = `${s.stage}|${s.step}`;
    if (stepOf.has(key)) continue;
    if (s.stage === s.step) { stepOf.set(key, STEP_CODE[s.step]); continue; }
    order += 1;
    const code = `${STEP_CODE[s.step]}_${order}`;
    await planning.addActionStep(db, {code, label: s.stage, parentCode: STEP_CODE[s.step], sortOrder: order});
    stepOf.set(key, code);
  }
  const steps = await planning.listActionSteps(db);
  for (const a of seed.活動記録) {
    const step = a.ステップ === 'その他' ? null : stepOf.get(`${a.stage}|${a.ステップ}`);
    const n = normalizeActivityInput({projectId: projectId.get(a.案件コード), occurredOn: a.日付, earningType: a.稼ぎ方 === null ? null : earningCode.get(a.稼ぎ方), step,
      counterparty: a.相手, summary: a.したこと, deliverable: a.成果物, nextAction: a.次の一手, nextDueOn: a.期日, result: RESULT[a.result],
      workId: a.work_code === null ? null : workId.get(a.work_code)}, {steps, earningTypes});
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    await store.addActivityRecord(db, 1, n.value, by);
  }

  const receipts = await loadReceiptMatching(db, {owner, workId, projectOfWork: new Map(seed.works.map((w) => [w.work_code, projectId.get(w.project_code)])), allInvoices});
  return {owner, projectId, earningCode, workId, categoryId, receipts};
}

// 案件の有効な予測の版の行をそのまま写し、「予測に使う＝いいえ」の行（line）を1行足した次の版を足す（試験の境目の行）。
// 試算の取り込みは除外した流通の行を最新の版に useForForecast:false で入れる（src/revenue/yojitsu/trial-import-model.mjs）が、
// 種の「予測に使う＝いいえ」の行は前の版の行だけなので、最新の版に いいえ の行がある場面はこの部品で作る（FR-REV-YOJITSU-028）。返り値は足した版の番号
export async function addForecastVersionWithUnusedLine(db, {projectId, owner, line, createdOn = '2026-11-23'}) {
  const [current] = await store.readForecasts(db, 1, [projectId]);
  assert.ok(current?.effective, `案件 ${projectId} に有効な予測の版が無い`);
  const categories = await planning.listCashflowCategories(db, 1);
  const copied = current.lines.map(({scenario, month, categoryId, item, counterparty, amountYen, status, useForForecast}) =>
    ({scenario, month, categoryId, item, counterparty, amountYen, status, useForForecast}));
  const n = normalizeForecastVersionInput({projectId, previousVersionNo: current.versionNo, label: '架空の除外した行を足した版', sourceKind: 'manual',
    source: '架空の手入力', createdOn, lines: [...copied, {...line, useForForecast: false}]}, {categories});
  assert.equal(n.ok, true, JSON.stringify(n.errors.slice(0, 3)));
  return store.addForecastVersion(db, 1, n.value, {createdBy: owner});
}

// 入金の確認の架空の請求と、自動で一致した入金の消込を入れる（試験の準備。請求・入金の表はまだ古い形の表で、受け口を通すと請求の候補の判定まで要るので SQL で入れる）。
// 請求明細ごとに売上明細を1行（報告は請求×作品に1つ）、作品の配賦は 10000（商品なし）。入金の額は消込の額の和。
// 入れる請求は既定では消込のある請求だけ。allInvoices: true なら入金の無い請求も全部入れる
export async function loadReceiptMatching(db, {owner, workId, projectOfWork, orgId = 1, allInvoices = false}) {
  const invoicesDoc = read('receipt-matching', 'invoices.json');
  const receiptsDoc = read('receipt-matching', 'receipts.json');
  const answers = read('receipt-matching', 'answers.json').answers.filter((a) => a.outcome === '自動で一致');
  const partnerId = new Map();
  for (const p of invoicesDoc.partners) {
    partnerId.set(p.partner_code, Number((await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(?,?,?,'other') RETURNING id", [orgId, p.partner_code, p.name])).id));
  }
  const used = new Set(answers.flatMap((a) => a.allocations.map((x) => x.invoice_id)));
  const invoiceId = new Map();
  for (const v of invoicesDoc.invoices.filter((x) => allInvoices || used.has(x.invoice_id))) {
    const partner = partnerId.get(v.partner_code);
    const reports = new Map();
    const sales = [];
    for (const line of v.lines) {
      const work = workId.get(line.work_code);
      assert.ok(work, `請求 ${v.invoice_number} の作品 ${line.work_code} が種に無い`);
      if (!reports.has(line.work_code)) {
        reports.set(line.work_code, Number((await db.get(`INSERT INTO report_imports(org_id,work_id,partner_id,report_key,kind,period_from,period_to,accounting_month,raw_text,content_hash,created_by,status)
          VALUES(?,?,?,?,'digital',?,?,?,'架空の報告',?,?,'active') RETURNING id`, [orgId, work, partner, `${v.invoice_number}/${line.work_code}`, `${v.period}-01`, monthEnd(v.period),
          line.accounting_month, `fictional-${v.invoice_number}-${line.work_code}`, owner])).id));
      }
      const report = reports.get(line.work_code);
      const sale = Number((await db.get(`INSERT INTO sale_lines(org_id,project_id,work_id,report_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,
          amount_ex_tax,tax_amount,amount_inc_tax,source_row) VALUES(?,?,?,?,NULL,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [orgId, projectOfWork.get(line.work_code), work, report, partner, `${v.period}-01`, monthEnd(v.period), line.accounting_month, line.description,
        line.amount_ex_tax, line.tax_amount, line.amount_inc_tax, line.line_no])).id);
      sales.push({sale, report, work, line});
    }
    const id = Number((await db.get(`INSERT INTO billing_invoices(org_id,invoice_number,partner_id,invoice_date,due_date,source_amount_basis,amount_ex_tax,tax_amount,amount_inc_tax,
        snapshot_json,snapshot_hash,created_by) VALUES(?,?,?,?,?,'platform_net',?,?,?,'{}',?,?) RETURNING id`,
    [orgId, v.invoice_number, partner, v.invoice_date, v.due_date, v.amount_ex_tax, v.tax_amount, v.amount_inc_tax, `fictional-${v.invoice_number}`, owner])).id);
    invoiceId.set(v.invoice_id, id);
    await db.batch(sales.flatMap(({sale, report, work, line}) => [
      {sql: `INSERT INTO billing_invoice_lines(org_id,invoice_id,sale_id,report_id,project_id,work_id,product_id,partner_id,description,accounting_month,source_row,
          amount_ex_tax,tax_amount,amount_inc_tax) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
      params: [orgId, id, sale, report, projectOfWork.get(line.work_code), work, partner, line.description, line.accounting_month, line.line_no,
        line.amount_ex_tax, line.tax_amount, line.amount_inc_tax]},
      {sql: 'INSERT INTO billing_invoice_line_works(org_id,invoice_id,sale_id,work_id,allocation_bps) VALUES(?,?,?,?,10000)', params: [orgId, id, sale, work]},
    ]));
  }
  const receiptOf = new Map(receiptsDoc.receipts.map((r) => [r.receipt_id, r]));
  for (const a of answers) {
    const r = receiptOf.get(a.receipt_id);
    const amount = a.allocations.reduce((sum, x) => sum + x.amount_yen, 0);
    const id = Number((await db.get(`INSERT INTO billing_receipts(org_id,partner_id,reference,received_on,amount_yen,allocation_count,created_by)
      VALUES(?,?,?,?,?,?,?) RETURNING id`, [orgId, partnerId.get(a.partner_code), r.reference, r.received_on, amount, a.allocations.length, owner])).id);
    await db.batch(a.allocations.map((x) => ({sql: 'INSERT INTO billing_receipt_allocations(org_id,receipt_id,invoice_id,amount_yen) VALUES(?,?,?,?)',
      params: [orgId, id, invoiceId.get(x.invoice_id), x.amount_yen]})));
  }
  return {count: answers.length, partnerId, invoiceId};
}
