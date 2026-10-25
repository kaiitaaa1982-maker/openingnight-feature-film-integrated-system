// 会社への利益額の受け口（GET /api/accounting/profit。src/accounting/profit/profit-routes.mjs）に、架空の種（請求は入金の無い請求も全部）と
// 種の経費・製作委員会への自社の払込を入れ、計上・入金の両方の応答が golden（expected.json の「利益額」）を統合システムに記録の形がある分へ写した値と
// 不一致0であることを確かめる（フェーズ1の仕様書 #14b の受け入れ基準）。自社出資の出資額は稟議の払込の版（行動指標の計画 段B #4）を種の出資の記録から入れて
// golden の該当の行と照らす。記録の形が無い費目（買付の MG の支払・P&A の負担者・取引先の源泉の有無）は golden から写す先を test/profit-db-fixture.mjs の
// DB_ITEM_OF_GOLDEN に書き、受け口が「未接続」「負担者 未登録」で返すことを確かめる。
// あわせて、基準の引数（既定は計上・ほかの値は 400）、期間の引数、SQL ≤ 10、権限（制作担当 403・財務の権限の案件だけ・案件不明は会社全体を見る人だけ）、
// 同じ入力で同じ sourceHash を確かめる。期待値の出どころは要件 docs/requirements/accounting/company-profit.md と golden。ON_TEST_DB=pg で同じ試験が PostgreSQL で流れる
import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {PROFIT_ITEMS} from '../src/accounting/profit/profit-model.mjs';
import {signedRateAmount} from '../src/royalty/royalty-model.mjs';
import {loadYojitsuSeed, yojitsuGolden, yojitsuSeed, SEED_OWNER} from './yojitsu-view-fixture.mjs';
import {asGoldenBasis, goldenBasis, SEED_ONLY_EXCLUDED} from './profit-fixture.mjs';
import {goldenForDb, loadProfitSeedCosts, reverseSelfCommitteePayment} from './profit-db-fixture.mjs';

const golden = yojitsuGolden().利益額;
const expected = goldenForDb(golden, {items: PROFIT_ITEMS, rateAmount: signedRateAmount});

// DB の入口の呼び出しを数える（all・get・run は1本、batch・readBatch は文の数）。読み取りの一括の結果は reads に残す
function countingDb(db) {
  const counter = {n: 0, reads: []};
  const proxy = new Proxy(db, {get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    if (['all', 'get', 'run'].includes(prop)) return (...args) => { counter.n += 1; return value.apply(target, args); };
    if (prop === 'readBatch') return async (statements, ...rest) => { counter.n += statements.length; const out = await value.call(target, statements, ...rest); counter.reads.push(out); return out; };
    if (prop === 'batch') return (statements, ...rest) => { counter.n += statements.length; return value.call(target, statements, ...rest); };
    return value.bind(target);
  }});
  return {db: proxy, counter};
}

async function setup(t) {
  const raw = await openTestDb({t});
  const seed = yojitsuSeed();
  const seeded = await loadYojitsuSeed(raw, {seed, allInvoices: true});
  const costs = await loadProfitSeedCosts(raw, {seeded, seed});
  const {db, counter} = countingDb(raw);
  const app = createApp({db, mode: 'local'});
  async function as(email) {
    const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
    assert.equal(login.status, 200, email);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    return async (path) => {
      const before = counter.n;
      const res = await app.request(path, {headers: {cookie}});
      return {status: res.status, body: await res.json(), sql: counter.n - before};
    };
  }
  return {raw, seed, seeded, costs, as, reads: counter.reads};
}

test('golden を記録の形がある分へ写す部品は、写さない（費目をそのまま）と golden と同じ値を作る', () => {
  const identity = Object.fromEntries(golden.費目.map((g) => [g.費目, g.費目 === SEED_ONLY_EXCLUDED ? null : g.費目]));
  const same = goldenForDb(golden, {items: PROFIT_ITEMS, rateAmount: signedRateAmount, mapping: identity});
  for (const basis of ['accrual', 'cash']) assert.deepEqual(same[basis], goldenBasis(golden, basis), basis);
});

test('FR-ACCT-PROFIT-001 FR-ACCT-PROFIT-002 FR-ACCT-PROFIT-003 FR-ACCT-PROFIT-004 FR-ACCT-PROFIT-005 FR-ACCT-PROFIT-006 FR-ACCT-PROFIT-007 FR-ACCT-PROFIT-008 FR-ACCT-PROFIT-010 FR-ACCT-PROFIT-012 架空の種を入れると、計上・入金の両方で golden を記録の形がある分へ写した値と不一致0で、SQL は10本以内', async (t) => {
  const {as, seed} = await setup(t);
  const owner = await as(SEED_OWNER);
  const baseline = (await owner('/api/session')).sql;
  for (const basis of ['accrual', 'cash']) {
    const res = await owner(`/api/accounting/profit?basis=${basis}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const view = res.body;
    assert.deepEqual([view.basis, view.basisLabel, view.taxLabel], [basis, basis === 'cash' ? '入金' : '計上', '税別']);
    assert.deepEqual(asGoldenBasis(view), expected[basis], basis);
    // 確定の利益額＝売上−経費。案件別の和＝確定の合計
    assert.deepEqual(view.settled.profitYen, view.settled.salesYen.map((s, i) => s - view.settled.costYen[i]));
    assert.equal(view.byProject.reduce((n, p) => n + p.profitYen, 0), view.settled.totals.profitYen);
    // 記録の形が無い費目は額を出さずに「未接続」。自社出資の出資額は稟議の払込の版から引くので接続した（golden の該当の行と上で照らした）
    assert.deepEqual(view.unconnected.map((u) => [u.key, u.status, u.projectCount]),
      [['acquisition_mg', 'unconnected', 0], ['acquisition_buyout', 'unconnected', 0], ['sales_withholding', 'unconnected', null]]);
    assert.ok(view.unconnected.every((u) => !('amounts' in u) && !('total' in u)), '未接続の費目に額（0円）を入れない');
    const own = view.items.find((item) => item.key === 'own_investment');
    assert.deepEqual([own.status, own.side], ['settled', 'cost']);
    // 種の自社出資の案件6件のうち、出資の記録（稟議の払込）の無い2件（YJ-P11・P12）は出資額を引いていないと注記する
    const ownProjects = seed.案件.filter((p) => p.稼ぎ方 === '自社出資').map((p) => p.案件コード);
    const funded = new Set(seed.investments.filter((x) => x.kind === '自社出資').map((x) => seed.works.find((w) => w.work_code === x.work_code).project_code));
    const unpaid = ownProjects.filter((code) => !funded.has(code));
    assert.deepEqual(unpaid, ['YJ-P11', 'YJ-P12']);
    assert.ok(view.notes.includes(`自社出資の出資額は、稟議の払込の記録が無い案件 ${unpaid.length}件では引いていません。出資していれば、利益額はその分だけ大きく出ます`), JSON.stringify(view.notes));
    assert.ok(!view.notes.some((n) => n.startsWith('自社出資の出資額は記録が無く引いていません')), JSON.stringify(view.notes));
    assert.deepEqual([view.scope.company, view.unknownProject.total], [true, 0]);
    assert.match(view.sourceHash, /^[0-9a-f]{64}$/);
    // 要件は10本以内（N+1 無し）。いまは読み取りの一括の10文。0本は数え方の誤り
    const sql = res.sql - baseline;
    assert.ok(sql >= 1 && sql <= 10, `利益額の受け口の SQL（認証を除く）が ${sql} 本（10本以内）`);
  }
  // 基準を省くと計上（既定）。同じ入力・同じ読む人で同じ sourceHash
  const plain = await owner('/api/accounting/profit');
  const accrual = await owner('/api/accounting/profit?basis=accrual');
  assert.equal(plain.body.basis, 'accrual');
  assert.equal(plain.body.sourceHash, accrual.body.sourceHash);
  assert.notEqual((await owner('/api/accounting/profit?basis=cash')).body.sourceHash, accrual.body.sourceHash);
  // データの時点は読んだ入出金の日付の最後
  assert.equal(accrual.body.dataAsOf.label, '最後の入出金');
  assert.ok(accrual.body.dataAsOf.at.startsWith('2026-11'), accrual.body.dataAsOf.at);
});

test('FR-ACCT-PROFIT-001 FR-ACCT-PROFIT-011 基準は accrual・cash だけを受け（ほかは 400）、期間は YYYY-MM の from≦to だけを受けて、その月だけを軸にする', async (t) => {
  const {as} = await setup(t);
  const owner = await as(SEED_OWNER);
  for (const [query, field] of [['basis=gross', 'basis'], ['basis=Cash', 'basis'], ['from=2026-13', 'from'], ['to=2026/11', 'to'], ['from=2026-11&to=2026-10', 'from']]) {
    const res = await owner(`/api/accounting/profit?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.body.details.field, field, query);
  }
  const res = await owner('/api/accounting/profit?basis=cash&from=2026-04&to=2026-11');
  assert.equal(res.status, 200);
  const want = expected.cash;
  const inRange = want.月.map((m, i) => [m, i]).filter(([m]) => m >= '2026-04' && m <= '2026-11');
  assert.deepEqual(res.body.months, inRange.map(([m]) => m));
  assert.deepEqual(res.body.settled.salesYen, inRange.map(([, i]) => want.確定.売上[i]));
  assert.deepEqual(res.body.settled.costYen, inRange.map(([, i]) => want.確定.経費[i]));
  assert.deepEqual(res.body.conditions, {from: '2026-04', to: '2026-11'});
});

// 期間を渡すと、軸の月を決める日付（計上月・入金日・取消日・出金日・払込日）が期間に入る記録だけを SQL で読む（期間外の全期間の記録を読まない）。
// 期間に入る経費の出金は期間の外の分も読む（出金の取消の税抜は元の出金で決める）。応答の額は全期間の応答のその月の列と同じ。
// 壊れたら: 期間を SQL に渡さず全期間を読むと、期間の外の売上明細・入金・払込を読んで落ち、経費を計上月だけで絞るなど絞りすぎると全期間の応答の列と合わずに落ちる
test('FR-ACCT-PROFIT-011 FR-ACCT-PROFIT-012 期間を渡すと期間の月に入る記録だけを読み、応答の額は全期間の応答のその月の列と同じ', async (t) => {
  const {as, reads} = await setup(t);
  const owner = await as(SEED_OWNER);
  // 読み取りの一括の結果から、入金・売上明細・経費（経費ごと）・払込（委員会への自社の払込と稟議の払込の版の1つの文）の行を取り出す
  const sourcesOf = ([, , , receipts, sales, expenseRows, , , , payments]) => ({receipts, sales, expenses: [...Map.groupBy(expenseRows, (r) => Number(r.id)).values()],
    committee: payments.filter((r) => r.source === 'committee'), own: payments.filter((r) => r.source === 'own_investment')});
  reads.length = 0;
  await owner('/api/accounting/profit?basis=cash');
  const all = sourcesOf(reads[0]);
  // 種の入金はどれも 2026-11、売上明細は 2026-08〜10、自社の払込は 2025-06・2025-09・2026-11、稟議の払込は 2025-03〜2025-09。2つの期間で、期間に入る行と入らない行の両方を作る
  for (const [from, to] of [['2026-09', '2026-11'], ['2025-06', '2026-10']]) {
    const inRange = (on) => on !== null && on !== undefined && String(on).slice(0, 7) >= from && String(on).slice(0, 7) <= to;
    const want = {
      receipts: all.receipts.filter((r) => inRange(r.received_on) || inRange(r.reversed_on)),
      sales: all.sales.filter((r) => inRange(r.accounting_month)),
      expenses: all.expenses.filter((rows) => inRange(rows[0].accounting_month) || inRange(rows[0].expense_voided_on) || rows.some((r) => inRange(r.paid_on))),
      committee: all.committee.filter((r) => inRange(r.paid_on)),
      own: all.own.filter((r) => inRange(r.paid_on)),
    };
    for (const basis of ['accrual', 'cash']) {
      const full = (await owner(`/api/accounting/profit?basis=${basis}`)).body;
      reads.length = 0;
      const part = await owner(`/api/accounting/profit?basis=${basis}&from=${from}&to=${to}`);
      assert.equal(part.status, 200, JSON.stringify(part.body).slice(0, 300));
      assert.equal(reads.length, 1, '読み取りの一括は1回');
      assert.deepEqual(sourcesOf(reads[0]), want, `${from}〜${to} は期間に入る行だけを読む（期間の外を読まず、期間に入る行を落とさない）`);
      // 応答の額は全期間の応答のその月の列
      const at = full.months.map((m, i) => [m, i]).filter(([m]) => m >= from && m <= to);
      const slice = (values) => at.map(([, i]) => values[i]);
      assert.deepEqual(part.body.months, at.map(([m]) => m));
      assert.deepEqual([part.body.settled.salesYen, part.body.settled.costYen, part.body.settled.profitYen],
        [slice(full.settled.salesYen), slice(full.settled.costYen), slice(full.settled.profitYen)], `${from}〜${to} ${basis}`);
      const nonZero = (rows) => rows.map((r) => [r.key, r.amounts]).filter(([, amounts]) => amounts.some((v) => v !== 0));
      for (const group of ['unsettled', 'excluded']) {
        assert.deepEqual(nonZero(part.body[group]), nonZero(full[group].map((r) => ({key: r.key, amounts: slice(r.amounts)}))), `${from}〜${to} ${basis} ${group}`);
      }
      assert.deepEqual(part.body.unknownProject.amounts, slice(full.unknownProject.amounts));
      assert.ok(inRange(part.body.dataAsOf.at), `データの時点は期間の中の最後の入出金: ${part.body.dataAsOf.at}`);
    }
    // 期間の外の行が実際にある（絞りが効く種であること）
    assert.ok(['sales', 'expenses', 'committee', 'own'].some((key) => want[key].length < all[key].length) && want.expenses.length > 0, `${from}〜${to}`);
  }
  assert.ok(all.receipts.length > 0 && all.sales.length > 0 && all.committee.length > 0 && all.own.length > 0);
});

test('FR-ACCT-PROFIT-009 制作担当と財務の権限の案件の無い編集担当は 403、編集担当は財務の権限の案件の分だけを見て案件不明の行は出ず、別の組織には組織1の額が出ない', async (t) => {
  const {raw, seeded, as} = await setup(t);
  const production = await as('production@openingnight.invalid');
  assert.equal((await production('/api/accounting/profit')).status, 403);
  // 所属が production だけの編集担当は財務の権限の案件が無いので 403
  await raw.run("INSERT INTO users(id,email,display_name) VALUES(9,'profit-viewer@openingnight.invalid','架空の編集担当（利益額）')");
  await raw.run("INSERT INTO memberships(org_id,user_id,role) VALUES(1,9,'editor')");
  await raw.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,9,'production')", [seeded.projectId.get('YJ-P05')]);
  assert.equal((await (await as('profit-viewer@openingnight.invalid'))('/api/accounting/profit')).status, 403);
  // 編集担当（試作の行。試作の案件1が edit）に製作委員会の案件 YJ-P05 の edit を足すと、YJ-P05 の行だけが出る
  await raw.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'edit')", [seeded.projectId.get('YJ-P05')]);
  const editor = await as('editor@openingnight.invalid');
  for (const basis of ['accrual', 'cash']) {
    const res = await editor(`/api/accounting/profit?basis=${basis}`);
    assert.equal(res.status, 200);
    const p05 = expected[basis].案件別.find((p) => p.案件コード === 'YJ-P05');
    assert.deepEqual(res.body.byProject.map((p) => [p.code, p.salesYen, p.costYen, p.profitYen]), [['YJ-P05', p05.売上, p05.経費, p05.利益額]], basis);
    assert.deepEqual(res.body.settled.totals, {salesYen: p05.売上, costYen: p05.経費, profitYen: p05.利益額}, basis);
    assert.deepEqual([res.body.scope.company, res.body.unknownProject], [false, null]);
    assert.ok(res.body.notes.includes('会社全体を見る権限が無いので、案件不明の行を出していません（見てよい案件の分だけ）'));
    // ほかの案件の未確定の経費も出ない（未確定の行の案件は YJ-P05 だけ）
    assert.deepEqual([...new Set(res.body.unsettled.flatMap((r) => r.projectIds))], res.body.unsettled.length ? [seeded.projectId.get('YJ-P05')] : []);
  }
  // 別の組織の管理者には組織1の額が出ない
  const outsider = await as('outsider@other.invalid');
  const other = await outsider('/api/accounting/profit?basis=cash');
  assert.equal(other.status, 200);
  assert.deepEqual([other.body.months, other.body.byProject, other.body.settled.totals], [[], [], {salesYen: 0, costYen: 0, profitYen: 0}]);
});

// 稟議の払込の無い自社出資の案件の数（注記）は、見てよい案件の分だけ数える。種の払込の無い自社出資の案件は YJ-P11・P12 の2件で、編集担当（試作の行。
// 試作の案件1は自社出資でない）に YJ-P11 と払込のある YJ-P01 の edit を足すと、注記は1件（見てよくない YJ-P12 を数えない）
// 壊れたら: 注記の数を見てよい案件で絞らないと、組織の全部の自社出資の案件を数えて2件になって落ちる
test('FR-ACCT-PROFIT-007 FR-ACCT-PROFIT-009 稟議の払込の無い自社出資の案件の注記は、見てよい案件の分だけを数える', async (t) => {
  const {raw, seeded, as} = await setup(t);
  for (const code of ['YJ-P01', 'YJ-P11']) {
    await raw.run("INSERT INTO project_memberships(org_id,project_id,user_id,permission) VALUES(1,?,2,'edit')", [seeded.projectId.get(code)]);
  }
  const editor = await as('editor@openingnight.invalid');
  for (const basis of ['accrual', 'cash']) {
    const res = await editor(`/api/accounting/profit?basis=${basis}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.byProject.map((p) => p.code), ['YJ-P01'], basis);
    assert.deepEqual(res.body.notes.filter((n) => n.startsWith('自社出資の出資額は、稟議の払込の記録が無い案件')),
      ['自社出資の出資額は、稟議の払込の記録が無い案件 1件では引いていません。出資していれば、利益額はその分だけ大きく出ます'], basis);
  }
});

// 種の製作委員会には幹事（YJ-LEAD）の払込も入っている（loadProfitSeedCosts）ので、上の golden の照合が自社の絞りを確かめている。ここでは自社の払込の取消を足す。
// 期待値は golden を写した値から手で動かす: 作品 YJ-W09（案件 YJ-P06）の自社の払込 19,520,000（2025-09-03）を 2026-05-20 に取り消すと、
// 両方の基準で 2026-05 の確定の経費が 19,520,000 減り（払った 2025-09 は変えない）、YJ-P06 の経費も同じだけ減る。
// 壊れたら: 払込の自社の絞りを外すと幹事の払込が経費に入り、取消の行を読まない（reverses_id IS NULL で絞る）と 2026-05 が減らずに落ちる
test('FR-ACCT-PROFIT-004 製作委員会の出資額は自社の払込だけを引き（幹事の払込は引かない）、自社の払込の取消は取消日の月に負の額で戻す', async (t) => {
  const {raw, seeded, costs, as} = await setup(t);
  const lead = await raw.get('SELECT COUNT(*) AS n, SUM(amount_yen) AS yen FROM committee_investment_payments WHERE org_id=1 AND partner_id<>?', [costs.selfPartnerId]);
  assert.ok(Number(lead.n) > 0 && Number(lead.yen) > 0, '種に幹事の払込がある');
  const reversed = await reverseSelfCommitteePayment(raw, {owner: seeded.owner, costs, workCode: 'YJ-W09', on: '2026-05-20'});
  assert.equal(reversed, 19520000);
  const owner = await as(SEED_OWNER);
  for (const basis of ['accrual', 'cash']) {
    const want = structuredClone(expected[basis]);
    const at = want.月.indexOf('2026-05');
    want.確定.経費[at] -= reversed;
    want.確定.利益額[at] += reversed;
    want.確定.合計.経費 -= reversed;
    want.確定.合計.利益額 += reversed;
    const p06 = want.案件別.find((p) => p.案件コード === 'YJ-P06');
    p06.経費 -= reversed;
    p06.利益額 += reversed;
    const res = await owner(`/api/accounting/profit?basis=${basis}`);
    assert.equal(res.status, 200);
    assert.deepEqual(asGoldenBasis(res.body), want, basis);
  }
});

// 種の買付の案件（YJ-P08・P09・P10）に MG の分配契約・作品の費用の版の買付額を足し、稼ぎ方が買付でない案件（自社出資 YJ-P01・販売委託 YJ-P19）にも足す。
// 未接続の「買付の MG」は MG の契約のある買付の案件（P08・P10。P10 は買付額もあるが MG の契約があるので MG）、「買い切りの買付額」は MG の契約が無く買付額のある買付の案件（P09）だけを数える。
// 壊れたら: 稼ぎ方によらず数えると P01 が MG に、P19 が買い切りに入って 3件・2件になって落ちる
test('FR-ACCT-PROFIT-007 未接続の買付の MG・買い切りの買付額の当たりそうな案件は、稼ぎ方が買付の案件だけを契約の形で数えて注記に出す', async (t) => {
  const {raw, seed, seeded, costs, as} = await setup(t);
  const holder = costs.committeeTerms.get('YJ-W07').lead;
  const projectOfWork = new Map(seed.works.map((w) => [w.work_code, w.project_code]));
  const mg = (workCode, i) => raw.run(`INSERT INTO settlement_contracts(org_id,project_id,work_id,contract_code,title,contract_type,holder_partner_id,mg_contract_yen,created_by)
    VALUES(1,?,?,?,'架空の MG の分配契約','mg',?,1000000,?)`, [seeded.projectId.get(projectOfWork.get(workCode)), seeded.workId.get(workCode), `YJ-MG-${i}`, holder, seeded.owner]);
  const purchase = (workCode) => raw.run(`INSERT INTO work_finance_versions(org_id,work_id,revision,production_cost_tax_basis,production_cost_status,promotion_budget_tax_basis,promotion_budget_status,
      own_investment_tax_basis,own_investment_status,sales_rights_purchase_yen,sales_rights_purchase_tax_basis,sales_rights_purchase_status,
      sales_rights_purchase_as_of,sales_rights_purchase_evidence,source_reference,reason,created_by)
    VALUES(1,?,1,'unknown','unknown','unknown','unknown','ex_tax','unknown',500000,'ex_tax','confirmed','2026-04-01','架空の買付の契約書','架空の参照','架空の登録',?)`, [seeded.workId.get(workCode), seeded.owner]);
  await mg('YJ-W11', 1);
  await purchase('YJ-W13');
  await mg('YJ-W15', 2);
  await purchase('YJ-W15');
  await mg('YJ-W01', 3);
  await purchase('YJ-W19');
  const res = await (await as(SEED_OWNER))('/api/accounting/profit?basis=cash');
  assert.equal(res.status, 200);
  const count = (key) => res.body.unconnected.find((u) => u.key === key).projectCount;
  assert.deepEqual([count('acquisition_mg'), count('acquisition_buyout')], [2, 1]);
  assert.ok(res.body.notes.some((n) => n.startsWith('買付の MGは記録が無く引いていません（当たりそうな案件 2件）')), JSON.stringify(res.body.notes));
  assert.ok(res.body.notes.some((n) => n.startsWith('買い切りの買付額は記録が無く引いていません（当たりそうな案件 1件）')), JSON.stringify(res.body.notes));
});

test('FR-ACCT-PROFIT-007 会社の法人情報に自社の取引先が無い組織では、製作委員会の出資額も「未接続」で、払込を引かない', async (t) => {
  const {as} = await setup(t);
  const outsider = await as('outsider@other.invalid'); // 組織2には法人情報の版が無い
  const res = await outsider('/api/accounting/profit');
  assert.equal(res.status, 200);
  const committee = res.body.unconnected.find((u) => u.key === 'committee_investment');
  assert.ok(committee, JSON.stringify(res.body.unconnected));
  assert.match(committee.reason, /自社の取引先が無く/);
});
