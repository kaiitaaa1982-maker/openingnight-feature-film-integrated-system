// 商品別の放送ウィンドウ提案の計算（純関数）。期待値はこの試験の中で日付を書き下して照合する（モデルの区間計算を使わない）。
// 壊れたら: 独占中の期間を提案して二重に売る・権利の切れた後を提案する・ホールドバック中に他局へ出す・放送解禁が未定なのに期間を出す。
import test from 'node:test';
import assert from 'node:assert/strict';
import {proposeWindow, recentStations, proposalSummary, proposalRow} from '../src/broadcast/window-proposal-model.mjs';
import {subtract, intersectLists, normalize, addMonthsDate, shorterThanMonths, addDays, monthsPeriodEnd} from '../src/broadcast/intervals.mjs';

const asOf = '2026-09-26';
const rights = [{channel: '放送', territory: '日本', rights_start: '2024-01-01', rights_end: '2031-12-31'}];
const release = [{territory: '日本', start_on: '2026-10-01', end_on: '2030-03-31', date_precision: 'day', status: 'confirmed'}];
const P = {id: 10, sku: 'W01-TV', name: '放送権'};
const entry = (id, extra) => ({entry_id: id, partner_id: id, partner_name: `局${id}`, partner_code: `TV-${id}`, product_id: null, territory: '日本', status: 'contracted', end_rule: 'date', exclusivity: 'nonexclusive', ...extra});
const periods = (list) => list.map((p) => [p.from, p.to]);

test('区間の計算: 重なり・引き算・隣り合う区間の連結・月末とうるう日の月の足し算', () => {
  assert.deepEqual(normalize([{from: '2026-01-01', to: '2026-01-31'}, {from: '2026-02-01', to: '2026-02-10'}]), [{from: '2026-01-01', to: '2026-02-10'}]);
  assert.deepEqual(subtract([{from: '2026-01-01', to: '2026-12-31'}], [{from: '2026-03-01', to: '2026-03-31'}]), [{from: '2026-01-01', to: '2026-02-28'}, {from: '2026-04-01', to: '2026-12-31'}]);
  assert.deepEqual(subtract([{from: '2026-01-01', to: null}], [{from: '2026-06-01', to: null}]), [{from: '2026-01-01', to: '2026-05-31'}], '終わりなしの独占は後ろを全部塞ぐ');
  assert.deepEqual(intersectLists([{from: null, to: '2027-03-31'}], [{from: '2026-10-01', to: null}]), [{from: '2026-10-01', to: '2027-03-31'}]);
  assert.equal(addMonthsDate('2028-02-29', 24), '2030-02-28', 'うるう日の24か月後は2月の末日');
  assert.equal(addMonthsDate('2027-01-31', 1), '2027-02-28');
  assert.equal(shorterThanMonths({from: '2026-10-01', to: '2026-12-30'}, 3), true);
  assert.equal(shorterThanMonths({from: '2026-10-01', to: '2026-12-31'}, 3), false, 'ちょうど3か月は短くない');
});

test('放送してよい期間は 権利∩放送の解禁∩基準日から24か月 で、独占の契約の期間は塞がって提案が2つに分かれる', () => {
  const r = proposeWindow({asOf, product: P, rights, releaseWindows: release,
    entries: [entry(1, {exclusivity: 'exclusive', contract_start: '2027-01-01', contract_end: '2027-06-30'})]});
  assert.equal(r.state, 'ok');
  assert.deepEqual(periods(r.allowed), [['2026-10-01', '2028-09-26']], '基準日 2026-09-26 の24か月後まで');
  assert.deepEqual(periods(r.proposals), [['2026-10-01', '2026-12-31'], ['2027-07-01', '2028-09-26']]);
  assert.equal(r.proposals[0].short, false);
  assert.deepEqual(r.blocked.map((b) => [b.kind, b.station, b.from, b.to]), [['exclusive', '局1', '2027-01-01', '2027-06-30']]);
  assert.match(proposalSummary(r), /^放送可：2026年10月1日〜2026年12月31日 ほか1区間／独占契約中：〜2027年6月30日（局1）$/);
});

test('権利の終わりが早いと放送してよい期間が短くなり、短い区間には「短い」を付ける', () => {
  const r = proposeWindow({asOf, product: P, rights: [{channel: '全媒体', territory: '日本', rights_start: '2024-01-01', rights_end: '2026-11-30'}], releaseWindows: release});
  assert.deepEqual(periods(r.proposals), [['2026-10-01', '2026-11-30']]);
  assert.equal(r.proposals[0].short, true, '2か月は3か月未満');
  // 配信だけの権利・地域が海外の権利は数えない
  const none = proposeWindow({asOf, product: P, rights: [{channel: '配信', territory: '日本', rights_start: '2024-01-01'}, {channel: '放送', territory: '北米', rights_start: '2024-01-01'}], releaseWindows: release});
  assert.equal(none.state, 'blocked');
  assert.deepEqual(none.proposals, []);
  assert.match(none.reasons[0], /^権利範囲が未登録/);
  assert.match(proposalSummary(none), /^要確認：権利範囲が未登録/);
});

test('ホールドバックは契約の終了日の翌日から N か月を塞ぎ、非独占の契約と他局の枠は「同時期の他局」に出す', () => {
  const terms = new Map([[2, {licensed_runs: 3, holdback_months: 3}]]);
  const slots = [{slot_id: 1, work_id: 1, broadcast_month: '2027-09', station_name: '局9', status: 'tentative', period_from: '2027-09-01', period_to: '2027-09-30'}];
  const r = proposeWindow({asOf, product: P, rights, releaseWindows: release, terms, slots,
    entries: [entry(2, {contract_start: '2026-10-01', contract_end: '2027-03-31'})]});
  assert.deepEqual(r.blocked.map((b) => [b.kind, b.from, b.to, b.months]), [['holdback', '2027-04-01', '2027-06-30', 3]]);
  assert.deepEqual(periods(r.proposals), [['2026-10-01', '2027-03-31'], ['2027-07-01', '2028-09-26']]);
  assert.deepEqual(r.proposals[0].others.map((o) => [o.station, o.kind]), [['局2', 'nonexclusive']], '非独占は塞がない');
  assert.deepEqual(r.proposals[1].others.map((o) => [o.station, o.kind]), [['局9', 'slot']], '仮押さえの他局の枠');
  assert.deepEqual(r.licenses.map((l) => [l.station, l.licensed, l.used, l.remaining, l.holdbackMonths]), [['局2', 3, 0, 3, 3]]);
});

test('放送の解禁が未定・未登録なら提案を出さない', () => {
  const tbd = proposeWindow({asOf, product: P, rights, releaseWindows: [{territory: '日本', start_on: null, date_precision: 'tbd', timing_raw: '未定', status: 'draft'}]});
  assert.equal(tbd.state, 'blocked');
  assert.deepEqual(tbd.proposals, []);
  assert.ok(tbd.reasons.includes('放送の解禁が未定（未定）'));
  const none = proposeWindow({asOf, product: P, rights, releaseWindows: []});
  assert.ok(none.reasons.includes('放送の解禁が未登録（全作品のウィンドウの放送）'));
  const withdrawn = proposeWindow({asOf, product: P, rights, releaseWindows: [{...release[0], status: 'withdrawn'}]});
  assert.equal(withdrawn.state, 'blocked', '取り下げのウィンドウは数えない');
});

test('うるう日と月末: 月までの解禁は月初から、2/29 に終わる契約の1か月のホールドバックは3月末まで', () => {
  const leapAsOf = '2028-02-29';
  const r = proposeWindow({asOf: leapAsOf, product: P, rights, releaseWindows: [{territory: '日本', start_on: '2028-02', end_on: '2031-12', date_precision: 'month', status: 'confirmed'}],
    terms: new Map([[3, {holdback_months: 1}]]), entries: [entry(3, {exclusivity: 'exclusive', contract_start: '2027-03-01', contract_end: '2028-02-29'})]});
  assert.deepEqual(r.blocked.map((b) => [b.kind, b.from, b.to]), [['exclusive', '2027-03-01', '2028-02-29'], ['holdback', '2028-03-01', '2028-03-31']]);
  assert.deepEqual(periods(r.proposals), [['2028-04-01', '2030-02-28']], '基準日 2028-02-29 の24か月後は 2030-02-28');
});

test('独占の契約: 商品の指定がある明細はその商品だけを塞ぎ、自動更新・期限なしは終わりなし、終わり方未確認は要確認', () => {
  const other = {id: 11, sku: 'W01-TV2'};
  const exclusiveForOther = entry(4, {exclusivity: 'exclusive', product_id: other.id, contract_start: '2026-10-01', contract_end: '2027-09-30'});
  assert.equal(proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [exclusiveForOther]}).proposals[0].from, '2026-10-01', '別の商品の独占は塞がない');
  assert.equal(proposeWindow({asOf, product: other, rights, releaseWindows: release, entries: [exclusiveForOther]}).proposals[0].from, '2027-10-01');
  const renew = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(5, {exclusivity: 'exclusive', contract_start: '2027-04-01', contract_end: '2028-03-31', end_rule: 'auto_renew'})]});
  assert.deepEqual(periods(renew.proposals), [['2026-10-01', '2027-03-31']], '自動更新は終わりなし');
  const unknown = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(6, {exclusivity: 'exclusive', contract_start: '2027-04-01', end_rule: 'unknown'})]});
  assert.ok(unknown.reasons.some((r) => r.startsWith('独占の契約の終わり方が未確認（局6')));
  const planned = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(7, {exclusivity: 'exclusive', status: 'planned', contract_start: '2026-10-01', contract_end: '2028-09-30'})]});
  assert.equal(planned.state, 'full', '予定の独占も塞ぐ');
  assert.match(proposalSummary(planned), /独占契約中：〜2028年9月30日（局7・予定）/);
  const withdrawn = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(8, {exclusivity: 'exclusive', status: 'withdrawn', contract_start: '2026-10-01', contract_end: '2028-09-30'})]});
  assert.equal(withdrawn.state, 'ok', '取り下げの明細は数えない');
});

test('商品別の窓があればそれで絞り、無ければ作品共通の販売条件、どちらも無ければ絞らない（未確定は数えない）', () => {
  const productWindows = [{territory: '日本', release_on: '2027-01-01', sales_end_on: '2027-12-31', status: 'confirmed'}];
  const conditions = [{territory: '日本', release_on: '2026-12-01', sales_end_on: '2028-03-31', status: 'confirmed'}];
  assert.deepEqual(periods(proposeWindow({asOf, product: P, rights, releaseWindows: release, productWindows, conditions}).proposals), [['2027-01-01', '2027-12-31']]);
  assert.deepEqual(periods(proposeWindow({asOf, product: P, rights, releaseWindows: release, conditions}).proposals), [['2026-12-01', '2028-03-31']]);
  const draft = proposeWindow({asOf, product: P, rights, releaseWindows: release, productWindows: [{...productWindows[0], status: 'draft'}]});
  assert.deepEqual(periods(draft.proposals), [['2026-10-01', '2028-09-26']]);
  assert.ok(draft.reasons.some((r) => r.startsWith('商品別の販売ウィンドウが未確定（日本。確認済みの版なし・作品・商品マスタで確かめてください）')), draft.reasons.join('／'));
  assert.ok(draft.basis.includes('販売条件: 確認済みの版なし（絞らない・要確認）'));
});

test('初回／再放送と直近の放送局（確定と実放送だけ・予定と一部予定・仮押さえは数えない）', () => {
  const slots = [
    {slot_id: 1, work_id: 1, broadcast_month: '2025-12', station_name: '局A', status: 'confirmed'}, {slot_id: 2, work_id: 1, broadcast_month: '2026-01', station_name: '局A', status: 'confirmed'},
    {slot_id: 3, work_id: 1, broadcast_month: '2026-02', station_name: '局Ａ', status: 'confirmed'},
    {slot_id: 4, work_id: 1, broadcast_month: '2026-09', station_name: '局B', status: 'confirmed'}, {slot_id: 5, work_id: 1, broadcast_month: '2026-10', station_name: '局B', status: 'confirmed'},
    {slot_id: 6, work_id: 1, broadcast_month: '2027-01', station_name: '局C', status: 'confirmed'},
    {slot_id: 7, work_id: 1, broadcast_month: '2027-02', station_name: '局D', status: 'tentative'},
    {slot_id: 8, work_id: 1, broadcast_month: '2024-05', station_name: '局E', status: 'confirmed'},
  ];
  const airings = [{slot_id: 1, aired_on: '2025-12-10', run_count: 1}, {slot_id: 4, aired_on: '2026-09-05', run_count: 2}];
  const recent = recentStations({slots, airings, asOf});
  assert.deepEqual(recent.map((r) => [r.stationText, r.historyText]), [
    ['局C（予定）', '2027年1月（予定） 局C様'],
    ['局B', '2026年9月～2026年10月（一部予定） 局B様'],
    ['局A', '2025年12月～2026年2月 局A様'],
  ], '最新の月の新しい順・3局まで・仮押さえの局Dは数えない・全角半角の局Aは1局');
  const r = proposeWindow({asOf, product: P, rights, releaseWindows: release, slots, airings});
  assert.equal(r.proposals[0].run, '再放送');
  assert.equal(proposeWindow({asOf, product: P, rights, releaseWindows: release}).proposals[0].run, '初回');
  const row = proposalRow({work: {id: 1, code: 'W01', title: '一'}, product: P, result: r});
  assert.match(row.recent_text, /^2027年1月（予定） 局C様\n/);
  assert.equal(row.proposal_text, '2026/10/01〜2028/09/26');
});

test('許諾回数の残りは、その局・その契約期間の実放送から数え、超えたら要確認にする', () => {
  const slots = [{slot_id: 1, work_id: 1, broadcast_month: '2026-11', station_name: '局1', status: 'confirmed'}, {slot_id: 2, work_id: 1, broadcast_month: '2026-12', station_name: '局１', status: 'confirmed'}];
  const airings = [{slot_id: 1, aired_on: '2026-11-03', run_count: 2}, {slot_id: 2, aired_on: '2026-12-03', run_count: 1}];
  const r = proposeWindow({asOf, product: P, rights, releaseWindows: release, slots, airings, terms: new Map([[1, {licensed_runs: 2, holdback_months: null}]]),
    entries: [entry(1, {contract_start: '2026-10-01', contract_end: '2027-09-30'})]});
  assert.deepEqual(r.licenses.map((l) => [l.licensed, l.used, l.remaining]), [[2, 3, -1]]);
  assert.ok(r.reasons.includes('許諾回数を超えて放送している（局1・2回に対し3回）'));
});

// ---------- 見直しで足した試験 ----------
test('9999-12-31（終わりなしの番兵）で終わる明細: 日付は 9999-12-31 で止まり、ホールドバックを付けても例外にならず終わりなしとして扱う', () => {
  assert.equal(addDays('9999-12-31', 1), '9999-12-31');
  assert.equal(addMonthsDate('9999-11-30', 3), '9999-12-31');
  assert.equal(monthsPeriodEnd('9999-12-01', 3), '9999-12-31');
  assert.deepEqual(normalize([{from: '2024-01-01', to: '9999-12-31'}, {from: '2025-01-01', to: '2026-12-31'}]), [{from: '2024-01-01', to: '9999-12-31'}], '重なった区間は1つにつながる');
  const terms = new Map([[1, {holdback_months: 3}]]);
  const nonExclusive = proposeWindow({asOf, product: P, rights, releaseWindows: release, terms, entries: [entry(1, {contract_start: '2026-10-01', contract_end: '9999-12-31'})]});
  assert.deepEqual(nonExclusive.blocked, [], '終わりなしなのでホールドバックは付かない');
  const exclusive = proposeWindow({asOf, product: P, rights, releaseWindows: release, terms, entries: [entry(1, {exclusivity: 'exclusive', contract_start: '2026-10-01', contract_end: '9999-12-31'})]});
  assert.deepEqual(exclusive.blocked.map((b) => [b.kind, b.from, b.to]), [['exclusive', '2026-10-01', null]]);
  assert.deepEqual(exclusive.proposals, []);
  assert.doesNotThrow(() => proposeWindow({asOf, product: P, rights, releaseWindows: release, terms, entries: [entry(1, {contract_start: '2026-10-01', contract_end: '9999-10-31'})]}));
});

test('ホールドバックは終了日の翌日から N か月（応当日の前日、応当日が無ければその月の末日）。短い区間も同じ数え方', () => {
  for (const [from, n, end] of [['2027-01-31', 1, '2027-02-28'], ['2027-01-29', 1, '2027-02-28'], ['2028-01-30', 1, '2028-02-29'], ['2027-02-01', 1, '2027-02-28'], ['2026-10-01', 3, '2026-12-31'], ['2027-04-01', 3, '2027-06-30']]) {
    assert.equal(monthsPeriodEnd(from, n), end, `${from} から ${n}か月`);
  }
  const terms = (months) => new Map([[1, {holdback_months: months}]]);
  const hold = (contractEnd, months) => proposeWindow({asOf, product: P, rights, releaseWindows: release, terms: terms(months), entries: [entry(1, {contract_start: '2026-10-01', contract_end: contractEnd})]});
  for (const [contractEnd, months, blockedTo, next] of [['2027-01-30', 1, '2027-02-28', '2027-03-01'], ['2027-03-30', 1, '2027-04-30', '2027-05-01'], ['2026-08-30', 6, '2027-02-28', '2027-03-01']]) {
    const r = hold(contractEnd, months);
    const block = r.blocked.find((b) => b.kind === 'holdback');
    assert.deepEqual([block.from, block.to], [monthsPeriodEnd(contractEnd, 0) === contractEnd ? block.from : block.from, blockedTo], `${contractEnd}・${months}か月`);
    assert.ok(r.proposals.some((p) => p.from === next), `${contractEnd}・${months}か月の後は ${next} から提案: ${JSON.stringify(r.proposals)}`);
  }
  assert.equal(shorterThanMonths({from: '2027-01-31', to: '2027-04-29'}, 3), true);
  assert.equal(shorterThanMonths({from: '2027-01-31', to: '2027-04-30'}, 3), false);
  assert.equal(shorterThanMonths({from: '2027-11-30', to: '2028-02-28'}, 3), true);
  // 網羅: 2年分の毎日 × 1・2・3・6・12か月を、試験の中で別に書いた式（応当日が無ければ末日、あれば前日）と比べる
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 11, 31); t += 86400000) {
    const date = new Date(t);
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
    for (const n of [1, 2, 3, 6, 12]) {
      const index = y * 12 + (m - 1) + n, ty = Math.floor(index / 12), tm = (index % 12) + 1;
      const expected = d > lastDay(ty, tm) ? iso(ty, tm, lastDay(ty, tm)) : new Date(Date.UTC(ty, tm - 1, d) - 86400000).toISOString().slice(0, 10);
      assert.equal(monthsPeriodEnd(iso(y, m, d), n), expected, `${iso(y, m, d)} + ${n}`);
    }
  }
});

test('販売条件の最新の版が取り下げなら販売しない（提案なし・要確認）、改訂中の下書きなら直前の確認済みの期間で計算する', () => {
  const confirmed = {work_id: 1, distribution_code: 'B001', territory: '日本', release_on: '2026-10-01', sales_end_on: '2027-03-31', status: 'confirmed'};
  const withdrawnWork = proposeWindow({asOf, product: P, rights, releaseWindows: release, conditions: [{...confirmed, status: 'withdrawn', release_on: null, sales_end_on: null}], confirmedConditions: [confirmed]});
  assert.deepEqual([withdrawnWork.state, withdrawnWork.proposals.length], ['blocked', 0]);
  assert.ok(withdrawnWork.reasons.some((r) => r.includes('作品共通の販売条件が取り下げ（B001・日本。販売しない）')), withdrawnWork.reasons.join());
  assert.ok(!withdrawnWork.basis.some((b) => b.includes('登録なし')));
  assert.match(proposalSummary(withdrawnWork), /^要確認：.*取り下げ/);
  // 商品別の販売ウィンドウの取り下げは、作品共通の確認済みより優先する
  const product = {work_id: 1, product_id: 10, distribution_code: 'B001', territory: '日本', window_key: 'main', release_on: null, sales_end_on: null, status: 'withdrawn'};
  const withdrawnProduct = proposeWindow({asOf, product: P, rights, releaseWindows: release, productWindows: [product], conditions: [confirmed], confirmedConditions: [confirmed]});
  assert.equal(withdrawnProduct.state, 'blocked');
  assert.ok(withdrawnProduct.reasons.some((r) => r.startsWith('商品別の販売ウィンドウが取り下げ')));
  // 作品共通の最新が改訂中の下書き → 直前の確認済み（2026-10-01〜2027-03-31）で計算し、要確認に出す
  const revising = proposeWindow({asOf, product: P, rights, releaseWindows: release, conditions: [{...confirmed, status: 'draft', sales_end_on: '2029-03-31'}], confirmedConditions: [confirmed]});
  assert.deepEqual(periods(revising.proposals), [['2026-10-01', '2027-03-31']]);
  assert.ok(revising.reasons.some((r) => r.includes('未確定の版がある') && r.includes('2026/10/01〜2027/03/31')), revising.reasons.join());
  // 確認済みの版が一度も無い下書きだけ → 絞らずに24か月いっぱい、要確認に出す
  const draftOnly = proposeWindow({asOf, product: P, rights, releaseWindows: release, conditions: [{...confirmed, status: 'draft'}]});
  assert.deepEqual(periods(draftOnly.proposals), [['2026-10-01', '2028-09-26']]);
  assert.ok(draftOnly.reasons.some((r) => r.startsWith('作品共通の販売条件が未確定')));
  assert.equal(draftOnly.timeline.lanes.find((l) => l.key === 'condition').bars[0].label, '絞らない');
  assert.deepEqual(withdrawnWork.timeline.lanes.find((l) => l.key === 'condition').bars, [], '取り下げは空の帯');
});

test('空きなしの一文は独占とホールドバックの両方を書き、放送してよい期間が無いときもそう書く', () => {
  const terms = new Map([[1, {holdback_months: 6}]]);
  const full = proposeWindow({asOf: '2026-09-25', product: P, rights, releaseWindows: [{...release[0], start_on: '2026-04-01', end_on: '2027-08-31'}], terms,
    entries: [entry(1, {exclusivity: 'exclusive', contract_start: '2026-04-01', contract_end: '2027-03-31'})]});
  assert.equal(full.state, 'full');
  assert.match(proposalSummary(full), /^空きなし（24か月以内）：独占契約中：〜2027年3月31日（局1）／ホールドバック：〜2027年9月30日（局1）$/);
  const exclusiveOnly = proposeWindow({asOf: '2026-09-25', product: P, rights, releaseWindows: [{...release[0], start_on: '2026-04-01', end_on: '2027-03-31'}],
    entries: [entry(1, {exclusivity: 'exclusive', contract_start: '2026-04-01', contract_end: '2027-03-31'})]});
  assert.match(proposalSummary(exclusiveOnly), /^空きなし（24か月以内）/);
  // 非独占の契約（〜2026-09-24）のホールドバック6か月（2026-09-25〜2027-03-24）だけで空きが無い
  const holdbackOnly = proposeWindow({asOf: '2026-09-25', product: P, rights, releaseWindows: [{...release[0], start_on: '2026-04-01', end_on: '2027-03-24'}], terms,
    entries: [entry(1, {contract_start: '2026-04-01', contract_end: '2026-09-24'})]});
  assert.equal(holdbackOnly.state, 'full');
  assert.match(proposalSummary(holdbackOnly), /ホールドバック：/);
  assert.doesNotMatch(proposalSummary(holdbackOnly), /独占契約中/);
  const outside = proposeWindow({asOf, product: P, rights: [{channel: '放送', territory: '日本', rights_start: '2020-01-01', rights_end: '2025-12-31'}], releaseWindows: release});
  assert.equal(proposalSummary(outside), '空きなし（24か月以内）：放送してよい期間なし');
});

test('独占かどうか未確認の契約は塞がずに計算し、要確認・一文・時間軸に「独占未確認」と出す', () => {
  const r = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(9, {exclusivity: 'unknown', contract_start: '2026-10-01', contract_end: '2027-12-31'})]});
  assert.deepEqual(periods(r.proposals), [['2026-10-01', '2028-09-26']], '非独占と同じく塞がない');
  assert.ok(r.reasons.some((text) => text.startsWith('独占かどうか未確認の契約（局9')), r.reasons.join());
  assert.match(proposalSummary(r), /独占未確認：〜2027年12月31日（局9）/);
  const others = r.timeline.lanes.find((l) => l.key === 'others').bars.map((b) => b.label);
  assert.ok(others.some((label) => label.includes('（独占未確認）')) && !others.some((label) => label.includes('非独占')), others.join());
  const noStart = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(9, {exclusivity: null, contract_start: null, contract_end: null})]});
  assert.ok(noStart.reasons.some((text) => text.startsWith('独占かどうか未確認の契約の開始日が未登録（局9')));
});

test('権利範囲の開始日・終了日が空欄なら、始まり・終わりなしとして計算し、要確認と一文に出す', () => {
  const noEnd = proposeWindow({asOf, product: P, rights: [{channel: '放送', territory: '日本', rights_start: '2024-01-01', rights_end: null}], releaseWindows: release});
  assert.equal(noEnd.state, 'ok');
  assert.deepEqual(periods(noEnd.proposals), [['2026-10-01', '2028-09-26']]);
  assert.ok(noEnd.reasons.some((r) => /権利範囲の終了日が未入力/.test(r)));
  assert.match(proposalSummary(noEnd), /要確認/);
  const noStart = proposeWindow({asOf, product: P, rights: [{channel: '放送', territory: '日本', rights_start: null, rights_end: '2031-12-31'}], releaseWindows: release});
  assert.ok(noStart.reasons.some((r) => /権利範囲の開始日が未入力/.test(r)));
  const joined = proposeWindow({asOf, product: P, releaseWindows: release, rights: [{channel: '放送', territory: '日本', rights_start: '2024-01-01', rights_end: '2026-12-31'}, {channel: '放送', territory: '日本', rights_start: '2027-01-01', rights_end: null}]});
  assert.ok(joined.reasons.some((r) => /終了日が未入力/.test(r)), 'つながった後でも理由を出す');
  assert.ok(!proposeWindow({asOf, product: P, rights, releaseWindows: release}).reasons.some((r) => /未入力/.test(r)), '日付がそろった権利では出さない');
});

test('同時期の他局に数える放送枠は申請中〜確定だけ（下書き・差し戻し・中止は数えない）。一文の先頭の区間が短ければ「（短い）」', () => {
  for (const status of ['draft', 'rejected', 'cancelled', 'pending_first', 'tentative', 'pending_final', 'confirmed']) {
    const slots = [{slot_id: 1, work_id: 1, broadcast_month: '2027-01', station_name: '局9', status, period_from: '2027-01-01', period_to: '2027-01-31'}];
    const r = proposeWindow({asOf, product: P, rights, releaseWindows: release, slots});
    const active = ['pending_first', 'tentative', 'pending_final', 'confirmed'].includes(status);
    assert.deepEqual(r.proposals[0].others.map((o) => [o.station, o.kind]), active ? [['局9', 'slot']] : [], status);
    assert.equal(/（同時期に他局あり）/.test(proposalSummary(r)), active, status);
    assert.equal(r.timeline.lanes.find((l) => l.key === 'others').bars.length, active ? 1 : 0, status);
    assert.equal(proposalRow({work: {id: 1, code: 'W', title: 'W'}, product: P, result: r}).others_text === '', !active, status);
  }
  const short = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(9, {exclusivity: 'exclusive', contract_start: '2026-10-15', contract_end: '2027-09-30'})]});
  assert.match(proposalSummary(short), /^放送可：2026年10月1日〜2026年10月14日（短い） ほか1区間／独占契約中：〜2027年9月30日（局9）$/);
  const shortOnly = proposeWindow({asOf, product: P, rights: [{channel: '放送', territory: '日本', rights_start: '2024-01-01', rights_end: '2026-11-30'}], releaseWindows: release});
  assert.match(proposalSummary(shortOnly), /^放送可：2026年10月1日〜2026年11月30日（短い）$/);
});

test('許諾回数の行に取引先とリストを持たせる（入力する場所へ移るため）', () => {
  const r = proposeWindow({asOf, product: P, rights, releaseWindows: release, entries: [entry(3, {contract_start: '2026-10-01', contract_end: '2027-03-31', list_id: 7})]});
  assert.deepEqual([r.licenses[0].partnerId, r.licenses[0].listId], [3, 7]);
});

// 提案から作った下書きの要確認（broadcast-windows-routes.mjs の draftChecks）で使う、局を指定した確かめ。
// 壊れたら: 合意して確定した枠が、その合意の契約（同じ局・独占）で要確認になる。または局を指定しない提案が同じ局の独占を塞がなくなる
test('局を指定した確かめ（forStation）: その局との独占の契約は塞がず、ほかの局の独占とホールドバック（局を問わず）はこれまでどおり塞ぐ', () => {
  const terms = new Map([[1, {licensed_runs: null, holdback_months: 2}]]);
  const entries = [entry(1, {exclusivity: 'exclusive', contract_start: '2027-01-01', contract_end: '2027-03-31'}), entry(2, {exclusivity: 'exclusive', contract_start: '2027-09-01', contract_end: '2027-10-31'})];
  const base = {asOf, product: P, rights, releaseWindows: release, terms, entries};
  // 局を指定しない（画面の提案）: 局1 の独占・局1 のホールドバック（2か月）・局2 の独占で塞がる
  assert.deepEqual(periods(proposeWindow(base).proposals), [['2026-10-01', '2026-12-31'], ['2027-06-01', '2027-08-31'], ['2027-11-01', '2028-09-26']]);
  // 局1 を指定: 局1 の独占は塞がない。局1 の契約のホールドバック（2027/04/01〜2027/05/31）と局2 の独占は塞ぐ。名前のゆれ（全角・空白・大文字）も同じ局
  const own = proposeWindow({...base, forStation: ' 局１ '});
  assert.deepEqual(periods(own.proposals), [['2026-10-01', '2027-03-31'], ['2027-06-01', '2027-08-31'], ['2027-11-01', '2028-09-26']]);
  assert.deepEqual(own.blocked.map((b) => [b.kind, b.station, b.from, b.to]), [['holdback', '局1', '2027-04-01', '2027-05-31'], ['exclusive', '局2', '2027-09-01', '2027-10-31']]);
  // 取引先コードでも同じ局とみなす
  assert.deepEqual(periods(proposeWindow({...base, forStation: 'tv-1'}).proposals), periods(own.proposals));
  // 別の局を指定したら、局1 の独占は塞ぐ
  assert.deepEqual(periods(proposeWindow({...base, forStation: '局3'}).proposals), periods(proposeWindow(base).proposals));
});
