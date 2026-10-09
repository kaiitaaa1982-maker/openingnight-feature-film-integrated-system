import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb } from './test-db.mjs';
import { createApp } from '../src/app.mjs';
import { conditionChanges, conditionDraftFromRow, conditionLinkText, conditionPayload, newConditionDraft } from '../src/broadcast-draft.mjs';
import { allocationsForProduct, allocationsFromRows, bpsToPercentText, describeAllocations, parsePercent, rowsFromAllocations, sameAllocations, totalBpsOfRows } from '../src/work/allocation.mjs';
import { displayDateTime, exposureLabel, exposureRows, metricLabel, observationRows, publicityForWork } from '../src/work/publicity-model.mjs';

async function fixture({ t } = {}) {
  const db = await openTestDb({ t }), app = createApp({ db, mode: 'local' });
  return { db, app };
}
async function login(app, email = 'admin@openingnight.invalid') {
  const response = await app.request('/api/local/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function call(app, cookie, path, { method = 'GET', body } = {}) {
  const response = await app.request(`/api${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const addWork = db => db.run("INSERT INTO works(id,org_id,project_id,code,title,format) VALUES(3,1,1,'WP00-SECOND','別の架空作品','film')");

// 1. 販売条件の新しい版で調達ケース・文書のリンクが消えない

test('販売条件の下書きは前の版の調達ケース・文書を持ち、変更項目を日本語で返す', () => {
  const row = { distribution_code: 'B001', territory: '日本', version_no: 2, release_on: '2026-10-01', sales_end_on: null, terms_text: '架空の条件', source_reference: '架空根拠', exclusivity: 'nonexclusive', status: 'draft', intake_case_id: 7, document_id: 11 };
  const draft = conditionDraftFromRow(1, row);
  assert.equal(draft.intakeCaseId, 7);
  assert.equal(draft.documentId, 11);
  assert.equal(draft.baseVersion, 2);
  assert.deepEqual(conditionChanges(draft), []);
  const payload = conditionPayload({ ...draft, terms: '改訂した条件', releaseOn: '2026-11-01' });
  assert.equal(payload.intakeCaseId, 7);
  assert.equal(payload.documentId, 11);
  assert.equal('original' in payload, false);
  assert.deepEqual(conditionChanges({ ...draft, terms: '改訂した条件', releaseOn: '2026-11-01' }), ['解禁日', '販売条件']);
  assert.deepEqual(conditionChanges({ ...draft, intakeCaseId: null, documentId: null }), ['調達ケース', '調達文書']);
  const fresh = newConditionDraft(1, 'B001');
  assert.equal(fresh.baseVersion, 0);
  assert.equal(conditionPayload(fresh).intakeCaseId, null);
  assert.deepEqual(conditionChanges(fresh), []);
  assert.equal(conditionLinkText(draft, { intakes: [{ id: 7, case_code: 'CASE-7' }], documents: [{ id: 11, title: '架空の許諾書' }] }), '調達ケース CASE-7・文書 架空の許諾書');
  assert.equal(conditionLinkText(fresh), '調達ケース・文書は未紐付け');
});

test('番販画面から新しい版を保存しても調達ケース・文書のリンクが残る', async (t) => {
  const { db, app } = await fixture({ t });
  try {
    const admin = await login(app);
    const intake = await call(app, admin, '/intakes', { method: 'POST', body: { workId: 1, caseCode: 'WP00-LINK', title: '架空の調達ケース', intakeType: 'sole_owned', documents: [{ title: '架空の許諾書', reference: 'WP00-DOC-1', versionLabel: 'v1' }] } });
    assert.equal(intake.body.ok, true, JSON.stringify(intake.body));
    let catalog = await call(app, admin, '/sales-catalog');
    const intakeCase = catalog.body.intakes.find(row => row.case_code === 'WP00-LINK'), document = catalog.body.documents.find(row => row.intake_case_id === intakeCase.id);
    const first = await call(app, admin, '/sales-catalog', { method: 'POST', body: { workId: 1, distributionCode: 'B001', territory: '日本', baseVersion: 0, releaseOn: '', salesEndOn: '', terms: '第1版', sourceReference: '架空根拠', intakeCaseId: intakeCase.id, documentId: document.id, exclusivity: 'unknown', status: 'draft' } });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // 画面の経路: 一覧の行から下書きを作り、条件だけ変えて保存する。
    catalog = await call(app, admin, '/sales-catalog');
    const row = catalog.body.rows.find(r => r.work_id === 1 && r.distribution_code === 'B001');
    const draft = { ...conditionDraftFromRow(1, row), terms: '第2版の条件' };
    const second = await call(app, admin, '/sales-catalog', { method: 'POST', body: conditionPayload(draft) });
    assert.equal(second.status, 201, JSON.stringify(second.body));

    // 旧い画面と同じく、リンクの項目を送らない本文でも前の版から引き継ぐ。
    const legacy = { workId: 1, distributionCode: 'B001', territory: '日本', baseVersion: 2, releaseOn: '', salesEndOn: '', terms: '第3版の条件', sourceReference: '架空根拠', exclusivity: 'unknown', status: 'draft', original: row };
    const third = await call(app, admin, '/sales-catalog', { method: 'POST', body: legacy });
    assert.equal(third.status, 201, JSON.stringify(third.body));

    const versions = await db.all("SELECT version_no,intake_case_id,document_id,terms_text FROM sales_availability_versions WHERE org_id=1 AND work_id=1 AND distribution_code='B001' ORDER BY version_no");
    assert.deepEqual(versions.map(v => [v.version_no, v.intake_case_id, v.document_id]), [[1, intakeCase.id, document.id], [2, intakeCase.id, document.id], [3, intakeCase.id, document.id]]);

    // 明示的に外すことはできる（営業作品一覧で「未紐付け」を選んだ場合）。
    const unlinked = await call(app, admin, '/sales-catalog', { method: 'POST', body: { ...legacy, baseVersion: 3, terms: '第4版', intakeCaseId: '', documentId: '' } });
    assert.equal(unlinked.status, 201, JSON.stringify(unlinked.body));
    const latest = await db.get("SELECT intake_case_id,document_id FROM sales_availability_versions WHERE org_id=1 AND work_id=1 AND distribution_code='B001' AND version_no=4");
    assert.deepEqual([latest.intake_case_id, latest.document_id], [null, null]);
  } finally {
    await db.close();
  }
});

// 2. 商品配賦: 既存の配賦を読み、% で編集し、使用済み・競合を拒否する

test('配賦の % と bp を相互に変換し、合計100%以外と重複を拒否する', () => {
  assert.equal(bpsToPercentText(10000), '100');
  assert.equal(bpsToPercentText(4000), '40');
  assert.equal(bpsToPercentText(3333), '33.33');
  assert.equal(bpsToPercentText(1250), '12.5');
  assert.deepEqual(parsePercent('４０％'), { bps: 4000, error: null });
  assert.deepEqual(parsePercent(' 33.33 % '), { bps: 3333, error: null });
  assert.equal(parsePercent('33.333').error !== null, true);
  assert.equal(parsePercent('0').error !== null, true);
  assert.equal(parsePercent('101').error !== null, true);
  for (const bps of [1, 1250, 3333, 4000, 6667, 10000]) assert.equal(parsePercent(bpsToPercentText(bps)).bps, bps);

  const existing = [{ product_id: 5, work_id: 3, allocation_bps: 6000 }, { product_id: 5, work_id: 1, allocation_bps: 4000 }, { product_id: 6, work_id: 1, allocation_bps: 10000 }];
  const current = allocationsForProduct(existing, 5);
  assert.deepEqual(current, [{ workId: 1, allocationBps: 4000 }, { workId: 3, allocationBps: 6000 }]);
  const rows = rowsFromAllocations(current, 1);
  assert.deepEqual(rows, [{ workId: 1, percent: '40' }, { workId: 3, percent: '60' }]);
  assert.deepEqual(rowsFromAllocations([], 1), [{ workId: 1, percent: '100' }]);
  const back = allocationsFromRows(rows);
  assert.deepEqual(back.errors, []);
  assert.equal(sameAllocations(back.allocations, current), true);
  assert.equal(totalBpsOfRows(rows), 10000);
  assert.equal(describeAllocations(current, [{ id: 1, title: '風のあとさき' }, { id: 3, title: '別の架空作品' }]), '風のあとさき 40%、別の架空作品 60%');

  const short = allocationsFromRows([{ workId: 1, percent: '40' }, { workId: 3, percent: '50' }]);
  assert.deepEqual(short.allocations, []);
  assert.match(short.errors.map(x => x.message).join(' '), /合計を100%にしてください（現在 90%）/);
  const duplicate = allocationsFromRows([{ workId: 1, percent: '50' }, { workId: 1, percent: '50' }]);
  assert.equal(duplicate.errors.some(x => x.index === 1 && /同じ作品/.test(x.message)), true);
  const blankWork = allocationsFromRows([{ workId: '', percent: '100' }]);
  assert.equal(blankWork.errors.some(x => x.index === 0 && /作品を選んで/.test(x.message)), true);
});

test('商品配賦は既存の配賦を返し、編集開始時と違えば409、売上登録済みなら409で拒否する', async (t) => {
  const { db, app } = await fixture({ t });
  try {
    await addWork(db);
    const admin = await login(app);
    const product = await call(app, admin, '/products', { method: 'POST', body: { sku: 'WP00-MULTI', name: '複数作品の架空商品', channel: 'digital' } });
    assert.equal(product.status, 201);
    const productId = product.body.id;

    let state = await call(app, admin, `/product-works?productId=${productId}`);
    assert.equal(state.status, 200);
    assert.deepEqual(state.body.allocations, []);
    assert.equal(state.body.locked, false);

    // 初回の配賦（既存なし）は編集開始時の配賦なしで保存できる。
    const first = await call(app, admin, '/product-works', { method: 'POST', body: { productId, allocations: [{ workId: 1, allocationBps: 4000 }, { workId: 3, allocationBps: 6000 }] } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    state = await call(app, admin, `/product-works?productId=${productId}`);
    assert.deepEqual(state.body.allocations, [{ workId: 1, allocationBps: 4000 }, { workId: 3, allocationBps: 6000 }]);
    const boot = await call(app, admin, '/bootstrap');
    assert.deepEqual(allocationsForProduct(boot.body.productAllocations, productId), state.body.allocations);

    // 既存の配賦がある商品を、編集開始時の配賦なしで全置換させない。
    const blind = await call(app, admin, '/product-works', { method: 'POST', body: { productId, allocations: [{ workId: 1, allocationBps: 10000 }] } });
    assert.equal(blind.status, 428);
    // 画面を開いた後に別の人が変えていた場合。
    const stale = await call(app, admin, '/product-works', { method: 'POST', body: { productId, allocations: [{ workId: 1, allocationBps: 10000 }], baseAllocations: [{ workId: 1, allocationBps: 10000 }] } });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /他の人が先に更新しました/);
    assert.deepEqual((await db.all('SELECT work_id,allocation_bps FROM product_works WHERE org_id=1 AND product_id=? ORDER BY work_id', [productId])).map(r => [r.work_id, r.allocation_bps]), [[1, 4000], [3, 6000]]);

    // 入力の誤りは400。
    for (const allocations of [[{ workId: 1, allocationBps: 5000 }, { workId: 3, allocationBps: 4000 }], [{ workId: 1, allocationBps: 5000 }, { workId: 1, allocationBps: 5000 }], [{ workId: 1, allocationBps: 0 }, { workId: 3, allocationBps: 10000 }], []]) {
      const invalid = await call(app, admin, '/product-works', { method: 'POST', body: { productId, allocations, baseAllocations: state.body.allocations } });
      assert.equal(invalid.status, 400, JSON.stringify(allocations));
    }

    // 販売契約で使っている作品は、比率を変えられるが配賦から外せない。
    const opportunity = await call(app, admin, '/opportunities', { method: 'POST', body: { project_id: 1, work_id: 3, partner_id: 2, name: '架空の営業案件', stage: 'lead' } });
    assert.equal(opportunity.status, 201, JSON.stringify(opportunity.body));
    await db.run("INSERT INTO sales_agreements(org_id,project_id,work_id,opportunity_id,partner_id,product_id,contract_code,title,created_by) VALUES(1,1,3,?,2,?,'WP00-AGREEMENT','架空の販売契約',1)", [opportunity.body.id, productId]);
    const removeReferenced = await call(app, admin, '/product-works', { method: 'POST', body: { productId, allocations: [{ workId: 1, allocationBps: 10000 }], baseAllocations: state.body.allocations } });
    assert.equal(removeReferenced.status, 409);
    assert.match(removeReferenced.body.error, /販売契約で使っている作品は配賦から外せません/);
    const reweight = await call(app, admin, '/product-works', { method: 'POST', body: { productId, allocations: [{ workId: 1, allocationBps: 5000 }, { workId: 3, allocationBps: 5000 }], baseAllocations: state.body.allocations } });
    assert.equal(reweight.status, 200, JSON.stringify(reweight.body));
    state = await call(app, admin, `/product-works?productId=${productId}`);
    assert.deepEqual(state.body.allocations, [{ workId: 1, allocationBps: 5000 }, { workId: 3, allocationBps: 5000 }]);
    assert.ok(await db.get("SELECT 1 FROM audit_log WHERE entity_type='product_works' AND entity_id=? AND action='allocate'", [String(productId)]));

    // 売上を登録した商品は配賦を変えられない。画面を開いた時点で施錠と理由が分かる。
    await db.run("INSERT INTO sale_lines(org_id,project_id,work_id,product_id,partner_id,sales_period_from,sales_period_to,accounting_month,description,amount_ex_tax,tax_amount,amount_inc_tax) VALUES(1,1,1,?,2,'2026-09-01','2026-09-30','2026-09','架空の売上',100000,10000,110000)", [productId]);
    state = await call(app, admin, `/product-works?productId=${productId}`);
    assert.equal(state.body.locked, true);
    assert.match(state.body.lockReasons.join(' '), /売上登録済みの商品は配賦を変更できません（売上明細 1件）/);
    const locked = await call(app, admin, '/product-works', { method: 'POST', body: { productId, allocations: [{ workId: 1, allocationBps: 6000 }, { workId: 3, allocationBps: 4000 }], baseAllocations: state.body.allocations } });
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error, '売上登録済みの商品は配賦を変更できません');
    assert.deepEqual((await db.all('SELECT work_id,allocation_bps FROM product_works WHERE org_id=1 AND product_id=? ORDER BY work_id', [productId])).map(r => [r.work_id, r.allocation_bps]), [[1, 5000], [3, 5000]]);

    // 制作担当は配賦を読めず、変えられない。
    const production = await login(app, 'production@openingnight.invalid');
    assert.equal((await call(app, production, `/product-works?productId=${productId}`)).status, 403);
    assert.equal((await call(app, production, '/product-works', { method: 'POST', body: { productId: 1, allocations: [{ workId: 1, allocationBps: 10000 }] } })).status, 403);
  } finally {
    await db.close();
  }
});

test('MG契約に登録済みの商品は配賦を変えられない', async (t) => {
  const { db, app } = await fixture({ t });
  try {
    const admin = await login(app);
    const contract = await call(app, admin, '/mg/contracts', { method: 'POST', body: { direction: 'incoming', code: 'WP00-MG', title: '架空・配賦施錠', partnerId: 2, contractDate: '2026-01-01', contractSourceReference: '架空資料', mgAmountYen: 1000, startsOn: '2026-01-01', endsOn: '2026-12-31', mode: 'single', reason: '検証', sourceReference: '架空条件', products: [{ productId: 2, evaluationYen: 1000 }], phases: [{ startsOn: '2026-01-01', endsOn: '2026-12-31', intervalMonths: 1, closeDay: '31', firstCloseOn: '2026-01-31', reportOffsetMonths: 1, reportDay: 31, payOffsetMonths: 2, payDay: 31 }] } });
    assert.equal(contract.body.ok, true, JSON.stringify(contract.body));
    const state = await call(app, admin, '/product-works?productId=2');
    assert.match(state.body.lockReasons.join(' '), /MG契約 1件/);
    assert.equal(state.body.locked, true);
    const locked = await call(app, admin, '/product-works', { method: 'POST', body: { productId: 2, allocations: [{ workId: 1, allocationBps: 10000 }], baseAllocations: state.body.allocations } });
    assert.equal(locked.status, 409);
    assert.match(locked.body.error, /MG契約に登録済みの商品は配賦を変更できません/);
  } finally {
    await db.close();
  }
});

// 3. 宣伝: 露出・観測を選択作品で絞り、施策名・指標名で出す

test('宣伝の露出・観測は選択作品のものだけを施策名・指標名で返す（純関数）', () => {
  const campaigns = [{ id: 1, work_id: 1, name: '予告編公開' }, { id: 2, work_id: 3, name: '別作品の試写会' }];
  const exposures = [{ id: 10, campaign_id: 1, medium: '動画サイト', scheduled_at: '2026-09-10T10:00' }, { id: 20, campaign_id: 2, medium: '新聞' }];
  const observations = [{ id: 100, exposure_id: 10, metric_definition_id: 1, period_from: '2026-09-01', period_to: '2026-09-30', granularity: 'month', value_number: 12000, verification: 'unverified', acquired_at: '2026-09-30T15:00:00.000Z', paid_organic: 'paid' }, { id: 200, exposure_id: 20, metric_definition_id: 1, period_from: '2026-09-01', period_to: '2026-09-30', granularity: 'month', value_number: 5, verification: 'verified', acquired_at: '2026-09-30T00:00:00.000Z' }];
  const metrics = [{ id: 1, label: '表示回数', unit: '回' }];
  const own = publicityForWork({ campaigns, exposures, observations }, 1);
  assert.deepEqual(own.campaigns.map(x => x.id), [1]);
  assert.deepEqual(own.exposures.map(x => x.id), [10]);
  assert.deepEqual(own.observations.map(x => x.id), [100]);
  assert.deepEqual(publicityForWork({ campaigns, exposures, observations }, 3).observations.map(x => x.id), [200]);
  assert.deepEqual(publicityForWork({ campaigns, exposures, observations }, 9), { campaigns: [], exposures: [], observations: [] });

  const [exposure] = exposureRows(own.exposures, own.campaigns);
  assert.equal(exposure.施策, '予告編公開');
  assert.equal(exposure.媒体, '動画サイト');
  assert.equal(exposure.予定日時, '2026/09/10 10:00');
  assert.equal(Object.keys(exposure).some(key => /id/i.test(key)), false);
  const [observation] = observationRows(own.observations, own.exposures, own.campaigns, metrics);
  assert.equal(observation.施策, '予告編公開');
  assert.equal(observation.指標, '表示回数');
  assert.equal(observation.値, '12,000 回');
  assert.equal(observation.広告区分, '広告');
  assert.equal(observation.取得日時, '2026/10/01 00:00');
  assert.equal(Object.values(observation).includes(1), false);
  assert.equal(exposureLabel(own.exposures[0], own.campaigns), '予告編公開｜動画サイト');
  assert.equal(metricLabel(metrics[0]), '表示回数（回）');
  assert.equal(displayDateTime(null), '未確認');
  const unknown = observationRows([{ exposure_id: 10, metric_definition_id: 1, period_from: '2026-09-01', period_to: '2026-09-30', granularity: 'unknown', value_number: null, value_text: null, verification: 'unverified', acquired_at: '2026-09-30T00:00:00Z' }], own.exposures, own.campaigns, metrics);
  assert.equal(unknown[0].値, '未確認');
});

test('宣伝の一覧APIの行を選択作品で絞ると、同じ案件の別作品の露出・観測が混ざらない', async (t) => {
  const { db, app } = await fixture({ t });
  try {
    await addWork(db);
    const admin = await login(app);
    const campaign = async (workId, name) => (await call(app, admin, '/campaigns', { method: 'POST', body: { project_id: 1, work_id: workId, name, objective: '認知', starts_on: '2026-09-01', ends_on: '2026-09-30' } })).body.id;
    const exposure = async (campaignId, medium) => (await call(app, admin, '/exposures', { method: 'POST', body: { campaign_id: campaignId, medium } })).body.id;
    const observe = async (exposureId, value) => {
      const response = await call(app, admin, '/observations', { method: 'POST', body: { exposure_id: exposureId, metric_definition_id: 1, period_from: '2026-09-01', period_to: '2026-09-30', granularity: 'month', value_number: value, verification: 'unverified', acquired_at: '2026-09-30T00:00:00.000Z', paid_organic: 'unknown' } });
      assert.equal(response.status, 201, JSON.stringify(response.body));
    };
    const own = await campaign(1, '本作の予告編'), other = await campaign(3, '別作品の試写会');
    const ownExposure = await exposure(own, '動画サイト'), otherExposure = await exposure(other, '新聞');
    await observe(ownExposure, 1000);
    await observe(otherExposure, 7);

    const [campaigns, exposures, observations, boot] = await Promise.all(['/campaigns', '/exposures', '/observations', '/bootstrap'].map(path => call(app, admin, path)));
    // サーバーは案件の権限で絞るだけなので、別作品の行も返る（画面側で絞る理由）。
    assert.equal(exposures.body.rows.length, 2);
    assert.equal(observations.body.rows.length, 2);
    const filtered = publicityForWork({ campaigns: campaigns.body.rows, exposures: exposures.body.rows, observations: observations.body.rows }, 1);
    assert.deepEqual(filtered.exposures.map(x => x.id), [ownExposure]);
    assert.deepEqual(exposureRows(filtered.exposures, filtered.campaigns).map(x => x.施策), ['本作の予告編']);
    const rows = observationRows(filtered.observations, filtered.exposures, filtered.campaigns, boot.body.metrics);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].施策, '本作の予告編');
    assert.equal(rows[0].指標, '表示回数');
    assert.equal(rows[0].値, '1,000 回');
  } finally {
    await db.close();
  }
});
