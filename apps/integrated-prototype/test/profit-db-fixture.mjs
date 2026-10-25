// 会社への利益額（K-16。フェーズ1 #14b）の受け口の試験の部品。架空の種（test/fixtures/yojitsu/seed.json）の経費・出資を DB に入れる部品と、
// golden（expected.json の「利益額」）を統合システムに記録の形がある分へ写した期待値を作る部品。loadYojitsuSeed のあとに呼ぶ。
// 入れるのは統合システムに記録の形がある分だけ: 経費（費目「制作費」「宣伝費」を費用区分の科目に対応させる。「配給費」は #24 の区分がまだ無いので対応させない）と
// 払った日の出金（税込どおり）、実績の制作の実費（制作受託の案件の制作費の経費）、製作委員会への自社と幹事の払込（会社の法人情報の自社の取引先・委員会契約・条件版の
// 出資額。幹事の払込は受け口が引かない分）、自社出資の稟議の版（行動指標の計画 段B #4。出資の記録ごとに申請・承認と、種の時点までの払込）。
// 買付の MG の支払・P&A の負担者・取引先の源泉の有無は記録の形が無いので入れない（受け口は「未接続」か「負担者 未登録」で返す）。
// 架空のデータだけを使う
import {SEED_ONLY_EXCLUDED} from './profit-fixture.mjs';
import {addInvestmentApprovalVersion} from '../src/planning/planning-store.mjs';

export const SELF_PARTNER_CODE = 'YJ-SELF';
const ACCOUNTS = [
  {kind: '制作費', code: '5300', name: '制作費（公開月に一括）', section: 'cogs', systemKey: 'production_cost', timing: 'release_month_once'},
  {kind: '宣伝費', code: '6100', name: '広告宣伝費（作品）', section: 'sga', systemKey: 'promotion', timing: 'incurred_month'},
];
const ym = (date) => String(date).slice(0, 7);

export async function loadProfitSeedCosts(db, {seeded, seed}) {
  const {owner, projectId, workId} = seeded;
  const by = [owner, '架空の種の会計の準備'];
  // 費用区分（勘定科目・科目の分類の版・費用区分と版・費目の別名）
  for (const a of ACCOUNTS) {
    const account = Number((await db.get(`INSERT INTO gl_accounts(org_id,code,name,section,source,system_key,cash_effect,sort_order,created_by)
      VALUES(1,?,?,?,'system',?,1,100,?) RETURNING id`, [a.code, a.name, a.section, a.systemKey, owner])).id);
    const cls = Number((await db.get(`INSERT INTO gl_account_class_versions(org_id,created_by,reason,account_id,version_no,active,normal_side,balance_class,settlement_role)
      VALUES(1,?,?,?,1,1,'debit','none',NULL) RETURNING id`, [...by, account])).id);
    const category = Number((await db.get('INSERT INTO expense_categories(org_id,created_by,reason,code) VALUES(1,?,?,?) RETURNING id', [...by, `YJ-${a.systemKey}`])).id);
    const version = Number((await db.get(`INSERT INTO expense_category_versions(org_id,created_by,reason,category_id,version_no,active,name,account_class_version_id,recognition_timing)
      VALUES(1,?,?,?,1,1,?,?,?) RETURNING id`, [...by, category, a.kind, cls, a.timing])).id);
    await db.run('INSERT INTO expense_category_alias_versions(org_id,created_by,reason,alias_text,version_no,category_version_id,active) VALUES(1,?,?,?,1,?,1)', [...by, a.kind, version]);
  }
  // 経費と出金（種の時点までに払った分）
  const addExpense = async ({project, work, category, month, description, exTax, tax, paidOn}) => {
    const id = Number((await db.get(`INSERT INTO expenses(org_id,project_id,work_id,partner_id,incurred_on,accounting_month,category,description,actual_ex_tax,tax_amount,actual_inc_tax)
      VALUES(1,?,?,NULL,?,?,?,?,?,?,?) RETURNING id`, [project, work, `${month}-01`, month, category, description, exTax, tax, exTax + tax])).id);
    if (paidOn && paidOn <= seed.as_of) {
      await db.run("INSERT INTO expense_payments(org_id,expense_id,paid_on,amount_yen,method,note,created_by) VALUES(1,?,?,?,'transfer','架空の出金',?)", [id, paidOn, exTax + tax, owner]);
    }
    return id;
  };
  const expenseIds = new Map();
  for (const x of seed.expenses) {
    expenseIds.set(x.expense_id, await addExpense({project: projectId.get(x.project_code), work: workId.get(x.work_code), category: x.category, month: ym(x.accounting_month),
      description: x.description, exTax: x.amount_ex_tax, tax: x.tax_amount, paidOn: x.paid_on}));
  }
  for (const r of seed.実績.filter((row) => row.区分 === '制作の実費')) {
    await addExpense({project: projectId.get(r.案件コード), work: null, category: '制作費', month: ym(r.日付), description: r.項目, exTax: r['金額（円・税別）'], tax: 0, paidOn: r.日付});
  }
  // 自社の取引先と会社の法人情報、製作委員会の契約・条件版・参加者（自社と幹事）・出資額・払込（種の時点まで）。
  // 幹事（YJ-LEAD）も自社の外の分（委員会の総額−自社の出資額）を自社の最初の払込の日に払い込む。受け口は自社の取引先の払込だけを引くので、
  // golden を写した期待値は変わらない（自社の絞りが外れると、幹事の払込が会社の費用に入って落ちる。FR-ACCT-PROFIT-004）
  const self = Number((await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(1,?,'自社（架空）','other') RETURNING id", [SELF_PARTNER_CODE])).id);
  const lead = Number((await db.get("INSERT INTO partners(org_id,code,name,kind) VALUES(1,'YJ-LEAD','幹事会社（架空）','other') RETURNING id")).id);
  await db.run("INSERT INTO org_profile_versions(org_id,version_no,legal_name,self_partner_id,reason,created_by) VALUES(1,1,'架空の会社',?,'架空の種の会計の準備',?)", [self, owner]);
  const workProject = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const committeeTerms = new Map();
  for (const [i, x] of seed.investments.filter((row) => row.kind === '製作委員会').entries()) {
    const project = projectId.get(workProject.get(x.work_code));
    const work = workId.get(x.work_code);
    const intake = Number((await db.get(`INSERT INTO rights_intake_cases(org_id,project_id,work_id,case_code,title,intake_type,created_by) VALUES(1,?,?,?,'架空の委員会の調達','committee',?) RETURNING id`,
      [project, work, `YJ-CASE-${i + 1}`, owner])).id);
    const doc = Number((await db.get("INSERT INTO rights_intake_documents(org_id,intake_case_id,title,reference,version_label) VALUES(1,?,'架空の委員会契約書','架空の参照','v1') RETURNING id", [intake])).id);
    const contract = Number((await db.get(`INSERT INTO committee_contracts(org_id,project_id,work_id,intake_case_id,document_id,contract_code,title,created_by)
      VALUES(1,?,?,?,?,?,'架空の製作委員会',?) RETURNING id`, [project, work, intake, doc, `YJ-CC-${i + 1}`, owner])).id);
    const term = Number((await db.get("INSERT INTO committee_term_versions(org_id,contract_id,version_no,calculation_version,created_by) VALUES(1,?,1,'fictional-v1',?) RETURNING id",
      [contract, owner])).id);
    await db.run("INSERT INTO committee_term_members(org_id,term_version_id,partner_id,role,share_bps,member_order) VALUES(1,?,?,'investor',?,1)", [term, self, x.own_ratio_bps]);
    await db.run("INSERT INTO committee_term_members(org_id,term_version_id,partner_id,role,share_bps,member_order) VALUES(1,?,?,'investor',?,2)", [term, lead, 10000 - x.own_ratio_bps]);
    await db.run('INSERT INTO committee_term_investments(org_id,term_version_id,partner_id,amount_yen) VALUES(1,?,?,?)', [term, self, x.own_yen]);
    await db.run('INSERT INTO committee_term_investments(org_id,term_version_id,partner_id,amount_yen) VALUES(1,?,?,?)', [term, lead, x.total_yen - x.own_yen]);
    const paid = x.payments.filter((row) => row.paid_on <= seed.as_of);
    for (const p of paid) {
      await db.run("INSERT INTO committee_investment_payments(org_id,term_version_id,partner_id,paid_on,amount_yen,method,note,created_by) VALUES(1,?,?,?,?,'transfer','架空の払込',?)",
        [term, self, p.paid_on, p.amount_yen, owner]);
    }
    if (paid.length) {
      await db.run("INSERT INTO committee_investment_payments(org_id,term_version_id,partner_id,paid_on,amount_yen,method,note,created_by) VALUES(1,?,?,?,?,'transfer','架空の幹事の払込',?)",
        [term, lead, paid[0].paid_on, x.total_yen - x.own_yen, owner]);
    }
    committeeTerms.set(x.work_code, {term, lead});
  }
  const approvals = await loadOwnInvestmentApprovals(db, {seeded, seed});
  return {selfPartnerId: self, expenseIds, committeeTerms, approvals};
}

// 種の自社出資の出資の記録（investments の kind が自社出資）ごとに、案件の稟議を1つ作る: 申請（自社の出資額・根拠の参照は出資の記録の ID）→ 承認 →
// 種の時点までの払込（払った日と額）。申請と承認は同じ利用者（J-10 (a)）。返り値は出資の記録の ID → {案件の ID・稟議の番号・最後の版の番号}
export async function loadOwnInvestmentApprovals(db, {seeded, seed}) {
  const {owner, projectId} = seeded;
  const projectOfWork = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const next = new Map();
  const out = new Map();
  for (const x of seed.investments.filter((row) => row.kind === '自社出資')) {
    const project = projectId.get(projectOfWork.get(x.work_code));
    const approvalNo = (next.get(project) ?? 0) + 1;
    next.set(project, approvalNo);
    let versionNo = 0;
    const add = (status, amountYen, extra = {}) => addInvestmentApprovalVersion(db, 1, project, {approvalNo, versionNo: ++versionNo, status, amountYen,
      basisReference: extra.basisReference ?? null, paidOn: extra.paidOn ?? null, note: null}, {createdBy: owner});
    await add('applied', x.own_yen, {basisReference: `架空の企画書と試算（${x.investment_id}）`});
    await add('approved', x.own_yen);
    for (const p of x.payments.filter((row) => row.paid_on <= seed.as_of)) await add('paid', p.amount_yen, {paidOn: p.paid_on});
    out.set(x.investment_id, {projectId: project, approvalNo, versionNo});
  }
  return out;
}

// 自社の払込（種の作品 workCode の委員会への最初の払込）を on の日に取り消す（負の額の取消の行）。取り消した額を返す
export async function reverseSelfCommitteePayment(db, {owner, costs, workCode, on}) {
  const {term} = costs.committeeTerms.get(workCode);
  const origin = await db.get('SELECT id,amount_yen FROM committee_investment_payments WHERE org_id=1 AND term_version_id=? AND partner_id=? AND reverses_id IS NULL ORDER BY id LIMIT 1',
    [term, costs.selfPartnerId]);
  await db.run("INSERT INTO committee_investment_payments(org_id,term_version_id,partner_id,paid_on,amount_yen,method,note,reverses_id,created_by) VALUES(1,?,?,?,?,'transfer','架空の払込の取消',?,?)",
    [term, costs.selfPartnerId, on, -Number(origin.amount_yen), Number(origin.id), owner]);
  return Number(origin.amount_yen);
}

// golden の明細（基準×月×案件×費目の税別の額）の費目を、統合システムが記録から決められる費目へ写す表。null は記録の形が無く受け口が
// 「未接続」で返す費目（明細から外す）
export const DB_ITEM_OF_GOLDEN = Object.freeze({
  '売上': '売上',
  '売上（源泉のある取引先）': '売上', // 取引先の源泉の有無の記録が無い
  '売上（作品の無い案件）': '売上（作品の無い案件）',
  '自社出資の出資額': '自社出資の出資額', // 稟議の払込の版（loadOwnInvestmentApprovals）
  '製作委員会の出資額（自社の分）': '製作委員会の出資額（自社の分）',
  '買付の MG': null, // MG の支払と決められる記録が無い（権利元への支払の記録は MG の前払いと分配を分けない。要件の要確認9）
  '買い切りの買付額': null,
  '宣伝費（負担者 自社）': '宣伝費（負担者 未登録）', // 負担者の記録（#24）が無い
  '宣伝費（負担者 自社以外）': '宣伝費（負担者 未登録）',
  '配給費（負担者 自社）': '費用区分の決まらない経費', // 配給費の費用区分（#24）が無い
  '配給費（負担者 自社以外）': '費用区分の決まらない経費',
  '費用区分「制作費」の経費': '費用区分「制作費」の経費',
  '制作の実費': '制作の実費',
  [SEED_ONLY_EXCLUDED]: null,
});

// 写した明細を golden.py と同じ決まりで足し直す（基準×月×案件×費目で税別の額を足してから売上率を1回だけ rateAmount〈truncate〉で掛ける。
// 月の軸は両方の基準で明細のある月）。写す先の状態・向き・額の中身は items（利益額の費目の表。golden の費目の表と同じことを
// profit-golden.test.mjs が確かめる）。mapping を省くと DB_ITEM_OF_GOLDEN。返り値は基準ごとに profit-fixture の goldenBasis と同じ形
export function goldenForDb(profit, {items, rateAmount, mapping = DB_ITEM_OF_GOLDEN}) {
  const byLabel = new Map(items.map((item) => [item.label, item]));
  const order = items.map((item) => item.label);
  const sums = new Map();
  for (const d of profit.明細) {
    if (!(d.費目 in mapping)) throw new Error(`DB への写し方を決めていない golden の費目: ${d.費目}`);
    const label = mapping[d.費目];
    if (label === null) continue;
    const key = `${d.基準}\u0000${d.月}\u0000${d.案件コード}\u0000${label}`;
    if (!sums.has(key)) sums.set(key, {basis: d.基準, month: d.月, code: d.案件コード, earning: d.稼ぎ方, label, exTax: 0, rateBps: d.売上率bps ?? null});
    sums.get(key).exTax += d.税別の額;
  }
  const rows = [...sums.values()].map((r) => {
    const item = byLabel.get(r.label);
    return {...r, item, amount: item.amountKind === 'rate_applied' ? rateAmount(r.exTax, r.rateBps) : r.exTax};
  });
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const at = new Map(months.map((m, i) => [m, i]));
  const zeros = () => months.map(() => 0);
  const sum = (list) => list.reduce((n, v) => n + v, 0);
  const out = {};
  for (const basis of ['accrual', 'cash']) {
    const mine = rows.filter((r) => r.basis === basis);
    const sales = zeros();
    const cost = zeros();
    for (const r of mine.filter((x) => x.item.status === 'settled')) (r.item.side === 'sales' ? sales : cost)[at.get(r.month)] += r.amount;
    const profitYen = sales.map((s, i) => s - cost[i]);
    const group = (status) => order.filter((label) => byLabel.get(label).status === status && mine.some((r) => r.label === label)).map((label) => {
      const amounts = zeros();
      for (const r of mine.filter((x) => x.label === label)) amounts[at.get(r.month)] += r.amount;
      return {費目: label, 額: amounts, 合計: sum(amounts)};
    });
    const projects = new Map();
    for (const r of mine.filter((x) => x.item.status === 'settled')) {
      if (!projects.has(r.code)) projects.set(r.code, {案件コード: r.code, 稼ぎ方: r.earning, 売上: 0, 経費: 0});
      projects.get(r.code)[r.item.side === 'sales' ? '売上' : '経費'] += r.amount;
    }
    out[basis] = {
      月: months,
      確定: {売上: sales, 経費: cost, 利益額: profitYen, 合計: {売上: sum(sales), 経費: sum(cost), 利益額: sum(profitYen)}},
      未確定: group('unsettled'),
      除外: group('excluded'),
      案件不明: {額: zeros(), 合計: 0},
      // golden（Python の sorted）と同じコードポイントの順
      案件別: [...projects.values()].sort((a, b) => (a.案件コード < b.案件コード ? -1 : a.案件コード > b.案件コード ? 1 : 0)).map((p) => ({...p, 利益額: p.売上 - p.経費})),
    };
  }
  return out;
}
