// シナリオの比較の API（POST /api/revenue/scenarios/compare。計画は会社ルートの plans/2026-10-09-sales-producer-kpi.md の A-2）の試験。
// 架空の種（scripts/seed-all-demo.mjs の 売上・営業基幹・PL・BS・作品マスタ・シナリオの比較の節。組織 DEMO-SALES）を白紙の DB に入れ、
// 期待値は計画の「段A」の表の取り方どおりに、PL・BS の材料（loadPlBsInput）・権利・分配の試算（settlementPreviewData）・作品マスタの版から
// この試験の中で独立に足す（API の facts の組み立てを通さない）。種の行は test/fixtures/scenario/compare-request.json の facts と同じ値。
// - 源泉3（委員会）・源泉5（販売委託）・源泉4（買付。J-9 (c)）・源泉2（自社出資）と出資の回収の表が、独立に足した値と一致し、源泉1は未接続
// - 需給の曲線は、公開からの月数ごとの売上の和とその月数まで観測できた作品の数を、loadPlBsInput の行から独立に足した値と照らす
//   （営業基幹の節が劇場公開の確定の版を入れるので、公開月の出どころ window の作品も通る）
// - 制作担当（ロールが制作担当なら案件の権限が編集でも）は403。財務の権限が無い案件の作品・商談・売上は応答（需給の曲線を含む）に入らず、本文で指すと400
// - 同じ入力で同じ sourceHash。入力か記録が変わると変わる。本文を保存しない（表の行数が変わらない）
// - 足す SQL は作品の数に依らない固定の本数（≤ 10）、試算は分配契約のある作品×7本以下
// - 作品→源泉（計画の決定 D2）: 買付に入れるのは最新の版の買付額がある作品か MG の分配契約がある作品だけ。契約一覧の権利の取得（kind='acquisition'）だけの作品は
//   買付に入れない（種の作品マスタの節の作品は、どれも権利の取得の契約があり買付額が無い）。自社出資の作品はその入金が出資の回収に当たる
// - 自社出資の出資額と買い切りの買付額は期間より前に払った扱いで期間の粗利から引かず、委員会の自社の払込は期間内の分を引く（計画の決定 D1）
// - 重なり: 自社出資の作品に買付の契約を足しても何も変わらず、買付額を足すと買い切りの買付にも入り、売上はすべて買付に数え、自社出資の回収から入金が外れる
//   （同じ売上を2回数えない）。委託契約を足して報告を紐付けると、出資の回収の収益から紐付いた報告の入金が外れ、委託の手数料に入る。
//   委員会の作品に委託契約を足すと、取得額を契約の分と分けられないので源泉3の実績に入れない（未確定。計画の決定 D3）
import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openTestDb} from './test-db.mjs';
import {seedAllDemo, tableCounts, countDifferences} from '../scripts/seed-all-demo.mjs';
import {createApp} from '../src/app.mjs';
import {loadPlBsInput} from '../src/pl-bs/pl-bs-data.mjs';
import {splitByWeights} from '../src/reports/pl-bs-model.mjs';
import {CHANNEL_GROUPS} from '../src/sales/channel-group.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/scenario/compare-request.json', import.meta.url), 'utf8'));
const PERIOD = fixture.request.period;
const CLOSED = fixture.request.closedMonth;
// 期間内の実績の月（期間の始まり〜締めた月）と、累計（締めた月まで）
const inWindow = (month) => month >= PERIOD.from && month <= (CLOSED < PERIOD.to ? CLOSED : PERIOD.to);
const upToClose = (month) => month <= CLOSED;
const sum = (rows, pick) => rows.reduce((n, row) => n + pick(row), 0);
const rate = (revenue, investment) => (investment > 0 ? Number((BigInt(revenue) * 10000n) / BigInt(investment)) : null);

// 読み取りの本数を数える入口（all・get は1本、readBatch は文の数）
function countingDb(db) {
  const state = {n: 0};
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'all' || prop === 'get') return (...args) => { state.n += 1; return value.apply(target, args); };
      if (prop === 'readBatch') return (statements, ...rest) => { state.n += statements.length; return value.apply(target, [statements, ...rest]); };
      return value.bind(target);
    },
  });
  return {proxy, state};
}

let base, db, counter, app, org, ids;
const cookies = {};
const identities = {};
const login = async (email) => {
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})});
  assert.equal(response.status, 200, email);
  return response.headers.get('set-cookie').split(';')[0];
};
const call = async (who, method, path, payload) => {
  const response = await app.request(`/api${path}`, {method, headers: {cookie: cookies[who], 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
  return {status: response.status, body: await response.json()};
};
const compare = (who, payload) => call(who, 'POST', '/revenue/scenarios/compare', payload);
const invite = async (email, projectId, role) => {
  const created = await call('admin', 'POST', '/team/invitations', {email, projectId, role, expiresAt: '2099-12-31T00:00:00.000Z'});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await call('admin', 'POST', `/team/invitations/${created.body.id}/accept`, {})).status, 200);
  const user = await db.get('SELECT id FROM users WHERE email=?', [email]);
  return {org_id: org.id, user_id: user.id, role};
};

// fixture の要求の本文（種に入っている商談だけ。ID は名前で DB の ID に置き換える）
const requestBody = (patch = {}) => ({
  ...structuredClone(fixture.request),
  opportunities: fixture.request.opportunities.filter((row) => fixture.seed.opportunityNames[String(row.id)])
    .map((row) => ({...row, id: ids.opportunity.get(fixture.seed.opportunityNames[String(row.id)])})),
  ...patch,
});

before(async (t) => {
  base = await openTestDb({t});
  await seedAllDemo(base, {only: ['sales', 'eigyo', 'plbs', 'masters', 'scenario']});
  ({proxy: db, state: counter} = countingDb(base));
  app = createApp({db, mode: 'local'});
  org = await db.get("SELECT id FROM organizations WHERE code='DEMO-SALES'");
  cookies.admin = await login('demo-admin@openingnight.invalid');
  identities.admin = {org_id: org.id, user_id: (await db.get("SELECT id FROM users WHERE email='demo-admin@openingnight.invalid'")).id, role: 'admin'};
  const scn = await db.get("SELECT id FROM projects WHERE org_id=? AND code='DEMO-SCN'", [org.id]);
  const other = await db.get("SELECT p.id FROM projects p WHERE p.org_id=? AND p.code<>'DEMO-SCN' AND EXISTS(SELECT 1 FROM works w WHERE w.org_id=p.org_id AND w.project_id=p.id) ORDER BY p.id LIMIT 1", [org.id]);
  // 財務の権限が DEMO-SCN 以外の1案件だけの編集担当と、DEMO-SCN の制作担当（架空のアドレス）
  identities.editor = await invite('scenario-editor@openingnight.invalid', other.id, 'editor');
  identities.production = await invite('scenario-production@openingnight.invalid', scn.id, 'production');
  cookies.editor = await login('scenario-editor@openingnight.invalid');
  cookies.production = await login('scenario-production@openingnight.invalid');
  const works = await db.all('SELECT id, project_id, code FROM works WHERE org_id=? ORDER BY id', [org.id]);
  const opportunities = await db.all('SELECT id, name, project_id FROM sales_opportunities WHERE org_id=? ORDER BY id', [org.id]);
  ids = {
    scnProject: scn.id, otherProject: other.id,
    allWorks: works.map((row) => row.id), otherWorks: works.filter((row) => row.project_id === other.id).map((row) => row.id),
    scnWorks: new Set(works.filter((row) => row.project_id === scn.id).map((row) => row.id)),
    work: (fixtureWorkId) => works.find((row) => row.code === fixture.seed.workCodes[String(fixtureWorkId)]).id,
    opportunity: new Map(opportunities.map((row) => [row.name, row.id])),
    scnOpportunities: opportunities.filter((row) => row.project_id === scn.id).map((row) => row.id),
  };
});

// ---------- 計画の「段A」の表の取り方で、独立に足した期待値 ----------
async function expectedOf(who, workIds) {
  const identity = identities[who];
  const plbs = await loadPlBsInput(base, identity, app.ux, {from: PERIOD.from, to: CLOSED, asOf: CLOSED, workIds, includeCompany: false});
  const scope = new Set(workIds);
  const finance = new Map((await base.all(`SELECT f.work_id, f.own_investment_yen, f.sales_rights_purchase_yen FROM work_finance_versions f WHERE f.org_id=?
      AND f.revision=(SELECT MAX(x.revision) FROM work_finance_versions x WHERE x.org_id=f.org_id AND x.work_id=f.work_id)`, [org.id])).map((row) => [row.work_id, row]));
  // 契約一覧の最新の版に権利の取得（kind='acquisition'）の契約がある作品。作品→源泉の対応には使わない（D2）。それを確かめるためにだけ読む
  const rightsContract = new Set((await base.all(`SELECT v.work_id FROM work_contract_versions v WHERE v.org_id=? AND v.kind='acquisition'
      AND v.revision=(SELECT MAX(x.revision) FROM work_contract_set_versions x WHERE x.org_id=v.org_id AND x.work_id=v.work_id)`, [org.id])).map((row) => row.work_id));
  const contracts = (await base.all('SELECT work_id, contract_type FROM settlement_contracts WHERE org_id=?', [org.id])).filter((row) => scope.has(row.work_id));
  const typed = (type) => new Set(contracts.filter((row) => row.contract_type === type).map((row) => row.work_id));
  const commissionWorks = [...typed('commission')].sort((a, b) => a - b);
  const mgWorks = typed('mg');
  const previews = new Map();
  for (const workId of new Set([...commissionWorks, ...mgWorks])) previews.set(workId, await app.ux.settlementPreviewData(identity, workId));
  const self = plbs.profile.selfPartnerId;
  const committeeWorks = new Set(plbs.works.filter((row) => row.committee).map((row) => row.id));
  const ownWorks = plbs.works.filter((row) => !row.committee && finance.get(row.id)?.own_investment_yen != null).map((row) => row.id);
  // 源泉4＝最新の版の買付額がある作品（買い切り）か MG の分配契約がある作品（MG つき）
  const purchased = (workId) => (finance.get(workId)?.sales_rights_purchase_yen ?? null) !== null;
  const acquisitionWorks = plbs.works.filter((row) => purchased(row.id) || mgWorks.has(row.id)).map((row) => row.id);
  const contractWorks = new Set([...acquisitionWorks, ...commissionWorks]);

  // 源泉3: 期間内の自社の取得額 − 期間内の自社の払込（委員会の月次収支を計算できない作品は除いて件数を数える）。
  // 買付・販売委託の契約にも入る委員会の作品は、取得額を契約の分と分けられないので除いて件数を数える
  const committeeRows = plbs.committee.map((entry) => {
    const payments = plbs.investmentPayments.filter((row) => row.workId === entry.workId && row.partnerId === self);
    const acquisitions = entry.error ? null : entry.acquisitions.filter((row) => upToClose(row.month));
    return {
      workId: entry.workId, error: entry.error,
      // 出資のある案件（計画の「出資の回収」）: 自社の持分・約定の出資額・締めた月までの払込のどれかがある委員会の作品
      invested: entry.selfShareBps !== null || entry.committedYen !== null || payments.some((row) => upToClose(row.paidOn.slice(0, 7))),
      paymentsTotal: sum(payments.filter((row) => upToClose(row.paidOn.slice(0, 7))), (row) => row.amount),
      paymentsPeriod: sum(payments.filter((row) => inWindow(row.paidOn.slice(0, 7))), (row) => row.amount),
      acquisitionsTotal: acquisitions && sum(acquisitions, (row) => row.acquisition),
      acquisitionsPeriod: acquisitions && sum(acquisitions.filter((row) => inWindow(row.month)), (row) => row.acquisition),
    };
  });
  const committeeKnown = committeeRows.filter((row) => !row.error && !contractWorks.has(row.workId));
  // 源泉5: 委託の行の手数料と権利元へ渡る額。未紐付けは紐付けていない報告の件数と税抜額
  const commissionLines = commissionWorks.flatMap((workId) => previews.get(workId).lineResults.filter((row) => row.contractType === 'commission' && inWindow(row.accountingMonth)));
  const unlinked = new Set();
  let unlinkedAmount = 0;
  for (const workId of commissionWorks) {
    const reports = new Set(previews.get(workId).unlinkedReports.map((row) => row.id));
    for (const line of plbs.saleLines.filter((row) => row.workId === workId && inWindow(row.month))) {
      const saleReport = (await base.get('SELECT report_id FROM sale_lines WHERE org_id=? AND id=?', [org.id, line.saleId])).report_id;
      if (!reports.has(saleReport)) continue;
      unlinked.add(saleReport);
      unlinkedAmount += line.amount;
    }
  }
  // 源泉4（J-9 (c)）: MG つきは MG の行の手数料の和、買い切りは 期間内の税抜売上（買付額は期間より前に払った扱いで引かない。D1）
  const acquisitionRows = acquisitionWorks.map((workId) => {
    if (mgWorks.has(workId)) {
      return {workId, value: sum(previews.get(workId).lineResults.filter((row) => row.contractType === 'mg' && inWindow(row.accountingMonth)), (row) => row.agencyFee), sales: sum(plbs.saleLines.filter((row) => row.workId === workId && inWindow(row.month)), (row) => row.amount)};
    }
    const sales = sum(plbs.saleLines.filter((row) => row.workId === workId && inWindow(row.month)), (row) => row.amount);
    return {workId, value: sales, sales};
  });
  const acquisitionKnown = acquisitionRows.filter((row) => row.value !== null);
  // 源泉2: 作品の入金（請求の作品の重みで分けた税込額）。出資額は期間より前に払った扱いで、期間の粗利から引かない（D1）。
  // 買い切りの買付（買付額があり MG の分配契約が無い）にも入る作品は、売上をすべて買付に数えるので入金を当てない。
  // 委託・MG の分配契約に紐付いた報告の入金を外す重なりは、最後の試験で前後の差として見る
  const receiptsOf = (workId) => plbs.receipts.map((r) => ({month: r.receivedOn.slice(0, 7), amount: (splitByWeights(r.amount, r.weights.map((w) => ({key: w.workId, weight: w.weight}))) || new Map()).get(workId)}))
    .filter((row) => row.amount !== undefined);
  const outrightOwn = ownWorks.filter((workId) => purchased(workId) && !mgWorks.has(workId));
  const ownRows = ownWorks.map((workId) => {
    const receipts = outrightOwn.includes(workId) ? [] : receiptsOf(workId);
    return {workId, investment: finance.get(workId).own_investment_yen,
      receiptsTotal: sum(receipts.filter((row) => upToClose(row.month)), (row) => row.amount), receiptsPeriod: sum(receipts.filter((row) => inWindow(row.month)), (row) => row.amount)};
  });
  // 作品ごとの参考の列: 源泉4の作品の買付額（最新の版）・MG の契約額と MG 残（試算の MG の契約の和）と、作品単位の入金（税込・未確定）
  const mgSummary = (workId, key) => (mgWorks.has(workId) ? sum(previews.get(workId).contractSummaries.filter((row) => row.contractType === 'mg'), (row) => row[key]) : null);
  const reference = new Map(plbs.works.map((work) => {
    const receipts = receiptsOf(work.id);
    const acquired = acquisitionWorks.includes(work.id);
    return [work.id, {purchaseYen: acquired ? finance.get(work.id)?.sales_rights_purchase_yen ?? null : null,
      mgContractYen: acquired ? mgSummary(work.id, 'mgContractYen') : null, mgBalanceYen: acquired ? mgSummary(work.id, 'mgBalance') : null,
      receiptsTotalYen: sum(receipts.filter((row) => upToClose(row.month)), (row) => row.amount), receiptsPeriodYen: sum(receipts.filter((row) => inWindow(row.month)), (row) => row.amount)}];
  }));
  return {
    reference,
    plbs, previews, ownWorks, committeeWorks, commissionWorks, outrightOwn, acquisitionRows, acquisitionWorks, contractWorks, rightsContract,
    overlapCount: [...committeeWorks, ...ownWorks].filter((workId) => contractWorks.has(workId)).length,
    sources: {
      contract_work: {status: 'unconnected', actualYen: null},
      own_investment: {status: 'connected', actualYen: sum(ownRows, (row) => row.receiptsPeriod), actualSalesYen: sum(ownRows, (row) => row.receiptsPeriod), rowCount: ownRows.length},
      committee: committeeKnown.length
        ? {status: 'connected', actualYen: sum(committeeKnown, (row) => row.acquisitionsPeriod - row.paymentsPeriod), actualSalesYen: sum(committeeKnown, (row) => row.acquisitionsPeriod), rowCount: committeeKnown.length, unknownCount: committeeRows.length - committeeKnown.length}
        : {status: committeeRows.length ? 'unknown' : 'connected', actualYen: committeeRows.length ? null : 0},
      acquisition: {actualYen: acquisitionKnown.length || !acquisitionRows.length ? sum(acquisitionKnown, (row) => row.value) : null,
        actualSalesYen: acquisitionKnown.length || !acquisitionRows.length ? sum(acquisitionKnown, (row) => row.sales) : null,
        unknownCount: acquisitionRows.filter((row) => row.value === null).length},
      consignment: {status: 'connected', actualYen: sum(commissionLines, (row) => row.agencyFee), actualSalesYen: sum(commissionLines, (row) => row.agencyFee), rowCount: commissionWorks.length},
    },
    creatorsTotal: sum(commissionLines, (row) => row.holderAmount),
    unlinked: {count: unlinked.size, amountYen: unlinkedAmount},
    investmentRows: [
      ...ownRows.map((row) => ({workId: row.workId, kind: 'own_investment', investmentYen: row.investment, revenueYen: row.receiptsTotal, periodInvestmentYen: 0, periodRevenueYen: row.receiptsPeriod})),
      ...committeeRows.filter((row) => row.invested).map((row) => ({workId: row.workId, kind: 'committee', investmentYen: row.paymentsTotal, revenueYen: row.acquisitionsTotal, periodInvestmentYen: row.paymentsPeriod, periodRevenueYen: row.acquisitionsPeriod})),
    ].map((row) => {
      const diffYen = row.revenueYen === null ? null : row.revenueYen - row.investmentYen;
      return {...row, diffYen, recoveryRateBps: diffYen === null ? null : rate(row.revenueYen, row.investmentYen), status: diffYen === null ? 'unknown' : diffYen < 0 ? 'awaiting' : 'recovered'};
    }),
  };
}

const pick = (object, keys) => Object.fromEntries(keys.map((key) => [key, object[key]]));

// 需給の曲線の期待値（計画の「需給予測」）を、PL・BS の材料の作品と売上明細から、曲線の実装を通さずに足す。
// 窓口×公開からの月数ごとの売上の和と、その月数まで観測できた作品の数（公開月＋月数 が締めた月以前で、その窓口に公開後の売上がある作品）、平均＝和÷作品の数の切り捨て
function expectedCurve(works, saleLines, closed) {
  const between = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
  const released = new Map(works.filter((row) => row.releaseMonth && row.releaseMonth <= closed).map((row) => [row.id, row.releaseMonth]));
  const excluded = {afterCloseLines: 0, noReleaseLines: 0, beforeReleaseLines: 0};
  const used = [];
  for (const line of saleLines) {
    if (line.month > closed) excluded.afterCloseLines += 1;
    else if (!released.has(line.workId)) excluded.noReleaseLines += 1;
    else if (line.month < released.get(line.workId)) excluded.beforeReleaseLines += 1;
    else used.push({...line, channel: CHANNEL_GROUPS.includes(line.channelGroup) ? line.channelGroup : 'other', offset: between(released.get(line.workId), line.month)});
  }
  const channels = CHANNEL_GROUPS.map((channel) => {
    const rows = used.filter((row) => row.channel === channel);
    const workIds = [...new Set(rows.map((row) => row.workId))];
    const top = rows.length ? Math.max(...rows.map((row) => row.offset)) : -1;
    const points = [];
    for (let offset = 0; offset <= top; offset++) {
      const sumYen = sum(rows.filter((row) => row.offset === offset), (row) => row.amount);
      const workCount = workIds.filter((workId) => between(released.get(workId), closed) >= offset).length;
      points.push({offset, workCount, sumYen, averageYen: Number(BigInt(sumYen) / BigInt(workCount))});
    }
    return {channel, status: rows.length ? 'curve' : 'no_curve', workCount: workIds.length, lineCount: rows.length, points};
  });
  return {excluded, channels, workCount: new Set(used.map((row) => row.workId)).size, lineCount: used.length};
}
const curveView = (curve) => ({excluded: curve.excluded, channels: curve.channels.map((row) => pick(row, ['channel', 'status', 'workCount', 'lineCount', 'points'])),
  workCount: curve.workCount, lineCount: curve.lineCount});
const REFERENCE_KEYS = ['purchaseYen', 'mgContractYen', 'mgBalanceYen', 'receiptsTotalYen', 'receiptsPeriodYen'];
// 作品ごとの参考の列が独立に足した値と一致し、表（workSources）にも同じ作品の行が同じ順で出る
function assertReference(out, expected) {
  for (const row of out.workSources) assert.deepEqual(pick(row, REFERENCE_KEYS), expected.reference.get(row.workId), `作品 ${row.workId} の参考の列`);
  const table = out.tables.find((row) => row.name === 'workSources');
  assert.deepEqual(table.rows.map((row) => [row.workId, ...REFERENCE_KEYS.map((key) => row[key])]), out.workSources.map((row) => [row.workId, ...REFERENCE_KEYS.map((key) => row[key])]));
}
const byWork = (rows) => [...rows].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.workId - b.workId));

test('源泉3・源泉5・源泉4・源泉2が計画の取り方で独立に足した値と一致し、源泉1は未接続で、作り手・権利元へ渡る額は委託の権利元の取り分の和', async () => {
  const response = await compare('admin', requestBody());
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400));
  const out = response.body;
  const expected = await expectedOf('admin', ids.allWorks);
  const source = (key) => out.sources.find((row) => row.source === key);
  assert.deepEqual(pick(source('contract_work'), ['status', 'actualYen', 'actualSalesYen']), {status: 'unconnected', actualYen: null, actualSalesYen: null});
  assert.deepEqual(pick(source('committee'), Object.keys(expected.sources.committee)), expected.sources.committee);
  assert.deepEqual(pick(source('consignment'), Object.keys(expected.sources.consignment)), expected.sources.consignment);
  assert.deepEqual(pick(source('acquisition'), Object.keys(expected.sources.acquisition)), expected.sources.acquisition);
  assert.deepEqual(pick(source('own_investment'), Object.keys(expected.sources.own_investment)), expected.sources.own_investment);
  // 種には委員会・委託・自社出資・買付（買い切り）の作品がそれぞれある（どれも 0 円の空の和で通っていない）
  assert.ok(expected.sources.committee.rowCount > 0 && expected.commissionWorks.length > 0 && expected.ownWorks.length > 0);
  assert.notEqual(expected.sources.consignment.actualYen, 0);
  // 作り手・権利元へ渡る額（KPI の第4枚）＝委託の行の holderAmount の和。ほかの源泉は null
  assert.equal(out.creators.totalYen, expected.creatorsTotal);
  assert.deepEqual(out.creators.bySource, {contract_work: null, own_investment: null, committee: null, acquisition: null, consignment: expected.creatorsTotal});
  // 未紐付けの報告と重なりの件数
  assert.deepEqual(out.unlinkedReports, expected.unlinked);
  assert.deepEqual(out.unlinkedReports, fixture.facts.unlinkedReports, '種の未紐付けの報告は W1 のパッケージの1通');
  assert.equal(out.overlapCount, expected.overlapCount);
  // D2: 種の作品マスタの節の委員会・自社出資の作品は、契約一覧に権利の取得の契約があるが買付額も MG も無いので、買付に入れず重ならない。
  // 委員会の作品は源泉3の実績に入り（上の源泉3の照合）、重なりの注記は出ない（重なりの扱いは最後の試験）
  const rightsOnly = (workId) => expected.rightsContract.has(workId) && !expected.acquisitionWorks.includes(workId);
  assert.ok([...expected.committeeWorks].some(rightsOnly) && expected.ownWorks.some(rightsOnly));
  assert.deepEqual(out.workSources.filter((row) => rightsOnly(row.workId) && row.sources.includes('acquisition')), []);
  assert.equal([...expected.committeeWorks].filter((workId) => expected.contractWorks.has(workId)).length, 0);
  assert.equal(out.notes.some((row) => row.code === 'overlap_committee'), false);
  assert.equal(out.notes.some((row) => row.code === 'unlinked'), true);
  assert.equal(out.checks.every((row) => row.ok), true, JSON.stringify(out.checks));
  // 作品→源泉の対応: 種の4作品は 委託・買付・自社出資・委員会 に1つずつ入る
  const sourcesOf = (fixtureWorkId) => out.workSources.find((row) => row.workId === ids.work(fixtureWorkId)).sources;
  assert.deepEqual([101, 102, 103, 104].map(sourcesOf), [['consignment'], ['acquisition'], ['own_investment'], ['committee']]);
  // 作品ごとの参考の列（計画の段A の表: 買付額・MG・MG 残と作品単位の入金。税込・未確定）。種には買付額と入金のある作品がある
  assertReference(out, expected);
  assert.ok(out.workSources.some((row) => row.purchaseYen > 0) && out.workSources.some((row) => row.receiptsTotalYen > 0));
  assert.equal(out.workSources.find((row) => row.workId === ids.work(102)).purchaseYen, fixture.facts.acquisition.find((r) => r.workId === 102).purchaseYen);
});

test('出資の回収の表: 出資案件ごとの出資額・収益・差額（収益−出資額）・回収率が独立に足した値と一致し、負の行は回収待ち。種の自社出資と委員会は回収待ちと回収済み', async () => {
  const out = (await compare('admin', requestBody())).body;
  const expected = await expectedOf('admin', ids.allWorks);
  const table = out.tables.find((row) => row.name === 'investmentRecovery');
  assert.deepEqual(table.columns.map((row) => row.key), ['title', 'kindLabel', 'investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps', 'periodInvestmentYen',
    'periodRevenueYen', 'remainingExpectedYen', 'projectedDiffYen', 'statusLabel']);
  const keys = ['workId', 'kind', 'investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps', 'status', 'periodRevenueYen'];
  assert.deepEqual(byWork(table.rows).map((row) => pick(row, keys)), byWork(expected.investmentRows).map((row) => pick(row, keys)));
  for (const row of table.rows.filter((r) => r.kind === 'committee')) {
    assert.equal(row.periodInvestmentYen, expected.investmentRows.find((e) => e.kind === 'committee' && e.workId === row.workId).periodInvestmentYen);
  }
  assert.deepEqual(table.rows.filter((row) => row.status === 'awaiting').map((row) => row.statusLabel), table.rows.filter((row) => row.status === 'awaiting').map(() => '回収待ち'));
  // 自社出資の「期間内の出資額」は、払込の月が無いので期間より前に払った扱いの0円（D1）。列名と注記で知らせる
  assert.match(table.columns.find((row) => row.key === 'periodInvestmentYen').label, /自社出資は期間より前に払った扱いで0円/);
  assert.match(out.notes.find((row) => row.code === 'investment_paid_before_period').text, /期間より前に払った扱い.*期間の粗利と期待値から引いていません/);
  assert.equal(out.notes.some((row) => row.code === 'own_investment_period_start'), false);
  const ownRows = table.rows.filter((r) => r.kind === 'own_investment');
  assert.ok(ownRows.length > 1 && ownRows.every((row) => row.periodInvestmentYen === 0 && row.investmentYen > 0));
  // 合計は差額が分かる行だけで足し、回収率は合計どうしの比
  const known = expected.investmentRows.filter((row) => row.diffYen !== null);
  assert.deepEqual(pick(table.total, ['rowCount', 'investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps']), {
    rowCount: known.length, investmentYen: sum(known, (row) => row.investmentYen), revenueYen: sum(known, (row) => row.revenueYen),
    diffYen: sum(known, (row) => row.revenueYen - row.investmentYen), recoveryRateBps: rate(sum(known, (row) => row.revenueYen), sum(known, (row) => row.investmentYen)),
  });
  // 種の行（fixture の facts と同じ値）: 自社出資 W3 は 400万円の出資に 220万円の入金で回収待ち、委員会 W4 は 180万円の払込に 406.2万円の取得額で回収済み
  const row = (fixtureWorkId) => table.rows.find((r) => r.workId === ids.work(fixtureWorkId));
  const own = fixture.facts.ownInvestment[0];
  const cmt = fixture.facts.committee.find((r) => r.workId === 104);
  assert.deepEqual(pick(row(103), ['investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps', 'status', 'statusLabel']),
    {investmentYen: own.investmentYen, revenueYen: own.receiptsTotalYen, diffYen: own.receiptsTotalYen - own.investmentYen, recoveryRateBps: 5500, status: 'awaiting', statusLabel: '回収待ち'});
  assert.deepEqual(pick(row(104), ['investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps', 'status', 'statusLabel']),
    {investmentYen: cmt.paymentsTotalYen, revenueYen: cmt.acquisitionsTotalYen, diffYen: cmt.acquisitionsTotalYen - cmt.paymentsTotalYen, recoveryRateBps: 22566, status: 'recovered', statusLabel: '回収済み'});
  // 期末の見込みの差額＝差額＋その作品の出資の源泉の残りの期待値（W3 は交渉中の商談5 の 112.5万円×確度0.8＝90万円）
  assert.deepEqual(pick(row(103), ['remainingExpectedYen', 'projectedDiffYen']), {remainingExpectedYen: 900000, projectedDiffYen: own.receiptsTotalYen - own.investmentYen + 900000});
  assert.deepEqual(out.scenarios.standard.investmentRecovery.total.diffYen, table.total.diffYen);
});

test('D2: 契約一覧に権利の取得の契約があっても買付額も MG も無い自社出資の作品は、自社出資だけに入り、入金が出資の回収の収益と期間の粗利に当たる', async () => {
  const out = (await compare('admin', requestBody())).body;
  const expected = await expectedOf('admin', ids.allWorks);
  const rightsOnlyOwn = expected.ownWorks.filter((workId) => expected.rightsContract.has(workId) && !expected.acquisitionWorks.includes(workId));
  assert.ok(rightsOnlyOwn.length > 1, '種の作品マスタの節の自社出資の作品は、権利の取得の契約があり買付額が無い');
  const rows = out.tables.find((row) => row.name === 'investmentRecovery').rows;
  for (const workId of rightsOnlyOwn) {
    assert.deepEqual(pick(out.workSources.find((row) => row.workId === workId), ['sources', 'overlap']), {sources: ['own_investment'], overlap: false}, `作品 ${workId}`);
    const reference = expected.reference.get(workId);
    assert.deepEqual(pick(rows.find((row) => row.kind === 'own_investment' && row.workId === workId), ['revenueYen', 'periodRevenueYen']),
      {revenueYen: reference.receiptsTotalYen, periodRevenueYen: reference.receiptsPeriodYen}, `作品 ${workId} の収益は作品の入金`);
  }
  // 入金のある作品があり（収益0円の行ばかりにならない）、その期間内の入金が源泉2の実績（期間の粗利）に入る
  const received = rightsOnlyOwn.filter((workId) => expected.reference.get(workId).receiptsTotalYen > 0);
  assert.ok(received.length > rightsOnlyOwn.length / 2, `入金のある作品 ${received.length}/${rightsOnlyOwn.length}`);
  assert.equal(out.sources.find((row) => row.source === 'own_investment').actualYen, sum(expected.ownWorks, (workId) => expected.reference.get(workId).receiptsPeriodYen));
  assert.deepEqual(expected.outrightOwn, []);
  assert.equal(out.notes.some((row) => row.code === 'overlap_outright'), false);
});

test('需給の曲線: 窓口×公開からの月数の平均（和÷観測できた作品の数の切り捨て）で、元の作品数・行数・公開月の出どころを出す', async () => {
  const out = (await compare('admin', requestBody())).body;
  const {plbs} = await expectedOf('admin', ids.allWorks);
  const curve = out.demandCurve;
  assert.equal(curve.definitionVersion, 'demand-curve.2026-10-10');
  const released = plbs.works.filter((row) => row.releaseMonth && row.releaseMonth <= CLOSED);
  assert.deepEqual(curve.releaseSources, {window: released.filter((row) => row.releaseSource === 'window').length, first_sale: released.filter((row) => row.releaseSource !== 'window').length,
    none: plbs.works.filter((row) => !row.releaseMonth).length, after_close: plbs.works.filter((row) => row.releaseMonth > CLOSED).length});
  assert.deepEqual(curve.releases, [...plbs.works].sort((a, b) => a.id - b.id).map((row) => ({workId: row.id, releaseMonth: row.releaseMonth, releaseSource: row.releaseSource})));
  // 営業基幹の節の劇場公開の確定の版から公開月を取る作品（window）と、最初の売上月から取る作品（first_sale）の両方がある
  assert.ok(curve.releaseSources.window > 0 && curve.releaseSources.first_sale > 0 && curve.releaseSources.after_close > 0, JSON.stringify(curve.releaseSources));
  assert.ok(plbs.works.some((work) => work.releaseSource === 'window' && plbs.saleLines.some((row) => row.workId === work.id && row.month >= work.releaseMonth && row.month <= CLOSED)),
    '公開月を劇場公開の確定の版から取った作品の売上が曲線に入る');
  // 公開からの月数ごとの和と、その月数まで観測できた作品の数（平均の分母）が、独立に足した値と全窓口・全月数で一致する
  const expected = expectedCurve(plbs.works, plbs.saleLines, CLOSED);
  assert.deepEqual(curveView(curve), expected);
  assert.ok(curve.lineCount > 0);
  // 月数が進むと観測できる作品が減る窓口がある（分母を窓口の作品数で置き換えると合わない月がある）
  assert.ok(expected.channels.some((row) => row.points.some((p) => p.workCount < row.workCount)));
});

test('制作担当は403で、財務の権限の無い案件の作品・商談・売上は応答（需給の曲線を含む）に入らず、本文で指すと400', async () => {
  const denied = await compare('production', requestBody());
  assert.equal(denied.status, 403);
  assert.equal(denied.body.ok, false);
  assert.match(denied.body.error, /制作担当は見られません/);
  // 編集担当（DEMO-SCN 以外の1案件だけ財務の権限）: 種の商談を指すと400
  const hidden = await compare('editor', requestBody());
  assert.equal(hidden.status, 400);
  assert.match(hidden.body.error, /見えない商談/);
  const response = await compare('editor', requestBody({opportunities: []}));
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400));
  const out = response.body;
  const scope = new Set(ids.otherWorks);
  assert.equal(out.conditions.scope.workCount, ids.otherWorks.length);
  assert.equal(out.workSources.every((row) => scope.has(row.workId)), true);
  assert.equal(out.opportunityList.some((row) => ids.scnOpportunities.includes(row.id)), false);
  assert.equal(out.tables.find((row) => row.name === 'investmentRecovery').rows.some((row) => ids.scnWorks.has(row.workId)), false);
  assert.equal(out.unlinkedReports.count, 0, '種の委託（W1）の未紐付けの報告は見えない');
  assert.equal(out.creators.totalYen, 0, '委託の作品が無いので権利元へ渡る額は0件の和');
  // 見える作品だけで独立に足した値と一致する
  const expected = await expectedOf('editor', ids.otherWorks);
  for (const key of ['committee', 'own_investment', 'acquisition']) {
    const row = out.sources.find((r) => r.source === key);
    assert.deepEqual(pick(row, Object.keys(expected.sources[key])), expected.sources[key], key);
  }
  assert.ok(ids.otherWorks.length > 0 && ids.otherWorks.length < ids.allWorks.length);
  // 需給の曲線: 公開月の一覧は見える作品だけで、和・作品の数・除いた行の件数は見える作品の売上明細だけから足した値と一致する
  assert.deepEqual(out.demandCurve.releases.map((row) => row.workId), [...ids.otherWorks].sort((a, b) => a - b));
  assert.deepEqual(curveView(out.demandCurve), expectedCurve(expected.plbs.works, expected.plbs.saleLines, CLOSED));
  const admin = (await compare('admin', requestBody())).body.demandCurve;
  assert.ok(out.demandCurve.lineCount > 0 && out.demandCurve.lineCount < admin.lineCount, `編集担当 ${out.demandCurve.lineCount}行・管理者 ${admin.lineCount}行`);
});

test('ロールが制作担当なら、案件の権限が編集（財務の権限）でも403で、制作担当は見られないと伝える', async () => {
  // 制作担当として招いた架空の利用者の案件の権限を、DB で編集に変える（ロールだけで止めていることを確かめる）
  identities.productionEdit = await invite('scenario-production-edit@openingnight.invalid', ids.scnProject, 'production');
  await base.run("UPDATE project_memberships SET permission='edit' WHERE org_id=? AND user_id=?", [org.id, identities.productionEdit.user_id]);
  const permissions = await base.all('SELECT permission FROM project_memberships WHERE org_id=? AND user_id=?', [org.id, identities.productionEdit.user_id]);
  assert.deepEqual(permissions.map((row) => row.permission), ['edit']);
  cookies.productionEdit = await login('scenario-production-edit@openingnight.invalid');
  const denied = await compare('productionEdit', requestBody());
  assert.equal(denied.status, 403);
  assert.equal(denied.body.ok, false);
  assert.match(denied.body.error, /制作担当は見られません/);
});

test('同じ入力で同じ sourceHash になり、前提・目標額・記録が変わると変わる。本文を保存せず、目標額は送った応答にだけ入る', async () => {
  const before = await tableCounts(base);
  const first = (await compare('admin', requestBody())).body;
  const second = (await compare('admin', requestBody())).body;
  assert.match(first.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal(second.sourceHash, first.sourceHash);
  const moved = (await compare('admin', requestBody({assumptions: {...fixture.request.assumptions, salesMultiplierBps: 11000}}))).body;
  assert.notEqual(moved.sourceHash, first.sourceHash);
  // 架空の目標額は実行時に不規則な桁で作る（種の期待値は自社出資の回収待ちで負なので、絶対値に足す）
  const targetYen = Math.abs(first.scenarios.standard.expectedYen) + 1234567;
  const withTarget = (await compare('admin', requestBody({targets: {selfYen: targetYen}}))).body;
  assert.notEqual(withTarget.sourceHash, first.sourceHash);
  assert.equal(withTarget.targetView.self.targetYen, targetYen);
  assert.equal(withTarget.targetView.self.scenarios.standard.gapYen, first.scenarios.standard.expectedYen - targetYen);
  assert.equal(Object.hasOwn(first, 'targetView'), false);
  assert.deepEqual(countDifferences(before, await tableCounts(base)), [], '比較は表に何も書かない');
  // 基準は計上で固定（basis を受けない）
  const basis = await compare('admin', requestBody({basis: 'cash'}));
  assert.equal(basis.status, 400);
  assert.equal(basis.body.details.field, 'basis');
  assert.deepEqual(pick(first, ['title', 'basis', 'definitionVersion']), {title: 'シナリオの比較', basis: 'accrual', definitionVersion: 'scenario-stage-a.2026-10-10'});
  assert.deepEqual(first.conditions.actualWindow, {from: PERIOD.from, to: CLOSED});
});

test('足す SQL は作品の数に依らない固定の本数（10本以下）で、権利・分配の試算は分配契約のある作品×7本以下', async () => {
  const measure = async (who, workIds, payload) => {
    counter.n = 0;
    assert.equal((await compare(who, {basis: 'cash'})).status, 400);
    const overhead = counter.n; // 利用者の確かめ（受け口の前）
    counter.n = 0;
    assert.equal((await compare(who, payload)).status, 200);
    const total = counter.n;
    counter.n = 0;
    await loadPlBsInput(db, identities[who], app.ux, {from: PERIOD.from, to: CLOSED, asOf: CLOSED, workIds, includeCompany: false});
    const plbs = counter.n;
    const previewWorks = (await base.all("SELECT DISTINCT work_id FROM settlement_contracts WHERE org_id=? AND contract_type IN ('commission','mg')", [org.id]))
      .map((row) => row.work_id).filter((id) => workIds.includes(id));
    counter.n = 0;
    for (const workId of previewWorks) await app.ux.settlementPreviewData(identities[who], workId);
    const previews = counter.n;
    // 財務の権限の案件を読む1本を除いた残りが、この API が足した SQL
    return {own: total - overhead - 1 - plbs - previews, previews, previewWorks: previewWorks.length};
  };
  const admin = await measure('admin', ids.allWorks, requestBody());
  const editor = await measure('editor', ids.otherWorks, requestBody({opportunities: []}));
  assert.ok(admin.own > 0 && admin.own <= 10, `足した SQL ${admin.own}本`);
  assert.equal(editor.own, admin.own, '作品の数が違っても同じ本数');
  assert.ok(admin.previewWorks > 0 && admin.previews <= admin.previewWorks * 7, `試算 ${admin.previews}本・作品 ${admin.previewWorks}`);
});

test('委託の手数料率が無い分配契約の行（記録の側の誤り）は、応答全体を500にせず、409「記録を読めません」と項目で返す', async () => {
  // 権利・分配の試算が、委託の行の手数料を出せない（null）記録を返す場合を作る（DB の記録は変えない）
  const original = app.ux.settlementPreviewData;
  app.ux.settlementPreviewData = async (identity, workId) => {
    const preview = await original(identity, workId);
    return {...preview, lineResults: preview.lineResults.map((row) => (row.contractType === 'commission' ? {...row, agencyFee: null} : row))};
  };
  try {
    const response = await compare('admin', requestBody());
    assert.equal(response.status, 409, JSON.stringify(response.body).slice(0, 300));
    assert.equal(response.body.ok, false);
    assert.match(response.body.error, /^記録を読めません（facts\.consignment: 委託の手数料率が無い分配契約の行があります（作品 \d+））/);
    assert.equal(response.body.details.field, 'facts.consignment');
  } finally {
    app.ux.settlementPreviewData = original;
  }
  assert.equal((await compare('admin', requestBody())).status, 200);
});

test('MG つきの買付（J-9 (c)）: MG の分配契約に報告を紐付けると、買付は買い切りの販売益から MG の行の手数料に変わり、同じ作品の委託の手数料と権利元へ渡る額には混ざらない', async () => {
  const before = (await compare('admin', requestBody())).body;
  const holder = await db.get("SELECT id FROM partners WHERE org_id=? AND code='DEMO-SCN-RH'", [org.id]);
  const addMg = async (fixtureWorkId, code, mgContractYen, reportKey) => {
    const workId = ids.work(fixtureWorkId);
    const contract = await call('admin', 'POST', '/settlement/contracts', {workId, contractCode: code, title: 'MG つきの買付（架空・確かめ）', contractType: 'mg',
      holderPartnerId: holder.id, mgContractYen, terms: {platformRateBps: 0, agencyFeeBps: 2500, recoupBasis: 'after_fee'}});
    assert.equal(contract.status, 201, JSON.stringify(contract.body));
    const report = await db.get("SELECT id FROM report_imports WHERE org_id=? AND report_key=? AND status='active'", [org.id, reportKey]);
    const link = await call('admin', 'POST', '/settlement/links', {reportId: report.id, workId, contractId: contract.body.contractId, termVersionId: contract.body.versionId, reportBasis: 'net'});
    assert.equal(link.status, 201, JSON.stringify(link.body));
  };
  // 買い切りの W2（配信の報告）と、委託の W1 の未紐付けだったパッケージの報告を MG へ
  await addMg(102, 'DEMO-SCN-MG-W2', 1000000, 'DEMO-SCN-W2-E-2026-07');
  await addMg(101, 'DEMO-SCN-MG-W1', 300000, 'DEMO-SCN-W1-F-2026-07');

  const out = (await compare('admin', requestBody())).body;
  const source = (o, key) => o.sources.find((r) => r.source === key);
  // W2: 買い切りの 税抜売上 185万円（買付額は期間より前に払った扱いで引かない）が、MG の行の手数料 185万円×25%＝46.25万円 に置き換わる。
  // W1: パッケージ 50万円×25%＝12.5万円 が足される
  const w2Outright = 1850000;
  assert.equal(source(out, 'acquisition').actualYen, source(before, 'acquisition').actualYen - w2Outright + 462500 + 125000);
  assert.equal(source(out, 'consignment').actualYen, source(before, 'consignment').actualYen, '同じ作品の MG の行の手数料を委託に混ぜない');
  assert.equal(out.creators.totalYen, before.creators.totalYen, 'MG は権利元へ渡る額（委託の holderAmount）に入れない');
  assert.equal(out.creators.mgReferenceYen, 1300000);
  assert.equal(out.notes.some((r) => r.code === 'mg_balance'), true, 'MG 残は未控除と注記する');
  assert.deepEqual(out.unlinkedReports, {count: 0, amountYen: 0}, 'MG に紐付けた報告は未紐付けに数えない');
  assert.deepEqual([102, 101].map((w) => out.workSources.find((r) => r.workId === ids.work(w)).sources), [['acquisition'], ['acquisition', 'consignment']]);
  // 参考の列: MG の契約額は W2 が100万円・W1 が30万円、MG 残は試算の MG の契約の和
  assert.deepEqual([102, 101].map((w) => out.workSources.find((r) => r.workId === ids.work(w)).mgContractYen), [1000000, 300000]);
  assertReference(out, await expectedOf('admin', ids.allWorks));
});

test('重なり（買い切りの買付）: 自社出資の作品に買付の契約を足しても何も変わらず（D2）、買付額を足すと売上はすべて買付に数え、源泉2 の収益と粗利から入金が外れ、会社の実績は売上を1回だけ数える', async () => {
  const before = (await compare('admin', requestBody())).body;
  const w3 = ids.work(103);
  const contracts = (await call('admin', 'GET', `/work-master/${w3}/contracts`)).body.version;
  const finance = (await call('admin', 'GET', `/work-master/${w3}/finance`)).body.version;
  const contractRows = contracts.rows.map((row) => pick(row, ['contract_key', 'title', 'kind', 'signed_on', 'starts_on', 'ends_on', 'partner_id', 'document_reference']));
  const financeValues = Object.fromEntries(Object.entries(finance).filter(([key]) => key === 'committee_term_version_id' || /^(production_cost|promotion_budget|own_investment|sales_rights_purchase)_/.test(key)));
  assert.equal(contractRows.some((row) => row.kind === 'acquisition'), false, '種の W3 は契約一覧に買付が無い自社出資だけの作品');
  const meta = (baseRevision) => ({baseRevision, source_reference: 'DEMO-SCN-試験（架空）', reason: '買い切りの買付との重なりの確かめ（架空）'});
  const post = async (section, payload) => {
    const response = await call('admin', 'POST', `/work-master/${w3}/${section}`, payload);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.revision;
  };
  // 買付の契約（買い切り）を作品マスタの新しい版で足す（架空）。買付額が無いので買付に入れず（D2）、応答は sourceHash まで元のまま
  const purchaseYen = 500000;
  const contractRevision = await post('contracts', {...meta(contracts.revision), rows: [...contractRows, {contract_key: 'DEMO-SCN-W3-K9', title: '買付の契約（架空・重なりの確かめ）', kind: 'acquisition',
    signed_on: '2026-05-15', starts_on: '2026-06-01', ends_on: '2029-05-31', partner_id: contractRows[0].partner_id, document_reference: 'DEMO-SCN-W3-買付契約書（架空）'}]});
  let financeRevision = finance.revision;
  try {
    const contractOnly = (await compare('admin', requestBody())).body;
    assert.deepEqual(pick(contractOnly.workSources.find((row) => row.workId === w3), ['sources', 'overlap']), {sources: ['own_investment'], overlap: false});
    assert.equal(contractOnly.sourceHash, before.sourceHash, '権利の取得の契約だけでは作品→源泉の対応も実績も変わらない');
    // 買付額 50万円（架空）を、作品マスタの費用の新しい版で足す
    financeRevision = await post('finance', {...meta(finance.revision), ...financeValues, sales_rights_purchase_yen: purchaseYen, sales_rights_purchase_tax_basis: 'ex_tax',
      sales_rights_purchase_status: 'estimated', sales_rights_purchase_as_of: '2026-06-30', sales_rights_purchase_evidence: 'DEMO-SCN-見積書（架空）'});
    const out = (await compare('admin', requestBody())).body;
    const expected = await expectedOf('admin', ids.allWorks);
    assert.deepEqual(pick(out.workSources.find((row) => row.workId === w3), ['sources', 'overlap']), {sources: ['own_investment', 'acquisition'], overlap: true});
    assert.equal(out.overlapCount, before.overlapCount + 1);
    // 源泉ごとの実績が、計画の取り方（買い切りの買付にも入る自社出資の作品は入金を当てない）で独立に足した値と一致する
    const source = (o, key) => o.sources.find((row) => row.source === key);
    for (const key of ['own_investment', 'committee', 'acquisition', 'consignment']) {
      assert.deepEqual(pick(source(out, key), Object.keys(expected.sources[key])), expected.sources[key], key);
    }
    // W3 の期間内の入金（税込 220万円）は源泉2 の収益と粗利から外れ、期間内の税抜売上が源泉4 に入る（買付額は期間より前に払った扱いで引かない。D1）
    const receiptsPeriod = expected.reference.get(w3).receiptsPeriodYen;
    const salesPeriod = expected.acquisitionRows.find((row) => row.workId === w3).sales;
    assert.deepEqual([receiptsPeriod, salesPeriod], [2200000, 2000000]);
    assert.deepEqual([source(out, 'own_investment').actualYen, source(out, 'own_investment').actualSalesYen],
      [source(before, 'own_investment').actualYen - receiptsPeriod, source(before, 'own_investment').actualSalesYen - receiptsPeriod]);
    assert.deepEqual([source(out, 'acquisition').actualYen, source(out, 'acquisition').actualSalesYen],
      [source(before, 'acquisition').actualYen + salesPeriod, source(before, 'acquisition').actualSalesYen + salesPeriod]);
    // 期待値は源泉ごとの実績の和（独立に足した値）を超えない。会社の売上の実績は W3 の売上を1回だけ数える（入金 220万円が外れ、売上 200万円が入る）
    const standard = out.scenarios.standard;
    const independent = (field) => sum(['own_investment', 'committee', 'acquisition', 'consignment'], (key) => expected.sources[key][field] ?? 0);
    assert.deepEqual([standard.actualYen, standard.actualSalesYen], [independent('actualYen'), independent('actualSalesYen')]);
    assert.equal(standard.expectedYen, standard.actualYen + standard.weightedYen + standard.actionYen);
    assert.equal(standard.actualSalesYen - before.scenarios.standard.actualSalesYen, salesPeriod - receiptsPeriod);
    assert.equal(standard.expectedYen - before.scenarios.standard.expectedYen, salesPeriod - receiptsPeriod);
    // 出資の回収の W3 の収益も0円（回収待ち）。注記に、入金を当てなかった作品の件数
    const row = out.tables.find((r) => r.name === 'investmentRecovery').rows.find((r) => r.workId === w3);
    assert.deepEqual(pick(row, ['investmentYen', 'revenueYen', 'diffYen', 'status']), {investmentYen: 4000000, revenueYen: 0, diffYen: -4000000, status: 'awaiting'});
    assert.ok(expected.outrightOwn.includes(w3));
    assert.match(out.notes.find((note) => note.code === 'overlap_outright').text, new RegExp(`自社出資の作品 ${expected.outrightOwn.length}件は、売上をすべて買付に数え`));
  } finally {
    // 元の契約一覧と費用に戻す（新しい版を足す）。次の試験は W3 を自社出資だけの作品として使う
    await post('contracts', {...meta(contractRevision), rows: contractRows});
    if (financeRevision !== finance.revision) await post('finance', {...meta(financeRevision), ...financeValues});
  }
  assert.equal((await compare('admin', requestBody())).body.sourceHash, before.sourceHash, '元の版の値に戻すと、実績も元に戻る');
});

test('重なり: 自社出資の作品に委託契約を足して報告を紐付けると、出資の回収の収益から紐付いた報告の入金が外れ、委託の手数料と権利元へ渡る額に入る', async () => {
  const before = (await compare('admin', requestBody())).body;
  const w3 = ids.work(103);
  const holder = await db.get("SELECT id FROM partners WHERE org_id=? AND code='DEMO-SCN-RH'", [org.id]);
  const contract = await call('admin', 'POST', '/settlement/contracts', {workId: w3, contractCode: 'DEMO-SCN-COM-W3', title: '販売委託の手数料（架空・重なりの確かめ）',
    contractType: 'commission', holderPartnerId: holder.id, terms: {platformRateBps: 0, agencyFeeBps: 2000}});
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  const report = await db.get("SELECT id FROM report_imports WHERE org_id=? AND report_key='DEMO-SCN-W3-G-2026-07' AND status='active'", [org.id]);
  const link = await call('admin', 'POST', '/settlement/links', {reportId: report.id, workId: w3, contractId: contract.body.contractId, termVersionId: contract.body.versionId, reportBasis: 'net'});
  assert.equal(link.status, 201, JSON.stringify(link.body));

  const out = (await compare('admin', requestBody())).body;
  assert.notEqual(out.sourceHash, before.sourceHash, '記録が変わると hash が変わる');
  assert.deepEqual(pick(out.workSources.find((row) => row.workId === w3), ['workId', 'sources', 'overlap', 'title']), {workId: w3, sources: ['own_investment', 'consignment'], overlap: true, title: '坂の上の写真館（架空）'});
  // 参考の列の入金は、紐付けを問わない作品の入金の全部（出資の回収の収益とは違い、紐付いた報告の入金も入る）
  assert.equal(out.workSources.find((row) => row.workId === w3).receiptsTotalYen, 2200000);
  assertReference(out, await expectedOf('admin', ids.allWorks));
  assert.equal(out.overlapCount, before.overlapCount + 1);
  // W3 の入金（220万円）は紐付いた報告の分だけなので、出資の回収の収益は0円（0円で埋めたのではなく、紐付かない入金の和）
  const row = out.tables.find((r) => r.name === 'investmentRecovery').rows.find((r) => r.workId === w3);
  assert.deepEqual(pick(row, ['investmentYen', 'revenueYen', 'diffYen', 'recoveryRateBps', 'status']), {investmentYen: 4000000, revenueYen: 0, diffYen: -4000000, recoveryRateBps: 0, status: 'awaiting'});
  const source = (o, key) => o.sources.find((r) => r.source === key);
  assert.equal(source(out, 'own_investment').actualYen, source(before, 'own_investment').actualYen - 2200000);
  // 委託の手数料（W3 の 2026-07 の税抜売上 200万円×20%＝40万円）と、権利元へ渡る額（160万円）が増える
  const preview = await app.ux.settlementPreviewData(identities.admin, w3);
  const lines = preview.lineResults.filter((r) => r.contractType === 'commission' && inWindow(r.accountingMonth));
  assert.deepEqual([sum(lines, (r) => r.agencyFee), sum(lines, (r) => r.holderAmount)], [400000, 1600000]);
  assert.equal(source(out, 'consignment').actualYen, source(before, 'consignment').actualYen + 400000);
  assert.equal(out.creators.totalYen, before.creators.totalYen + 1600000);
});

test('重なり（委員会。D3）: 委員会の作品に委託契約を足すと、取得額を契約の分と分けられないので源泉3の実績に入れず未確定に数え、注記に件数を出す。出資の回収の行は変えない', async () => {
  const before = (await compare('admin', requestBody())).body;
  const w4 = ids.work(104);
  const holder = await db.get("SELECT id FROM partners WHERE org_id=? AND code='DEMO-SCN-RH'", [org.id]);
  const contract = await call('admin', 'POST', '/settlement/contracts', {workId: w4, contractCode: 'DEMO-SCN-COM-W4', title: '販売委託の手数料（架空・重なりの確かめ）',
    contractType: 'commission', holderPartnerId: holder.id, terms: {platformRateBps: 0, agencyFeeBps: 2000}});
  assert.equal(contract.status, 201, JSON.stringify(contract.body));
  const out = (await compare('admin', requestBody())).body;
  const expected = await expectedOf('admin', ids.allWorks);
  assert.deepEqual(pick(out.workSources.find((row) => row.workId === w4), ['sources', 'overlap']), {sources: ['committee', 'consignment'], overlap: true});
  const committee = (o) => o.sources.find((row) => row.source === 'committee');
  assert.deepEqual(pick(committee(out), Object.keys(expected.sources.committee)), expected.sources.committee);
  const w4Facts = fixture.facts.committee.find((row) => row.workId === 104);
  assert.deepEqual([committee(out).actualYen, committee(out).rowCount, committee(out).unknownCount],
    [committee(before).actualYen - (w4Facts.acquisitionsPeriodYen - w4Facts.paymentsPeriodYen), committee(before).rowCount - 1, committee(before).unknownCount + 1]);
  assert.match(out.notes.find((row) => row.code === 'overlap_committee').text, /製作委員会の作品 1件は、取得額を契約の分と分けられない/);
  const recovery = (o) => o.tables.find((row) => row.name === 'investmentRecovery').rows.find((row) => row.workId === w4);
  assert.deepEqual(recovery(out), recovery(before));
});
