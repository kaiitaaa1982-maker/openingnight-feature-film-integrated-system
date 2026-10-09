// 製作委員会の月次収支・条件版まわりのレビュー指摘（2026-09-25）の再発防止の試験。
// F1 条件版の適用開始月（将来の月だけを変える・確定済みのロイヤリティ報告書にかかる変更は確認を取る）
// F2 新しい条件版への窓口手数料の取り分の引き継ぎ
// F3 地域の表記ゆれ（日本国内・全国・JPN・ＪＰ など）を国内として扱う
// F4 作品で絞って売上明細を読み、1回の要求の中で本委員会収入とロイヤリティの発生額が同じ読み出しを分け合う（Worker の D1）
// F6 月次収支は最後の委員会契約だけで集計する（権利処理費の基礎と同じ契約）
// F7 権利処理費の保留は対象売上で持ち、注意は期間内の件数で、含めた額と含めていない額を分けて書く
// F8 ロイヤリティ契約の無い作品は、権利処理費を計上していないことを帳票に書く
// F9 出資額0円の回収率は「未確認」ではなく「—」
// F5 条件を変えて読み込み中の間は、前の作品・期間の応答を表示・出力に使わない
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, good} from './committee-independent-fixture.mjs';
import {createApp} from '../src/app.mjs';
import {channelGroupOf} from '../src/sales/channel-group.mjs';
import {accrueAgreement} from '../src/royalty/royalty-model.mjs';
import {buildCommitteeMonthly} from '../src/committee/committee-monthly-model.mjs';
import {INVESTOR_COLUMNS, committeeMonthlySheets} from '../src/committee/committee-monthly-view.mjs';
import {cellText} from '../src/ui/format.mjs';

// 独立に書いた料率計算（|額|×bp÷10000 を切り捨て、符号を戻す）
const fee = (amount, bps) => Math.sign(amount) * Math.floor(Math.abs(amount) * bps / 10000);
const funding = {productionCostYen: 1_000_000, investments: [{partnerId: 1, amountYen: 600_000}, {partnerId: 2, amountYen: 400_000}]};
const DIGITAL = {kind: 'digital', label: '配信', windowPartnerId: 1, route: 'direct', platformRateBps: 1000, windowFeeBps: 1000, managerFeeBps: 500,
  feeOrder: 'window_first', windowFeeBasis: 'platform_net', managerFeeBasis: 'after_window'};
const PACKAGE = {kind: 'package', label: 'ビデオグラム', windowPartnerId: 2, route: 'via_manager', platformRateBps: 0, windowFeeBps: 2000, managerFeeBps: 0,
  feeOrder: 'manager_first', windowFeeBasis: 'after_manager', managerFeeBasis: 'platform_net'};
const PHASE = {label: '月次', startsOn: '2026-09-01', endsOn: '2027-08-31', firstCloseOn: '2026-09-30', intervalMonths: 1, closeDay: 'eom',
  reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom'};
const MONTHLY_CYCLE = {phases: [{startsMonth: '2025-01', cycleKind: 'monthly', reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom'}]};

const terms = (overrides = {}) => ({managerPartnerId: 2, funding, windows: [DIGITAL, PACKAGE], phases: [{...PHASE, referenceType: 'release', referenceDate: '2026-09-01'}], ...overrides});
const contractInput = (f, code = 'REVIEW-C1') => ({workId: 1, intakeCaseId: f.intakeCase.id, documentId: f.intakeCase.documents[0].id, contractCode: code,
  title: 'レビュー指摘の試験用の委員会契約', ...terms()});
const monthly = async (f, query) => good(await f.req(`/reports/committee-monthly?${query}`));
const row = (body, key) => body.report.rows.find((item) => item.key === key);
const monthValue = (body, key, month) => row(body, key)?.values[`m:${month}`];
// 単月の売上（販売月基準）。計上月 = month
const saleIn = (f, key, kind, amount, month) => f.sale(key, kind, amount, {recognition_basis_id: 1, sales_month: month, period_from: `${month}-01`,
  period_to: `${month}-28`, report_received_on: undefined, basis_reason: '架空の販売月'});

async function royaltyAgreement(f, {holder = 10, code = 'REVIEW-DIR', category = 'director'} = {}) {
  await f.db.run("INSERT INTO partners(id,org_id,code,name,kind) VALUES(10,1,'PT-REV-DIR','架空監督R','other') ON CONFLICT DO NOTHING");
  return good(await f.req('/royalty/agreements', {workId: 1, holderPartnerId: holder, category, agreementCode: code, title: '架空の監督料（本委員会収入の10%）',
    documentReference: '架空の契約書 第1版', term: {effectiveFrom: '2025-01', calcMethod: 'rate', baseKind: 'committee_income', rateBps: 1000, clauseReference: '第4条'},
    schedule: MONTHLY_CYCLE}));
}

test('F1: 適用開始月のある新しい条件版は、その月から後だけを変える。確定済みの報告書は変わらず「報告後の修正」も出ない', async (t) => {
  const f = await fixture({t});
  try {
    const contract = good(await f.req('/committee/contracts', contractInput(f)));
    await royaltyAgreement(f);
    await saleIn(f, 'REV-D-2502', 'digital', 100_000, '2025-02');
    await saleIn(f, 'REV-D-2506', 'digital', 100_000, '2025-06');
    good(await f.req('/royalty/statements/generate', {asOf: '2025-04-10', confirmed: true}));
    const before = await monthly(f, 'workId=1&from=2025-01&to=2025-06');
    const v1Income = 100_000 - fee(100_000, 1000) - fee(90_000, 1000) - fee(90_000 - fee(90_000, 1000), 500);
    assert.equal(monthValue(before, 'income', '2025-02'), v1Income);

    // 2025年5月から配信の窓口手数料を10%→20%に変える
    const saved = good(await f.req(`/committee/contracts/${contract.contractId}/versions`, {sourceVersionId: contract.versionId, effectiveFrom: '2025-05',
      ...terms({windows: [{...DIGITAL, windowFeeBps: 2000}, PACKAGE]}), note: '2025年5月から配信の窓口手数料を変更'}));
    const after = await monthly(f, 'workId=1&from=2025-01&to=2025-06');
    assert.equal(monthValue(after, 'income', '2025-02'), v1Income, '適用開始月より前の月は前の版のまま');
    const v2Fee = fee(90_000, 2000);
    assert.equal(monthValue(after, 'income', '2025-06'), 90_000 - v2Fee - fee(90_000 - v2Fee, 500), '適用開始月から後は新しい版の料率');
    assert.deepEqual(after.versions.map((version) => [version.versionNo, version.effectiveFrom]), [[1, null], [2, '2025-05']]);
    assert.equal(after.versions[0].lastMonth, '2025-04');
    assert.equal(after.versions[1].firstMonth, '2025-05');
    assert.equal(after.checksOk, true, JSON.stringify(after.report.checks.filter((check) => check.value !== 0)));
    const preview = good(await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-04&asOf=2025-05-10'));
    assert.deepEqual(preview.statement.lines.filter((line) => line.lineKind === 'revision'), [], '確定済みの計上月に「報告後の修正」を出さない');
    assert.equal(saved.effectiveFrom, '2025-05');
    const saved2 = await f.db.get('SELECT effective_from FROM committee_term_version_effective WHERE term_version_id=?', [saved.versionId]);
    assert.equal(saved2.effective_from, '2025-05');
    await assert.rejects(f.db.run('UPDATE committee_term_version_effective SET effective_from=\'2025-01\''), /変更できません/);
    await assert.rejects(f.db.run('DELETE FROM committee_term_version_effective'), /削除できません/);
  } finally {
    f.db.close();
  }
});

test('FR-SETL-STMT-032 F1: 確定済みのロイヤリティ報告書の計上月を変える版（適用開始月なし・締めた月から）は、影響する報告書を示して409。確認を付ければ登録し、差額は次の報告書に出る', async (t) => {
  const f = await fixture({t});
  try {
    const contract = good(await f.req('/committee/contracts', contractInput(f)));
    await royaltyAgreement(f);
    await saleIn(f, 'REV-D-2502', 'digital', 100_000, '2025-02');
    good(await f.req('/royalty/statements/generate', {asOf: '2025-04-10', confirmed: true}));
    const input = {sourceVersionId: contract.versionId, ...terms({windows: [{...DIGITAL, windowFeeBps: 2000}, PACKAGE]})};
    const path = `/committee/contracts/${contract.contractId}/versions`;
    for (const effectiveFrom of [undefined, '2025-02']) {
      const refused = await f.req(path, {...input, effectiveFrom});
      assert.equal(refused.status, 409, JSON.stringify(refused.data));
      assert.equal(refused.data.details.code, 'retroactive');
      assert.deepEqual(refused.data.details.affectedStatements.map((row) => [row.holderName, row.closeMonth, row.firstMonth]), [['架空監督R', '2025-02', '2025-02']]);
      assert.match(refused.data.error, /報告後の修正/);
    }
    assert.equal((await f.db.get('SELECT COUNT(*) AS n FROM committee_term_versions')).n, 1, '確認が無ければ版を作らない');
    assert.equal((await f.req(path, {...input, effectiveFrom: '2025-13'})).status, 400);
    const second = await f.req('/committee/contracts', {...contractInput(f, 'REVIEW-C2')});
    assert.equal(second.status, 409, '作品の新しい委員会契約もすべての月を変えるので確認を取る');
    assert.equal((await f.req('/committee/contracts', {...contractInput(f, 'REVIEW-C3'), effectiveFrom: '2025-05'})).status, 400, '版1に適用開始月は付けられない');

    good(await f.req(path, {...input, confirmRetroactive: true}));
    const preview = good(await f.req('/royalty/statements/preview?holderId=10&closeMonth=2025-04&asOf=2025-05-10'));
    const revision = preview.statement.lines.filter((line) => line.lineKind === 'revision');
    const oldIncome = 90_000 - fee(90_000, 1000) - fee(90_000 - fee(90_000, 1000), 500);
    const newIncome = 90_000 - fee(90_000, 2000) - fee(90_000 - fee(90_000, 2000), 500);
    assert.deepEqual(revision.map((line) => [line.accrualMonth, line.amountYen]), [['2025-02', fee(newIncome, 1000) - fee(oldIncome, 1000)]], '確認して登録した訂正は次の報告書に差額で出る');
    const audit = await f.db.get("SELECT detail_json FROM audit_log WHERE entity_type='committee_term_version' ORDER BY id DESC LIMIT 1");
    assert.equal(JSON.parse(audit.detail_json).retroactiveConfirmed.length, 1, '確認して登録したことを監査記録に残す');
  } finally {
    f.db.close();
  }
});

test('F2: 新しい条件版は、コピー元の同じ種類の窓口の取り分を引き継ぐ（受取先が同じとき）。引き継がないときは理由を返し、月次収支で知らせる', async (t) => {
  const f = await fixture({t});
  try {
    const contract = good(await f.req('/committee/contracts', contractInput(f)));
    const first = await monthly(f, 'workId=1&from=2026-09&to=2026-12');
    const digital = first.term.windows.find((window) => window.kind === 'digital');
    good(await f.req(`/committee/windows/${digital.id}/fee-shares`, {reason: '委員会契約 第8条（配信の窓口手数料は2社で折半）', shares: [{partnerId: 1, shareBps: 5000}, {partnerId: 2, shareBps: 5000}]}));
    const split = await monthly(f, 'workId=1&from=2026-09&to=2026-12');
    const wfee = (body) => [row(body, 'wfee:1').values.cumulative, row(body, 'wfee:2').values.cumulative];

    const v2 = good(await f.req(`/committee/contracts/${contract.contractId}/versions`, {sourceVersionId: contract.versionId, ...terms(), note: 'メモの変更'}));
    const afterV2 = await monthly(f, 'workId=1&from=2026-09&to=2026-12');
    const digitalV2 = afterV2.term.windows.find((window) => window.kind === 'digital');
    assert.equal(afterV2.term.versionNo, 2);
    assert.equal(digitalV2.feeSharesRegistered, true, '取り分を引き継ぐ');
    assert.deepEqual(digitalV2.feeShares.map((share) => [share.partnerId, share.shareBps]), [[1, 5000], [2, 5000]]);
    assert.deepEqual(wfee(afterV2), wfee(split), '版を足しても出資者の窓口手数料の取り分は変わらない');
    assert.deepEqual(v2.feeShares.copied.map((row) => [row.kind, row.fromVersionNo]), [['digital', 1]]);
    const copied = await f.db.all('SELECT reason FROM committee_term_window_fee_shares WHERE window_id=?', [digitalV2.id]);
    assert.ok(copied.every((share) => share.reason.startsWith('条件版1から引き継ぎ: 委員会契約 第8条')));

    // 取り分を変えるために引き継がない版・窓口の受取先を変えた版
    const v3 = good(await f.req(`/committee/contracts/${contract.contractId}/versions`, {sourceVersionId: v2.versionId, effectiveFrom: '2027-01', copyFeeShares: false, ...terms()}));
    assert.match(v3.feeShares.skipped[0].reason, /引き継がない/);
    const v4 = good(await f.req(`/committee/contracts/${contract.contractId}/versions`, {sourceVersionId: v2.versionId, effectiveFrom: '2027-02',
      ...terms({windows: [{...DIGITAL, windowPartnerId: 2}, PACKAGE]})}));
    assert.match(v4.feeShares.skipped[0].reason, /受取先が変わった/);
    const later = await monthly(f, 'workId=1&from=2026-09&to=2027-03');
    assert.deepEqual(later.report.holds.feeSharesDropped.map((row) => [row.versionNo, row.kind, row.fromVersionNo]), [[3, 'digital', 2], [4, 'digital', 2]]);
    assert.deepEqual(wfee(later), wfee(split), '適用開始月より前の月の取り分は変わらない');
    assert.equal(later.checksOk, true);
  } finally {
    f.db.close();
  }
});

test('F3: 地域の表記ゆれ（日本国内・全国・JPN・ＪＰ・ジャパン・日本（国内））は国内の区分。海外の地域は海外のまま', async (t) => {
  for (const territory of ['日本', '国内', '日本国内', '全国', 'JPN', 'jp', 'ＪＰ', 'Ｊａｐａｎ', 'ジャパン', '日本（国内）', ' 日本 ', '']) {
    assert.equal(channelGroupOf({family: 'digital', territory}), 'digital', territory);
  }
  for (const territory of ['北米', '台湾', 'US', '全世界（日本を除く）', '海外', 'アジア']) {
    assert.equal(channelGroupOf({family: 'digital', territory}), 'overseas', territory);
  }
  const f = await fixture({t});
  try {
    good(await f.req('/committee/contracts', contractInput(f)));
    const sale = await f.db.get("SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE r.kind='digital'");
    await f.db.run("INSERT INTO sale_distribution_versions(org_id,sale_id,version_no,distribution_code,territory,settlement_method,reason,created_by) VALUES(1,?,1,'svod','日本国内','unverified','試験の分類',1)", [sale.id]);
    const body = await monthly(f, 'workId=1&from=2026-09&to=2026-12');
    assert.equal(row(body, 'sales:digital').values.period, 100_000, '「日本国内」の配信は配信の窓口');
    assert.equal(row(body, 'sales:overseas'), undefined);
    assert.deepEqual(body.report.holds.windowMissing, [], '海外の窓口が無くても保留にしない');
    assert.equal(row(body, 'platformFee').values.period, fee(100_000, 1000));
  } finally {
    f.db.close();
  }
});

test('F4: 月次収支1回の要求で、売上明細は対象作品の分を1回だけ読む（組織のほかの作品の明細を読まない）。IN の値は100個以内', async (t) => {
  const f = await fixture({t});
  try {
    good(await f.req('/committee/contracts', contractInput(f)));
    await royaltyAgreement(f);
    // 同じ組織の別の作品（委員会なし）の売上を多めに入れる
    await f.db.run("INSERT INTO works(id,org_id,project_id,code,title) VALUES(3,1,1,'WRK-BUSY','架空の売上の多い作品')");
    await f.db.run("INSERT INTO products(id,org_id,sku,name,channel) VALUES(3,1,'SKU-BUSY','架空の配信商品','digital')");
    await f.db.run('INSERT INTO product_works(org_id,product_id,work_id,allocation_bps) VALUES(1,3,3,10000)');
    for (let n = 0; n < 12; n += 1) {
      good(await f.req('/sales', {workId: 3, report_key: `BUSY-${n}`, kind: 'digital', partner_id: 2, product_id: 3, period_from: '2026-09-01', period_to: '2026-09-30',
        recognition_basis_id: 2, report_received_on: '2026-10-05', basis_reason: '架空の受領月', description: `別作品の売上${n}`, quantity: 1, amount_ex_tax: 1000, tax_amount: 0, amount_inc_tax: 1000}));
    }
    const workSales = new Set((await f.db.all('SELECT id FROM sale_lines WHERE work_id=1')).map((sale) => sale.id));
    const reads = [];
    const counting = new Proxy(f.db, {
      get(target, prop) {
        if (prop === 'all') {
          return async (sql, params = []) => {
            const rows = await target.all(sql, params);
            reads.push({sql, params, rows});
            return rows;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const identity = {org_id: 1, user_id: 1, role: 'admin', email: 'admin@openingnight.invalid', expires_at: null};
    const worker = createApp({db: counting, mode: 'worker', authenticate: async () => identity});
    const response = await worker.request('/api/reports/committee-monthly?workId=1&from=2026-09&to=2026-12');
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body).slice(0, 300));
    assert.ok(body.accruals.length > 0, 'ロイヤリティの発生額も同じ明細で計算している');
    const saleReads = reads.filter((read) => /FROM sale_lines/.test(read.sql));
    const scans = saleReads.filter((read) => /accounting_month BETWEEN/.test(read.sql));
    assert.ok(scans.length >= 1 && scans.length <= 2, `売上明細の読み出しは1回（商品で絞る問い合わせと作品で絞る問い合わせ）: ${scans.length}`);
    for (const read of saleReads) {
      for (const sale of read.rows) assert.ok(workSales.has(sale.id), `対象作品でない売上明細 ${sale.id} を読んでいる: ${read.sql.slice(0, 80)}`);
    }
    assert.ok(reads.every((read) => read.params.length <= 100), 'D1 の1つの問い合わせの値は100個まで');
    assert.equal(body.checksOk, true);
  } finally {
    f.db.close();
  }
});

test('F6: 月次収支は作品の最後の委員会契約で集計し、ほかの契約の指定は409。権利処理費の基礎は同じ契約の本委員会収入', async (t) => {
  const f = await fixture({t});
  try {
    const c1 = good(await f.req('/committee/contracts', contractInput(f)));
    const c2 = good(await f.req('/committee/contracts', {...contractInput(f, 'REVIEW-C2'), windows: [{...DIGITAL, windowFeeBps: 3000}, PACKAGE]}));
    await royaltyAgreement(f);
    const old = await f.req(`/reports/committee-monthly?workId=1&from=2026-09&to=2026-12&contractId=${c1.contractId}`);
    assert.equal(old.status, 409, JSON.stringify(old.data).slice(0, 200));
    assert.match(old.data.error, /最後に登録した委員会契約/);
    const body = await monthly(f, `workId=1&from=2026-09&to=2026-12&contractId=${c2.contractId}`);
    assert.equal(body.contract.id, c2.contractId);
    for (const month of body.report.periodMonths) {
      const income = monthValue(body, 'income', month);
      const base = body.accruals.filter((row) => row.accrualMonth === month).reduce((sum, row) => sum + row.baseYen, 0);
      if (income) assert.equal(base, income, `${month}: 権利処理費の基礎は帳票の本委員会収入と同じ`);
    }
    assert.ok(body.accruals.length > 0);
  } finally {
    f.db.close();
  }
});

test('F7: 区分未確認の保留は対象売上で持ち（本委員会収入と混ぜない）、注意は期間内の件数で算定できた額と含めていない額を分ける', () => {
  const agreement = {id: 1, workId: 1, holderId: 10, category: 'original',
    terms: [{id: 1, versionNo: 1, effectiveFrom: '2026-01', calcMethod: 'rate', baseKind: 'committee_income', rateBps: 1000, channels: ['sell', 'digital'], expenseCategories: []}]};
  const [item] = accrueAgreement({agreement, toMonth: '2026-01', committee: {available: true, expenses: [], rows: [
    {month: '2026-01', channelGroup: 'package', sales: 1_000_000, income: 600_000},
    {month: '2026-01', channelGroup: 'sell', sales: 400_000, income: null},
    {month: '2026-01', channelGroup: 'digital', sales: 200_000, income: 150_000},
  ]}});
  assert.equal(item.holdSalesYen, 1_400_000, '保留は対象売上（区分未確認1,000,000＋窓口の無い区分400,000）');
  assert.equal(item.holdIncomeYen, 600_000, '決められない本委員会収入は別に持つ');
  assert.equal(item.royaltyYen, 15_000);

  const members = [{partnerId: 1, name: '架空A', shareBps: 10000, memberOrder: 1}];
  const report = buildCommitteeMonthly({from: '2026-02', to: '2026-03', members, windows: [], accruals: [
    {agreementId: 1, workId: 1, category: 'original', accrualMonth: '2026-01', royaltyYen: null, holdSalesYen: 500},
    {agreementId: 1, workId: 1, category: 'original', accrualMonth: '2026-02', royaltyYen: 13_285, holdSalesYen: 2_090_464},
  ]});
  assert.deepEqual(report.holds.royaltyPeriod, {count: 1, months: ['2026-02'], unknownCount: 0, partialCount: 1, includedYen: 13_285, holdSalesYen: 2_090_464},
    '期間外（2026-01）の保留は数えない');
  const sheets = committeeMonthlySheets({report, notes: [], incomeRows: [], accruals: [], lines: [], expenseLines: []}, {title: '試験'});
  const notes = sheets[0].exportSpec?.notes || sheets[0].notes || [];
  const text = notes.join('\n');
  assert.match(text, /一部だけ算定できた権利処理費が1件/);
  assert.match(text, /13,285円/);
  assert.doesNotMatch(text, /2026年1月/);
});

test('F8: ロイヤリティ契約の無い作品は、権利処理費を計上していないことを画面と Excel の注記に出す', async (t) => {
  const f = await fixture({t});
  try {
    good(await f.req('/committee/contracts', contractInput(f)));
    const none = await monthly(f, 'workId=1&from=2026-09&to=2026-12');
    assert.equal(none.royalty.agreementCount, 0);
    assert.match(none.royalty.note, /ロイヤリティ契約が登録されていないため、権利処理費を計上していません/);
    assert.ok(none.notes.includes(none.royalty.note), 'Excel の月次収支シートの注記にも出す');
    const sheet = committeeMonthlySheets(none, {title: '試験'})[0];
    assert.ok((sheet.exportSpec?.notes || sheet.notes || []).some((note) => /ロイヤリティ契約が登録されていない/.test(note)));
    await royaltyAgreement(f);
    const some = await monthly(f, 'workId=1&from=2026-09&to=2026-12');
    assert.equal(some.royalty.agreementCount, 1);
    assert.equal(some.royalty.note, null);
    assert.ok(!some.notes.some((note) => /ロイヤリティ契約が登録されていない/.test(note)));
  } finally {
    f.db.close();
  }
});

test('F9: 出資者別の表で、出資額0円の回収率は月次収支の表と同じ「—」。出資額の登録が無いときだけ「未確認」', () => {
  const column = INVESTOR_COLUMNS.find((item) => item.key === 'recoveryRate');
  const share = INVESTOR_COLUMNS.find((item) => item.key === 'shareBps');
  const text = (col, row) => cellText(col.type, col.value ? col.value(row) : row[col.key]);
  assert.equal(text(column, {member: true, investmentYen: 0, recoveryRate: null}), '—');
  assert.equal(text(column, {member: true, investmentYen: null, recoveryRate: null}), '未確認');
  assert.equal(text(column, {member: true, investmentYen: 100, recoveryRate: 0.5}), '50.0%');
  assert.equal(text(share, {member: false, shareBps: 0}), '参加者以外');
});

test('F5: 条件（作品・期間）を変えて読み込み中の間は、前の条件の応答を表示・出力に使わない', async () => {
  const {currentReportBody} = await import('../src/committee/committee-monthly-view.mjs');
  const body = {report: {rows: []}, conditions: {workId: 1, from: '2026-01', to: '2026-03'}};
  assert.equal(currentReportBody({body, loading: true}, {workId: 2, from: '2026-01', to: '2026-03'}), null, '作品を変えた');
  assert.equal(currentReportBody({body, loading: true}, {workId: '1', from: '2026-04', to: '2026-06'}), null, '期間を変えた');
  assert.equal(currentReportBody({body, loading: false}, {workId: '1', from: '2026-01', to: '2026-03'}), body);
  assert.equal(currentReportBody({}, {workId: 1, from: '2026-01', to: '2026-03'}), null);
});
