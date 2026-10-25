// 製作委員会の契約の型・条件版の式・日程の版・収支の台帳の DB の読み書き（移行 0042〜0044。要件 docs/requirements/settlement/committee.md）。
// どの表も追加だけで、変更・削除・連番の取り合い・取消の形は DB のトリガーが断る（受け口が 409 にする）。
// 読み取りは、計算の純関数（committee-formula-model.mjs・committee-schedule-model.mjs・committee-ledger-model.mjs）がそのまま受け取れる形で返す。
// 問い合わせはすべて org_id で絞る。
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';

// ---------- 契約の型 ----------

// 型の新しい版を足す（同じ code の最大の版＋1。前の版は消さない）。版の番号と前の版の ID は同じ文の中で導き、取り合いはトリガーが断る
export async function addTemplateVersion(db, {orgId, userId, code, name, body, reason}) {
  const bodyJson = JSON.stringify(body);
  await db.batch([
    {sql: `INSERT INTO committee_term_templates(org_id,code,version_no,previous_id,name,body_json,reason,created_by)
      SELECT ?,?,COALESCE(MAX(t.version_no),0)+1,
        (SELECT p.id FROM committee_term_templates p WHERE p.org_id=? AND p.code=? ORDER BY p.version_no DESC LIMIT 1),?,?,?,?
      FROM committee_term_templates t WHERE t.org_id=? AND t.code=?`,
    params: [orgId, code, orgId, code, name, bodyJson, reason, userId, orgId, code]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'committee_term_template', code, JSON.stringify({code})]},
  ]);
  return db.get('SELECT id,code,version_no,previous_id,name,body_json,reason,created_at FROM committee_term_templates WHERE org_id=? AND code=? ORDER BY version_no DESC LIMIT 1', [orgId, code]);
}

export async function readTemplates(db, orgId) {
  const rows = await db.all('SELECT id,code,version_no,previous_id,name,body_json,reason,created_by,created_at FROM committee_term_templates WHERE org_id=? ORDER BY code,version_no', [orgId]);
  return rows.map((r) => ({id: Number(r.id), code: r.code, versionNo: Number(r.version_no), previousId: r.previous_id == null ? null : Number(r.previous_id),
    name: r.name, body: JSON.parse(r.body_json), reason: r.reason, createdAt: r.created_at}));
}

// ---------- 条件版の式 ----------

// 条件版に式の部品をまとめて書く（1回の batch）。条件版そのもの（committee_term_versions）は既存の受け口が作る
export async function saveTermFormula(db, {orgId, userId, termVersionId, templateId = null, businesses = [], committeeSteps = [], budgetLines = []}) {
  const statements = [];
  if (templateId != null) statements.push({sql: 'INSERT INTO committee_term_version_templates(org_id,term_version_id,template_id,created_by) VALUES(?,?,?,?)', params: [orgId, termVersionId, templateId, userId]});
  businesses.forEach((b, i) => {
    statements.push({sql: 'INSERT INTO committee_term_businesses(org_id,term_version_id,business_code,display_order,operator_partner_id,clause_reference,created_by) VALUES(?,?,?,?,?,?,?)',
      params: [orgId, termVersionId, b.code, i + 1, b.operatorPartnerId, b.clauseReference ?? null, userId]});
    b.steps.forEach((s, j) => statements.push({sql: `INSERT INTO committee_term_business_steps(org_id,term_version_id,business_code,step_no,kind,expense_label,holder_role,deduct_expenses,fee_rate_bps,fee_base,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, termVersionId, b.code, j + 1, s.kind, s.kind === 'expense' ? s.label : null, s.kind === 'secondary_royalty' ? s.holderRole : null,
      s.kind === 'secondary_royalty' ? (s.deductExpenses ? 1 : 0) : null, s.kind === 'agent_fee' ? s.rateBps : null, s.kind === 'agent_fee' ? s.base : null, userId]}));
  });
  committeeSteps.forEach((s, i) => statements.push({sql: `INSERT INTO committee_term_committee_steps(org_id,term_version_id,step_no,kind,overhead_label,recipient_partner_id,rate_bps,fee_base,threshold_kind,success_mode,crossing_rule,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  params: [orgId, termVersionId, i + 1, s.kind, s.kind === 'overhead' ? s.label : null, s.kind === 'overhead' ? null : s.recipientPartnerId,
    s.kind === 'overhead' ? null : s.rateBps, s.kind === 'manager_fee' ? s.base : null, s.kind === 'success_fee' ? s.thresholdKind : null,
    s.kind === 'success_fee' ? s.mode : null, s.kind === 'success_fee' ? (s.crossingRule ?? null) : null, userId]}));
  budgetLines.forEach((l, i) => statements.push({sql: 'INSERT INTO committee_term_budget_lines(org_id,term_version_id,line_no,item,label,amount_yen,tax_basis,created_by) VALUES(?,?,?,?,?,?,?,?)',
    params: [orgId, termVersionId, i + 1, l.item, l.label ?? null, l.amountYen, l.taxBasis, userId]}));
  statements.push({sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'committee_term_formula', String(termVersionId),
    JSON.stringify({templateId, businesses: businesses.length, committeeSteps: committeeSteps.length, budgetLines: budgetLines.length})]});
  await db.batch(statements);
}

// 条件版の式を、計算の関数が受け取れる形で読む（事業の段は並べた順、委員会全体の段は並べた順）
export async function readTermFormula(db, orgId, termVersionId) {
  const [link, businesses, steps, committee, budget] = await Promise.all([
    db.get('SELECT template_id FROM committee_term_version_templates WHERE org_id=? AND term_version_id=?', [orgId, termVersionId]),
    db.all('SELECT business_code,display_order,operator_partner_id,clause_reference FROM committee_term_businesses WHERE org_id=? AND term_version_id=? ORDER BY display_order', [orgId, termVersionId]),
    db.all(`SELECT business_code,step_no,kind,expense_label,holder_role,deduct_expenses,fee_rate_bps,fee_base FROM committee_term_business_steps
      WHERE org_id=? AND term_version_id=? ORDER BY business_code,step_no`, [orgId, termVersionId]),
    db.all(`SELECT step_no,kind,overhead_label,recipient_partner_id,rate_bps,fee_base,threshold_kind,success_mode,crossing_rule FROM committee_term_committee_steps
      WHERE org_id=? AND term_version_id=? ORDER BY step_no`, [orgId, termVersionId]),
    db.all('SELECT line_no,item,label,amount_yen,tax_basis FROM committee_term_budget_lines WHERE org_id=? AND term_version_id=? ORDER BY line_no', [orgId, termVersionId]),
  ]);
  const step = (s) => s.kind === 'expense' ? {kind: 'expense', label: s.expense_label}
    : s.kind === 'secondary_royalty' ? {kind: 'secondary_royalty', holderRole: s.holder_role, deductExpenses: Number(s.deduct_expenses) === 1}
      : {kind: 'agent_fee', rateBps: Number(s.fee_rate_bps), base: s.fee_base};
  return {
    templateId: link ? Number(link.template_id) : null,
    businesses: businesses.map((b) => ({code: b.business_code, operatorPartnerId: Number(b.operator_partner_id), clauseReference: b.clause_reference,
      steps: steps.filter((s) => s.business_code === b.business_code).map(step)})),
    committeeSteps: committee.map((s) => s.kind === 'overhead' ? {kind: 'overhead', label: s.overhead_label}
      : s.kind === 'manager_fee' ? {kind: 'manager_fee', recipientPartnerId: Number(s.recipient_partner_id), rateBps: Number(s.rate_bps), base: s.fee_base}
        : {kind: 'success_fee', recipientPartnerId: Number(s.recipient_partner_id), rateBps: Number(s.rate_bps), thresholdKind: s.threshold_kind, mode: s.success_mode, crossingRule: s.crossing_rule}),
    budgetLines: budget.map((l) => ({item: l.item, label: l.label, amountYen: Number(l.amount_yen), taxBasis: l.tax_basis})),
  };
}

// ---------- 日程の版 ----------

const monthsToMask = (months) => Array.from({length: 12}, (_, i) => (months.includes(i + 1) ? '1' : '0')).join('');
const maskToMonths = (mask) => [...mask].flatMap((c, i) => (c === '1' ? [i + 1] : []));

export async function addScheduleVersion(db, {orgId, userId, contractId, effectiveFrom, baseKind, baseDate, reason, sourceReference = null, phases}) {
  const versionId = `(SELECT v.id FROM committee_schedule_versions v WHERE v.org_id=? AND v.contract_id=? AND v.version_no=(SELECT MAX(x.version_no) FROM committee_schedule_versions x WHERE x.org_id=? AND x.contract_id=?))`;
  await db.batch([
    {sql: `INSERT INTO committee_schedule_versions(org_id,contract_id,version_no,effective_from,base_kind,base_date,reason,source_reference,created_by)
      SELECT ?,?,COALESCE(MAX(v.version_no),0)+1,?,?,?,?,?,? FROM committee_schedule_versions v WHERE v.org_id=? AND v.contract_id=?`,
    params: [orgId, contractId, effectiveFrom, baseKind, baseDate, reason, sourceReference, userId, orgId, contractId]},
    ...phases.map((p, i) => ({sql: `INSERT INTO committee_schedule_version_phases(org_id,schedule_version_id,phase_no,tier,from_year,to_year,close_months,report_offset_months,pay_from,pay_offset_months,carry_under_yen,holiday_rule,created_by)
      VALUES(?,${versionId},?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, orgId, contractId, orgId, contractId, i + 1, p.tier, p.fromYear, p.toYear ?? null, monthsToMask(p.closeMonths), p.reportOffsetMonths, p.payFrom, p.payOffsetMonths,
      p.carryUnderYen ?? null, p.holidayRule, userId]})),
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'committee_schedule_version', String(contractId), JSON.stringify({effectiveFrom, phases: phases.length})]},
  ]);
}

export async function addRoundOverride(db, {orgId, userId, contractId, tier, closeOn, field, valueOn = null, reason, sourceReference = null}) {
  await db.batch([
    {sql: 'INSERT INTO committee_round_overrides(org_id,contract_id,tier,close_on,field,value_on,reason,source_reference,created_by) VALUES(?,?,?,?,?,?,?,?,?)',
      params: [orgId, contractId, tier, closeOn, field, valueOn, reason, sourceReference, userId]},
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'committee_round_override', String(contractId), JSON.stringify({tier, closeOn, field})]},
  ]);
}

// asOf の日に効いている日程の版（適用開始日が asOf 以前の版のうち最新）と、回だけの変更（同じ回×項目は後の行が効く）を、roundsFor の入力の形で返す
export async function readSchedule(db, orgId, contractId, asOf) {
  const version = await db.get(`SELECT id,version_no,effective_from,base_kind,base_date FROM committee_schedule_versions
    WHERE org_id=? AND contract_id=? AND effective_from<=? ORDER BY version_no DESC LIMIT 1`, [orgId, contractId, asOf]);
  if (!version) return null;
  const [phases, overrides] = await Promise.all([
    db.all(`SELECT phase_no,tier,from_year,to_year,close_months,report_offset_months,pay_from,pay_offset_months,carry_under_yen,holiday_rule
      FROM committee_schedule_version_phases WHERE org_id=? AND schedule_version_id=? ORDER BY phase_no`, [orgId, version.id]),
    db.all('SELECT id,tier,close_on,field,value_on,reason FROM committee_round_overrides WHERE org_id=? AND contract_id=? ORDER BY id', [orgId, contractId]),
  ]);
  const latest = new Map();
  for (const o of overrides) latest.set(`${o.tier}|${o.close_on}|${o.field}`, o);
  const field = {report_on: 'reportOn', pay_on: 'payOn', skip: 'skip'};
  return {
    versionNo: Number(version.version_no), effectiveFrom: version.effective_from, baseKind: version.base_kind, baseDate: version.base_date,
    phases: phases.map((p) => ({tier: p.tier, fromYear: Number(p.from_year), toYear: p.to_year == null ? null : Number(p.to_year), closeMonths: maskToMonths(p.close_months),
      reportOffsetMonths: Number(p.report_offset_months), payFrom: p.pay_from, payOffsetMonths: Number(p.pay_offset_months),
      carryUnderYen: p.carry_under_yen == null ? null : Number(p.carry_under_yen), holidayRule: p.holiday_rule})),
    overrides: [...latest.values()].map((o) => ({tier: o.tier, closeOn: o.close_on, field: field[o.field], value: o.value_on, reason: o.reason})),
  };
}

// ---------- 収支の台帳 ----------

// 1回分の行を足す（entriesFromRound の行）。同じ回に取り消していない行が残っていれば足さない（直すときは先に取り消す）
export async function appendLedgerRound(db, {orgId, userId, contractId, tier, closeOn, sourceKind, sourceReference = null, entries}) {
  const live = await db.get(`SELECT COUNT(*) AS n FROM committee_ledger_entries e WHERE e.org_id=? AND e.contract_id=? AND e.tier=? AND e.close_on=? AND e.reverses_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM committee_ledger_entries r WHERE r.org_id=e.org_id AND r.reverses_id=e.id)`, [orgId, contractId, tier, closeOn]);
  if (Number(live.n) > 0) throw Object.assign(new Error('この回の台帳の行はすでにあります。直すときは先に取り消してください'), {code: 'committee_round_exists'});
  for (const e of entries) if (e.tier !== tier || e.closeOn !== closeOn) throw new Error('台帳の行の段・締め日が回と一致しません');
  await db.batch([
    ...entries.map((e) => ({sql: `INSERT INTO committee_ledger_entries(org_id,contract_id,tier,close_on,business_code,section,item,counterparty_partner_id,holder_role,amount_yen,source_kind,source_reference,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, contractId, tier, closeOn, e.business ?? null, e.section, e.item ?? null, e.counterparty ?? null, e.holderRole ?? null, e.amountYen, sourceKind, sourceReference, userId]})),
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'committee_ledger_round', String(contractId), JSON.stringify({tier, closeOn, sourceKind, rows: entries.length})]},
  ]);
}

// 1回分の行をまとめて取り消す（各行に符号違いの行を足す）。理由は必須
export async function reverseLedgerRound(db, {orgId, userId, contractId, tier, closeOn, reason}) {
  if (!String(reason || '').trim()) throw new Error('取り消す理由を書いてください');
  const rows = await db.all(`SELECT e.id,e.business_code,e.section,e.item,e.counterparty_partner_id,e.holder_role,e.amount_yen,e.source_kind,e.source_reference FROM committee_ledger_entries e
    WHERE e.org_id=? AND e.contract_id=? AND e.tier=? AND e.close_on=? AND e.reverses_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM committee_ledger_entries r WHERE r.org_id=e.org_id AND r.reverses_id=e.id) ORDER BY e.id`, [orgId, contractId, tier, closeOn]);
  if (!rows.length) throw new Error('取り消す行がありません');
  await db.batch([
    ...rows.map((r) => ({sql: `INSERT INTO committee_ledger_entries(org_id,contract_id,tier,close_on,business_code,section,item,counterparty_partner_id,holder_role,amount_yen,source_kind,source_reference,reverses_id,reason,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params: [orgId, contractId, tier, closeOn, r.business_code, r.section, r.item, r.counterparty_partner_id, r.holder_role, -Number(r.amount_yen), r.source_kind, r.source_reference, r.id, reason, userId]})),
    {sql: AUDIT_INSERT, params: [orgId, userId, 'reverse', 'committee_ledger_round', String(contractId), JSON.stringify({tier, closeOn, rows: rows.length})]},
  ]);
  return rows.length;
}

// 台帳の行を、committee-ledger-model.mjs の statement・cumulativeBy が受け取る形で読む（取消の行も符号違いのまま含めるので、和は取り消した後の値になる）
export async function readLedger(db, orgId, contractId, tier) {
  const rows = await db.all(`SELECT id,tier,close_on,business_code,section,item,counterparty_partner_id,holder_role,amount_yen,source_kind,reverses_id FROM committee_ledger_entries
    WHERE org_id=? AND contract_id=? AND tier=? ORDER BY close_on,id`, [orgId, contractId, tier]);
  return rows.map((r) => ({id: Number(r.id), tier: r.tier, closeOn: r.close_on, business: r.business_code, section: r.section, item: r.item,
    counterparty: r.counterparty_partner_id == null ? null : Number(r.counterparty_partner_id), holderRole: r.holder_role, amountYen: Number(r.amount_yen),
    sourceKind: r.source_kind, reversesId: r.reverses_id == null ? null : Number(r.reverses_id)}));
}

// ---------- 受け口が読む契約・条件版・取引先 ----------

export async function readCommitteeContract(db, orgId, contractId) {
  const row = await db.get('SELECT id,work_id,contract_code,title FROM committee_contracts WHERE org_id=? AND id=?', [orgId, contractId]);
  return row ? {id: Number(row.id), workId: Number(row.work_id), code: row.contract_code, title: row.title} : null;
}

export async function readTermVersions(db, orgId, contractId) {
  return (await db.all('SELECT id,version_no FROM committee_term_versions WHERE org_id=? AND contract_id=? ORDER BY version_no', [orgId, contractId]))
    .map((v) => ({id: Number(v.id), versionNo: Number(v.version_no)}));
}

export async function termVersionOfContract(db, orgId, contractId, termVersionId) {
  return Boolean(await db.get('SELECT 1 FROM committee_term_versions WHERE org_id=? AND contract_id=? AND id=?', [orgId, contractId, termVersionId]));
}

// 出資金の総額 E: 条件版の出資の額の和。無ければ総事業費の内訳の和。どちらも無ければ null（未確認）
export async function readInvestmentTotal(db, orgId, termVersionId) {
  if (termVersionId == null) return null;
  const inv = await db.get('SELECT COUNT(*) AS n, COALESCE(SUM(amount_yen),0) AS s FROM committee_term_investments WHERE org_id=? AND term_version_id=?', [orgId, termVersionId]);
  if (Number(inv.n) > 0) return Number(inv.s);
  const lines = await db.get('SELECT COUNT(*) AS n, COALESCE(SUM(amount_yen),0) AS s FROM committee_term_budget_lines WHERE org_id=? AND term_version_id=?', [orgId, termVersionId]);
  return Number(lines.n) > 0 ? Number(lines.s) : null;
}

export async function readPartners(db, orgId) {
  return (await db.all('SELECT id,code,name FROM partners WHERE org_id=? ORDER BY id', [orgId])).map((p) => ({id: Number(p.id), code: p.code, name: p.name}));
}
