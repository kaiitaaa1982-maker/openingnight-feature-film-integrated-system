import {foreignKeyViolations} from './test-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, good} from './committee-independent-fixture.mjs';
import {loadCommitteeIncome} from '../src/committee/committee-income.mjs';

// 独立に書いた料率計算（|額|×bp÷10000 を切り捨て、符号を戻す）
const fee = (amount, bps) => Math.sign(amount) * Math.floor(Math.abs(amount) * bps / 10000);
const funding = {productionCostYen: 1_000_000, investments: [{partnerId: 1, amountYen: 600_000}, {partnerId: 2, amountYen: 400_000}]};
const DIGITAL = {kind: 'digital', label: '配信', windowPartnerId: 1, route: 'direct', platformRateBps: 1000, windowFeeBps: 1000, managerFeeBps: 500,
  feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'after_window'};
const PACKAGE = {kind: 'package', label: 'ビデオグラム', windowPartnerId: 2, route: 'via_manager', platformRateBps: 0, windowFeeBps: 2000, managerFeeBps: 0,
  feeOrder: 'manager_first', windowFeeBasis: 'after_manager', managerFeeBasis: 'platform_net'};
const PHASE = {label: '月次', startsOn: '2026-09-01', endsOn: '2027-08-31', firstCloseOn: '2026-09-30', intervalMonths: 1, closeDay: 'eom',
  reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', referenceType: 'release', referenceDate: '2026-09-01'};

async function setup({t}={}) {
  const f = await fixture({t});
  const cookies = {
    admin: await f.login('admin@openingnight.invalid'), editor: await f.login('editor@openingnight.invalid'),
    production: await f.login('production@openingnight.invalid'), outsider: await f.login('outsider@other.invalid'),
  };
  const get = async (path, who = 'admin') => {
    const response = await f.app.request('/api' + path, {headers: {cookie: cookies[who]}});
    return {status: response.status, data: await response.json()};
  };
  const post = async (path, body, who = 'admin') => {
    const response = await f.app.request('/api' + path, {method: 'POST', headers: {cookie: cookies[who], 'content-type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  };
  return {...f, get, post};
}

async function createContract(f) {
  return good(await f.req('/committee/contracts', {workId: 1, intakeCaseId: f.intakeCase.id, documentId: f.intakeCase.documents[0].id, contractCode: 'MONTHLY-C',
    title: '月次収支の試験用の委員会契約', managerPartnerId: 2, funding, windows: [DIGITAL, PACKAGE], phases: [PHASE]}));
}

const row = (body, key) => body.report.rows.find((item) => item.key === key);

test('委員会の月次収支API: 権限・入力・契約の有無を確かめ、独立に計算した額と一致し、照合がすべて0', async (t) => {
  const f = await setup({t});
  try {
    assert.equal((await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12', 'production')).status, 403);
    assert.equal((await f.get('/reports/committee-monthly/works', 'production')).status, 403);
    assert.deepEqual(good(await f.get('/reports/committee-monthly/works')).works, [], '委員会契約の無い作品は出さない');
    const none = await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12');
    assert.equal(none.status, 404);
    assert.match(none.data.error, /製作委員会の契約が登録されていません/);

    const contract = await createContract(f);
    const works = good(await f.get('/reports/committee-monthly/works')).works;
    assert.deepEqual(works.map((w) => [w.id, w.contractCount]), [[1, 1]]);
    assert.deepEqual(good(await f.get('/reports/committee-monthly/works', 'editor')).works.map((w) => w.id), [1]);
    assert.deepEqual(good(await f.get('/reports/committee-monthly/works', 'outsider')).works, [], '別の組織の作品は出さない');

    for (const [query, pattern, status] of [
      ['from=2026-09&to=2026-12', /作品を選んでください/, 400],
      ['workId=x&from=2026-09&to=2026-12', /読み取れません/, 400],
      ['workId=1&from=2026-9&to=2026-12', /2026-05/, 400],
      ['workId=1&from=2026-12&to=2026-09', /開始月が終了月より後/, 400],
      ['workId=1&from=2016-01&to=2026-12', /120か月以内/, 400],
      ['workId=1&from=2026-09&to=2026-12&contractId=abc', /委員会契約の指定/, 400],
      ['workId=1&from=2026-09&to=2026-12&contractId=99999', /この作品のものではありません/, 404],
    ]) {
      const result = await f.get(`/reports/committee-monthly?${query}`);
      assert.equal(result.status, status, query);
      assert.match(result.data.error, pattern, query);
    }
    assert.equal((await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12', 'outsider')).status, 403, '別の組織からは作品の財務権限なし');
    await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,1,'WRK-NOCOM','委員会のない作品')");
    assert.equal((await f.get('/reports/committee-monthly?workId=3&from=2026-09&to=2026-12')).status, 404);

    const auditBefore = (await f.db.get('SELECT COUNT(*) AS n FROM audit_log')).n;
    const body = good(await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12'));
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM audit_log')).n, auditBefore, '帳票を読むだけでは何も書かない');
    assert.equal(good(await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12', 'editor')).checksOk, true, '財務権限のある編集担当も見られる');
    assert.equal(body.contract.id, contract.contractId ?? body.contract.id);
    assert.equal(body.term.versionId, contract.versionId);
    assert.equal(body.term.managerPartnerId, 2);
    assert.deepEqual(body.term.members.map((m) => [m.partnerId, m.shareBps]), [[1, 6000], [2, 4000]]);
    assert.equal(body.checksOk, true, JSON.stringify(body.report.checks.filter((c) => c.value !== 0)));

    // 独立の計算: 配信 100,000（控除前）→ PF10% → 窓口10% → 幹事5%（窓口控除後）。ビデオグラム 80,000 → 幹事0% → 窓口20%（幹事控除後）
    const sales = await f.db.all("SELECT r.kind, s.accounting_month, s.amount_ex_tax FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=1 ORDER BY s.id");
    const digital = sales.find((s) => s.kind === 'digital'), video = sales.find((s) => s.kind === 'package');
    const d = {pf: fee(100_000, 1000)}; d.net = 100_000 - d.pf; d.wf = fee(d.net, 1000); d.mf = fee(d.net - d.wf, 500); d.income = d.net - d.wf - d.mf;
    const v = {mf: 0}; v.wf = fee(80_000 - v.mf, 2000); v.income = 80_000 - v.wf - v.mf;
    const at = (key, month) => row(body, key).values[`m:${month}`];
    assert.equal(at('sales:digital', digital.accounting_month), 100_000);
    assert.equal(at('sales:package', video.accounting_month), 80_000, '区分未確認のビデオグラムはビデオグラムの窓口');
    assert.equal(row(body, 'platformFee').values.period, d.pf);
    assert.equal(row(body, 'windowFee').values.period, d.wf + v.wf);
    assert.equal(row(body, 'managerFee').values.period, d.mf + v.mf);
    assert.equal(row(body, 'income').values.period, d.income + v.income);
    assert.equal(row(body, 'expense').values.period, 9000);
    assert.equal(row(body, 'expense:宣伝').values['m:2026-09'], 3000);
    assert.equal(row(body, 'royalty').values.period, 0);
    const pool = d.income + v.income - 9000;
    assert.equal(row(body, 'pool').values.period, pool);
    assert.equal(row(body, 'distribution').values.period, pool);
    assert.equal(row(body, 'dist:1').values.period + row(body, 'dist:2').values.period, pool);
    assert.equal(row(body, 'wfee:1').values.period, d.wf, '配信の窓口手数料は窓口の受取先（A）に100%');
    assert.equal(row(body, 'wfee:2').values.period, v.wf);
    assert.equal(row(body, 'mfee:2').values.period, d.mf, '幹事手数料は幹事（B）');
    assert.equal(row(body, 'inv:1').values.period, 600_000);
    const acquisition = row(body, 'acq:1').values.period;
    assert.equal(row(body, 'rate:1').values.cumulative, acquisition / 600_000);
    assert.equal(row(body, 'profit:1').values.cumulative, acquisition - 600_000);
    assert.equal(body.lines.length, 2);
    assert.ok(body.lines.every((line) => line.basisSource === 'default' && line.basisText === '控除前'), '基準が決まっていない報告は控除前として計算したと明示');
    assert.equal(body.report.holds.defaultBasisReports, 2);
    assert.equal(body.expenseLines.length, 2);
    assert.equal(body.incomeRows.length, 2);
    assert.equal(body.fiscal.fiscalStartMonth, 5);
    assert.ok(body.report.columns.some((column) => column.key === 'period'));
    assert.deepEqual(await foreignKeyViolations(f.db), []);
  } finally {
    f.db.close();
  }
});

test('窓口手数料の取り分: 1回だけ・合計100%・参加者のみ・理由必須。登録すると月次収支の取り分が変わり、変更と削除はできない', async (t) => {
  const f = await setup({t});
  try {
    await createContract(f);
    const body = good(await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12'));
    const digital = body.term.windows.find((w) => w.kind === 'digital');
    assert.equal(digital.feeSharesRegistered, false);
    const path = `/committee/windows/${digital.id}/fee-shares`;
    const state = good(await f.get(path));
    assert.equal(state.registered, false);
    assert.deepEqual(state.effective, [{partnerId: 1, name: state.effective[0].name, shareBps: 10000, default: true}]);
    assert.deepEqual(state.candidates.map((c) => c.partnerId), [1, 2]);
    assert.equal(state.window.isLatestVersion, true);

    assert.equal((await f.get(path, 'production')).status, 403);
    assert.equal((await f.post(path, {reason: 'x', shares: [{partnerId: 1, shareBps: 10000}]}, 'production')).status, 403);
    assert.equal((await f.get(path, 'outsider')).status, 404, '別の組織の窓口は見えない');
    assert.equal((await f.get('/committee/windows/abc/fee-shares')).status, 400);
    assert.equal((await f.get('/committee/windows/999999/fee-shares')).status, 404);
    const reason = '委員会契約 第8条（配信の窓口手数料は2社で折半）';
    for (const [input, pattern] of [
      [{reason, shares: [{partnerId: 1, shareBps: 5000}, {partnerId: 2, shareBps: 4000}]}, /合計を100%/],
      [{reason, shares: [{partnerId: 1, shareBps: 5000}, {partnerId: 3, shareBps: 5000}]}, /参加者から選んで/],
      [{reason, shares: [{partnerId: 1, shareBps: 5000}, {partnerId: 1, shareBps: 5000}]}, /重なって/],
      [{reason, shares: [{partnerId: 1, shareBps: 0}, {partnerId: 2, shareBps: 10000}]}, /0.01%〜100%/],
      [{reason: '  ', shares: [{partnerId: 1, shareBps: 5000}, {partnerId: 2, shareBps: 5000}]}, /理由/],
      [{reason, shares: []}, /1社以上/],
    ]) {
      const result = await f.post(path, input);
      assert.equal(result.status, 400, JSON.stringify(input));
      assert.match(result.data.error, pattern);
    }
    const bad = await f.app.request(`/api${path}`, {method: 'POST', headers: {cookie: await f.login('admin@openingnight.invalid'), 'content-type': 'application/json'}, body: '{'});
    assert.equal(bad.status, 400);
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM committee_term_window_fee_shares')).n, 0);

    const saved = await f.post(path, {reason, shares: [{partnerId: 2, shareBps: 5000}, {partnerId: 1, shareBps: '5000'}]});
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal(saved.data.registered, true);
    assert.deepEqual(saved.data.shares.map((s) => [s.partnerId, s.shareBps]), [[1, 5000], [2, 5000]]);
    assert.equal(saved.data.shares[0].reason, reason);
    const again = await f.post(path, {reason, shares: [{partnerId: 1, shareBps: 10000}]});
    assert.equal(again.status, 409);
    assert.match(again.data.error, /登録済み/);
    await assert.rejects(f.db.run('UPDATE committee_term_window_fee_shares SET share_bps=1'), /変更できません/);
    await assert.rejects(f.db.run('DELETE FROM committee_term_window_fee_shares'), /削除できません/);
    await assert.rejects(f.db.run(`INSERT INTO committee_term_window_fee_shares(org_id,window_id,partner_id,share_bps,reason,created_by) VALUES(1,${digital.id},3,1,'x',1)`), /100%以内/);
    const audit = await f.db.get("SELECT * FROM audit_log WHERE entity_type='committee_window_fee_shares'");
    assert.equal(audit.entity_id, String(digital.id));

    const after = good(await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12'));
    const d = {pf: fee(100_000, 1000)}; d.wf = fee(100_000 - d.pf, 1000);
    const v = {wf: fee(80_000, 2000)};
    assert.equal(row(after, 'wfee:1').values.period, d.wf / 2, '配信の窓口手数料を折半');
    assert.equal(row(after, 'wfee:2').values.period, d.wf / 2 + v.wf);
    assert.equal(after.term.windows.find((w) => w.id === digital.id).feeSharesRegistered, true);
    assert.equal(after.checksOk, true);
    const editorPath = `/committee/windows/${after.term.windows.find((w) => w.kind === 'package').id}/fee-shares`;
    assert.equal((await f.post(editorPath, {reason: '編集担当の登録', shares: [{partnerId: 2, shareBps: 10000}]}, 'editor')).status, 201, '作品の財務権限のある編集担当も登録できる');
  } finally {
    f.db.close();
  }
});

test('報告額の基準・流通の区分・保留: 期間報告で「控除後」にした報告はPF控除しない。海外は「その他」の窓口、窓口が無ければ保留', async (t) => {
  const f = await setup({t});
  try {
    const contract = await createContract(f);
    const digitalReport = f.reports.find((r) => r.kind === 'digital');
    const preview = good(await f.req('/committee/previews', {workId: 1, termVersionId: contract.versionId, periodIndex: 1, periodDateBasis: 'sales_period',
      reportLinks: [{reportId: digitalReport.id, reportBasis: 'net'}], expenseAllocations: [], deductions: []}));
    good(await f.req('/committee/snapshots', {token: preview.token}));
    const snapshotBefore = await f.db.get('SELECT id, calculation_json FROM committee_report_snapshots');

    const body = good(await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12'));
    const line = body.lines.find((item) => item.reportId === digitalReport.id);
    assert.equal(line.basis, 'net');
    assert.equal(line.basisSource, 'committee');
    assert.equal(line.basisSourceText, '委員会の期間報告で確定');
    assert.equal(row(body, 'platformFee').values.period, 0, '控除後の報告にはPF控除を掛けない');
    assert.equal(row(body, 'netReported').values.period, 100_000, '控除後で報告された売上として別に示す');
    assert.equal(body.report.holds.netReported, true);
    assert.equal(body.checksOk, true);
    assert.deepEqual(await f.db.get('SELECT id, calculation_json FROM committee_report_snapshots'), snapshotBefore, '保存済みの期間報告は変わらない');

    // 流通の分類を付ける: ビデオグラムはレンタル、配信は海外（北米）
    const saleIds = await f.db.all("SELECT s.id, r.kind FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=1");
    for (const sale of saleIds) {
      const [code, territory] = sale.kind === 'package' ? ['package_rental', null] : ['svod', '北米'];
      await f.db.run("INSERT INTO sale_distribution_versions(org_id,sale_id,version_no,distribution_code,territory,settlement_method,reason,created_by) VALUES(1,?,1,?,?,'unverified','試験の分類',1)", [sale.id, code, territory]);
    }
    const classified = good(await f.get('/reports/committee-monthly?workId=1&from=2026-09&to=2026-12'));
    assert.ok(row(classified, 'sales:rental'), 'レンタルの区分で出す');
    assert.equal(row(classified, 'sales:rental').values.period, 80_000);
    assert.equal(row(classified, 'windowFee').values.period, fee(80_000, 2000), 'レンタルはビデオグラムの窓口の料率');
    assert.equal(row(classified, 'sales:overseas').values.period, 100_000);
    assert.equal(row(classified, 'holdSales').values.period, 100_000, 'その他の窓口が無いので海外の売上は保留');
    assert.deepEqual(classified.report.holds.windowMissing.map((h) => [h.channelGroup, h.windowKind, h.periodSales]), [['overseas', 'other', 100_000]]);
    assert.equal(classified.incomeRows.find((r) => r.channelGroup === 'overseas').income, null, '算定できない収入は0円にしない');
    assert.equal(classified.lines.find((l) => l.channelGroup === 'overseas').holdText.includes('窓口'), true);
    assert.equal(classified.checksOk, true, JSON.stringify(classified.report.checks.filter((c) => c.value !== 0)));
    assert.equal(row(classified, 'income').values.period, 80_000 - fee(80_000, 2000));
  } finally {
    f.db.close();
  }
});

test('loadCommitteeIncome: 委員会契約のある作品だけ・組織で絞る・財務権限で絞る。ロイヤリティが使う形で返す', async (t) => {
  const f = await setup({t});
  try {
    await createContract(f);
    const admin = {org_id: 1, user_id: 1, role: 'admin'};
    const all = await loadCommitteeIncome(f.db, admin, {workIds: [1, 2, 3], from: '2026-01', to: '2027-12'});
    assert.deepEqual([...all.terms.keys()], [1]);
    assert.equal(all.rows.length, 2);
    for (const item of all.rows) {
      for (const key of ['workId', 'month', 'channelGroup', 'windowKind', 'sales', 'platformFee', 'windowFee', 'managerFee', 'income']) assert.ok(key in item, key);
      assert.equal(item.income, item.sales - item.platformFee - item.windowFee - item.managerFee);
    }
    assert.deepEqual(all.expenses.map((e) => [e.workId, e.month, e.category, e.amount]).sort((a, b) => a[3] - b[3]), [[1, '2026-09', '宣伝', 3000], [1, '2026-09', '製造', 6000]]);
    const narrow = await loadCommitteeIncome(f.db, admin, {workIds: [1], from: '2030-01', to: '2030-12'});
    assert.equal(narrow.rows.length, 0, '期間外の売上は返さない');
    const denied = await loadCommitteeIncome(f.db, admin, {workIds: [1]}, {settlementWork: async () => null});
    assert.equal(denied.rows.length, 0);
    const other = await loadCommitteeIncome(f.db, {org_id: 2, user_id: 4, role: 'admin'}, {workIds: [1]});
    assert.equal(other.rows.length, 0, '別の組織からは読めない');
    await assert.rejects(loadCommitteeIncome(f.db, {}, {workIds: [1]}), /組織/);
  } finally {
    f.db.close();
  }
});
