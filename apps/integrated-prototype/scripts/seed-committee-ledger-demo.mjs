// 製作委員会の契約の式と台帳（?p=committee-ledger）を画面で確かめるための架空の委員会を、verify で起動した使い捨ての DB と受け口に入れる。
//   node scripts/seed-committee-ledger-demo.mjs <使い捨ての DB ファイル> <起動中の URL（例 http://127.0.0.1:9141）>
// 契約・条件版・4社目の取引先は DB へ直接、型・式・日程・回だけの変更・届いた報告書2回分は受け口から入れる（受け口の検査を通す）。
// 数字は test/committee-ledger-model.test.mjs と同じ架空の値。架空のデータだけを使い、本番・staging には使わない。
import {DatabaseSync} from 'node:sqlite';
const [dbFile, base] = process.argv.slice(2);
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const one = (sql, ...p) => db.prepare(sql).get(...p);
const intake = one("INSERT INTO rights_intake_cases(org_id,project_id,work_id,case_code,title,intake_type,created_by) VALUES(1,1,1,'FIC-COMM-I','架空の委員会','committee',1) RETURNING id").id;
const doc = one("INSERT INTO rights_intake_documents(org_id,intake_case_id,title,reference) VALUES(1,?,'架空の委員会契約','FICT-DOC') RETURNING id", intake).id;
const contract = one("INSERT INTO committee_contracts(org_id,project_id,work_id,intake_case_id,document_id,contract_code,title,created_by) VALUES(1,1,1,?,?,'FIC-COMM','架空の委員会 星の港',1) RETURNING id", intake, doc).id;
const term = one("INSERT INTO committee_term_versions(org_id,contract_id,version_no,calculation_version,created_by) VALUES(1,?,1,'committee-v3-business-rights',1) RETURNING id", contract).id;
const M = one("INSERT INTO partners(org_id,code,name,kind) VALUES(1,'FIC-M','架空M社','other') RETURNING id").id;
db.close();
const login = await fetch(`${base}/api/local/login`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: 'admin@openingnight.invalid'})});
const cookie = login.headers.get('set-cookie').split(';')[0];
const post = async (path, payload) => {
  const r = await fetch(`${base}/api${path}`, {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(payload)});
  const b = await r.json();
  console.log(r.status, path, b.error ?? '');
  return b;
};
const p = {K: 1, L: 2, SELF: 3, M};
const tpl = await post('/committee/ledger/templates', {code: 'STD-JOINT', name: '標準の共同製作', body: {kind: 'joint'}, reason: '架空の種'});
await post(`/committee/ledger/contracts/${contract}/formula`, {termVersionId: term, templateId: tpl.template.id,
  businesses: [
    {code: 'theatrical', operatorPartnerId: p.K, clauseReference: '第9条', steps: [{kind: 'expense', label: '宣伝費'}, {kind: 'agent_fee', rateBps: 2000, base: 'income'}]},
    {code: 'home_video', operatorPartnerId: p.SELF, clauseReference: '第11条', steps: [{kind: 'expense', label: '必要経費'}, {kind: 'secondary_royalty', holderRole: 'original', deductExpenses: true}, {kind: 'secondary_royalty', holderRole: 'director', deductExpenses: false}, {kind: 'agent_fee', rateBps: 3000, base: 'remaining'}]},
    {code: 'internet', operatorPartnerId: p.K, clauseReference: '第13条', steps: [{kind: 'secondary_royalty', holderRole: 'original', deductExpenses: true}, {kind: 'agent_fee', rateBps: 2000, base: 'income'}]},
    {code: 'tv', operatorPartnerId: p.L, clauseReference: '第14条', steps: [{kind: 'secondary_royalty', holderRole: 'original', deductExpenses: true}, {kind: 'agent_fee', rateBps: 2000, base: 'income'}]}],
  committeeSteps: [{kind: 'overhead', label: '振込手数料'}, {kind: 'manager_fee', recipientPartnerId: p.K, rateBps: 500, base: 'remaining'}, {kind: 'success_fee', recipientPartnerId: p.K, rateBps: 1200, thresholdKind: 'total_budget', mode: 'excess'}],
  budgetLines: [{item: 'production', amountYen: 70000000, taxBasis: 'ex_tax'}, {item: 'pa', amountYen: 25000000, taxBasis: 'ex_tax'}, {item: 'contingency', amountYen: 5000000, taxBasis: 'ex_tax'}]});
await post(`/committee/ledger/contracts/${contract}/schedule-versions`, {effectiveFrom: '2031-01-01', baseKind: 'release', baseDate: '2031-05-01', reason: '架空の契約の別紙',
  phases: [
    {tier: 'to_members', fromYear: 1, toYear: 2, closeMonths: [2, 5, 8, 11], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, carryUnderYen: 10000, holidayRule: 'previous_business_day'},
    {tier: 'to_members', fromYear: 3, toYear: null, closeMonths: [8], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 1, carryUnderYen: 10000, holidayRule: 'previous_business_day'},
    {tier: 'to_manager', fromYear: 1, toYear: null, closeMonths: [3, 6, 9, 12], reportOffsetMonths: 2, payFrom: 'report', payOffsetMonths: 0, holidayRule: 'previous_business_day'}]});
await post(`/committee/ledger/contracts/${contract}/round-overrides`, {tier: 'to_members', closeOn: '2031-11-30', field: 'pay_on', valueOn: '2032-02-20', reason: '幹事の決算に合わせる（架空）'});
const rights = (a, b, c) => [{holderRole: 'original', amountYen: a}, {holderRole: 'director', amountYen: b}, {holderRole: 'screenplay', amountYen: c}];
const r1 = {businesses: [
  {business: 'theatrical', income: [{amountYen: 92500000}], expense: [{amountYen: 24000000, item: '宣伝費'}, {amountYen: -24000000, item: 'P&A出資金充当'}], agent_fee: [{amountYen: 18500000, counterparty: p.K}]},
  {business: 'home_video', income: [{amountYen: 10000000}], expense: [{amountYen: 2000000, item: '必要経費'}], secondary_royalty: rights(300000, 150000, 150000), agent_fee: [{amountYen: 2220000, counterparty: p.SELF}]},
  {business: 'internet', income: [{amountYen: 30000000}], secondary_royalty: rights(900000, 450000, 450000), agent_fee: [{amountYen: 6000000, counterparty: p.K}]},
  {business: 'tv', income: [{amountYen: 4000000}], secondary_royalty: rights(160000, 80000, 80000), agent_fee: [{amountYen: 800000, counterparty: p.L}]}],
  overhead: [{amountYen: 3000, item: '振込手数料'}], manager_fee: [{amountYen: 5212850, counterparty: p.K}], success_fee: [{amountYen: 0, counterparty: p.K}],
  member_distribution: [{counterparty: p.K, amountYen: 49522075}, {counterparty: p.L, amountYen: 24761037}, {counterparty: p.SELF, amountYen: 12380519}, {counterparty: p.M, amountYen: 12380519}]};
const r2 = {businesses: [
  {business: 'theatrical', income: [{amountYen: 200000}], agent_fee: [{amountYen: 40000, counterparty: p.K}]},
  {business: 'home_video', income: [{amountYen: 400000}], secondary_royalty: rights(15000, 6000, 6000), agent_fee: [{amountYen: 111900, counterparty: p.SELF}]},
  {business: 'internet', income: [{amountYen: 2000000}], secondary_royalty: rights(60000, 30000, 30000), agent_fee: [{amountYen: 400000, counterparty: p.K}]},
  {business: 'tv', income: [{amountYen: 1500000}], secondary_royalty: rights(60000, 30000, 30000), agent_fee: [{amountYen: 300000, counterparty: p.L}]}],
  overhead: [{amountYen: 1000, item: '振込手数料'}], manager_fee: [{amountYen: 149005, counterparty: p.K}], success_fee: [{amountYen: 225029, counterparty: p.K}],
  member_distribution: [{counterparty: p.K, amountYen: 1303033}, {counterparty: p.L, amountYen: 651517}, {counterparty: p.SELF, amountYen: 325758}, {counterparty: p.M, amountYen: 325758}]};
await post(`/committee/ledger/contracts/${contract}/rounds/received`, {tier: 'to_members', closeOn: '2031-08-31', report: r1});
await post(`/committee/ledger/contracts/${contract}/rounds/received`, {tier: 'to_members', closeOn: '2031-11-30', report: r2,
  reportedPrior: [{business: 'theatrical', section: 'agent_fee', priorYen: 18500000}, {business: null, section: 'manager_fee', priorYen: 5212850}]});
console.log('contract', contract);
