#!/usr/bin/env node
// 番販・放送（放送履歴表・放送アベイルズリスト・放送ウィンドウ提案）を画面で確かめるための架空データを、組織 DEMO-SALES に足す。
// 設計: docs/platform/team-development/broadcast-windows.md §6。
// 使い方: node scripts/seed-broadcast-demo.mjs --db <SQLiteのパス>
// ・先に scripts/seed-sales-demo.mjs → scripts/seed-eigyo-demo.mjs を流しておく（必須）。作品カタログ（製作年・出演など）は seed-eigyo-demo が入れる
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番のD1・設定・秘密値は読まない。
// ・すべて API を通して登録する（検証・トリガー・監査は画面から登録したときと同じ）。放送枠の承認も API の手順どおり
//   （下書き → 一次承認の申請 → 仮押さえ → 最終承認の申請 → 確定）に架空の管理者で進める。DDL は流さない。
// ・目印は取引先 DEMO-TV-C。手順ごとに「もうあるか」を確かめるので、何度流しても増えず、途中で止まっても流し直せば続きから入る。
// ・入れるもの: 放送局4局（地上波・BS・CS・CATV）の区分「放送局」と局の種別、W01〜W06 の放送枠と実放送の履歴
//   （同じ月の別局の赤・黄の例を含む）、W05 の独占契約（CS）、W06 の商品指定の予定の明細（CATV）、W01〜W08 の放送の権利範囲
//   （W07 は権利が放送期限より早く終わる例）、明細ごとの許諾放送回数とホールドバックの例、
//   放送ウィンドウ提案から作った放送枠の下書き2件（W07・W08）と、合意に至らず削除した例1件（W03。目印はメモの DEMO-BPD-n）。
// ・名前はすべて「（架空）」付き、コードは DEMO-*。実在の社名・作品名・実データは使わない。
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {SALES_DEMO, addMonths} from './seed-sales-demo.mjs';

export const BROADCAST_DEMO = Object.freeze({
  asOf: SALES_DEMO.asOf,
  marker: 'DEMO-TV-C',
  stations: Object.freeze([
    {code: 'DEMO-TV-A', name: '架空地上波テレビ（架空）', type: 'terrestrial', existing: true},
    {code: 'DEMO-TV-B', name: '架空BS放送（架空）', type: 'bs', existing: true},
    {code: 'DEMO-TV-C', name: '架空CS放送（架空）', type: 'cs'},
    {code: 'DEMO-TV-D', name: '架空ケーブルテレビ（架空）', type: 'catv'},
  ].map((s) => Object.freeze(s))),
  firstRelease: '2024-07', // DEMO-W01 の劇場公開の月（seed-eigyo-demo.mjs と同じ）。Wnn は1か月ずつ後
  committeeWorks: Object.freeze(['DEMO-W01', 'DEMO-W03', 'DEMO-W04', 'DEMO-W07']),
});
const STATION = Object.fromEntries(BROADCAST_DEMO.stations.map((s) => [s.code.slice(-1), s]));
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const eom = (ym) => `${ym}-${pad(lastDay(ym))}`;
const workCode = (n) => `DEMO-W${pad(n)}`;
export const releaseOf = (n) => addMonths(BROADCAST_DEMO.firstRelease, n - 1);

// 放送枠の計画。status は最後の状態（確定までは API の承認の手順で進める）。airings は実放送（日・回数）。
// 必ず含める例: 同じ月の別局で確定同士（赤: W01 2026-08）、未確定を含む（黄: W02 2026-11・W04 2026-10）、先の月の確定（予定: W01 2026-12・W03 2026-10）、
// 下書き（W06 2027-01）、申請中（W05 2026-12）。W04 2025-06 の BS の枠（放送期間の前・警告の例）は seed-eigyo-demo が入れている
export function slotPlan() {
  const A = STATION.A.name, B = STATION.B.name, C = STATION.C.name, D = STATION.D.name;
  const s = (work, month, station, status, airings = [], runs = 1) => ({work: workCode(work), month, station, status, airings, runs});
  return [
    s(1, '2025-05', B, 'confirmed', [['2025-05-17', 1]]),
    s(1, '2025-12', B, 'confirmed', [['2025-12-20', 1]]),
    s(1, '2026-08', B, 'confirmed', [['2026-08-15', 1]]),
    s(1, '2026-08', A, 'confirmed', [['2026-08-29', 1]]), // 赤: 同じ月に確定の別局
    s(1, '2026-12', A, 'confirmed', []), // 先の月の確定（直近の放送局では「（予定）」）
    s(2, '2025-07', B, 'confirmed', [['2025-07-12', 1]]),
    s(2, '2026-11', B, 'tentative'),
    s(2, '2026-11', C, 'pending_final'), // 黄: 同じ月に仮押さえと申請中
    s(3, '2025-08', B, 'confirmed', [['2025-08-09', 1], ['2025-08-23', 1]], 2),
    s(3, '2026-02', A, 'confirmed', [['2026-02-14', 1]]),
    s(3, '2026-10', B, 'confirmed', []),
    s(4, '2025-09', B, 'confirmed', [['2025-09-06', 1]]),
    s(4, '2025-10', B, 'confirmed', [['2025-10-04', 1]]),
    s(4, '2026-10', B, 'confirmed', []),
    s(4, '2026-10', A, 'tentative'), // 黄: 確定と仮押さえ
    s(5, '2026-05', C, 'confirmed', [['2026-05-10', 1]]),
    s(5, '2026-06', C, 'confirmed', [['2026-06-07', 1]]),
    s(5, '2026-12', C, 'pending_first'),
    s(6, '2026-01', D, 'confirmed', [['2026-01-11', 1], ['2026-01-25', 1]], 2),
    s(6, '2027-01', D, 'draft'),
  ];
}

// 取引先別リストの新しい明細（CS の独占・CATV の商品指定の予定と作品全体の契約）
export function entryPlan() {
  return [
    {station: 'C', list: 'CS放送の許諾（架空）', work: 'DEMO-W05', code: 'B001', start: '2026-04-01', end: '2027-03-31', rule: 'date', status: 'contracted', excl: 'exclusive', method: 'FLAT', amount: '1800000', cat: 'CS 1年6回（独占）'},
    {station: 'D', list: 'ケーブルテレビの許諾（架空）', work: 'DEMO-W06', code: 'B001', start: '2025-12-01', end: '2026-11-30', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'FLAT', amount: '300000', cat: 'CATV 1年2回'},
    {station: 'D', list: 'ケーブルテレビの許諾（架空）', work: 'DEMO-W06', code: 'B001', start: '2026-12-01', end: '2027-11-30', rule: 'date', status: 'planned', excl: 'nonexclusive', method: 'FLAT', amount: '', cat: 'CATV 1年4回（商品指定・交渉中）', product: 'DEMO-W06-TV'},
  ];
}

// 明細ごとの許諾放送回数とホールドバック（月）。station と作品と契約開始で明細を探す
export function termPlan() {
  return [
    {station: 'B', work: 'DEMO-W01', start: '2025-05-01', runs: 3, holdback: 6},
    {station: 'B', work: 'DEMO-W02', start: '2025-07-01', runs: 2, holdback: null},
    {station: 'B', work: 'DEMO-W03', start: '2025-07-01', runs: 3, holdback: null},
    {station: 'B', work: 'DEMO-W04', start: '2025-08-01', runs: 3, holdback: 3},
    {station: 'A', work: 'DEMO-W01', start: '2025-11-01', runs: 1, holdback: 3},
    {station: 'A', work: 'DEMO-W03', start: '2026-01-01', runs: 1, holdback: null},
    {station: 'C', work: 'DEMO-W05', start: '2026-04-01', runs: 6, holdback: 6},
    {station: 'D', work: 'DEMO-W06', start: '2025-12-01', runs: 2, holdback: 0},
    {station: 'D', work: 'DEMO-W06', start: '2026-12-01', runs: 4, holdback: null},
  ];
}

// 放送の権利範囲（日本）。公開の月の1日から7年。W07 は 2026-12-31 で終わる（放送期限 2027-10 より早い → 提案が短くなる）
export function rightsPlan() {
  return Array.from({length: 8}, (_, i) => {
    const n = i + 1, code = workCode(n), start = `${releaseOf(n)}-01`;
    const end = n === 7 ? '2026-12-31' : eom(addMonths(releaseOf(n), 7 * 12 - 1));
    return {workCode: code, channel: '放送', territory: '日本', rightsStart: start, rightsEnd: end, exclusivity: 'exclusive', committee: BROADCAST_DEMO.committeeWorks.includes(code)};
  });
}

// 放送ウィンドウ提案（基準日 BROADCAST_DEMO.asOf）から作る放送枠の下書き。deleteReason があるものは作った後に「削除（合意に至らず）」にする。
// どれも提案する期間の中の月（W07 は 2026-09-25〜2026-12-31、W08 は 〜2027-11-30、W03 は 〜2027-06-30）で、同じ月・同じ局の枠が無いもの
export function proposalDraftPlan() {
  return [
    {marker: 'DEMO-BPD-1', work: 'DEMO-W07', sku: 'DEMO-W07-TV', station: 'A', months: ['2026-11'], run: 'first', memo: '年末の特番枠で打診中（架空）'},
    {marker: 'DEMO-BPD-2', work: 'DEMO-W08', sku: 'DEMO-W08-TV', station: 'C', months: ['2027-01'], run: 'first', memo: '新春の編成へ提案（架空）'},
    {marker: 'DEMO-BPD-3', work: 'DEMO-W03', sku: 'DEMO-W03-TV', station: 'D', months: ['2027-03'], run: 'rerun', memo: '再放送の枠で打診（架空）', deleteReason: '局の編成と合わず、合意に至らなかった（架空）'},
  ];
}

async function login(db) {
  const app = createApp({db, mode: 'local'});
  const response = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  if (response.status !== 200) throw new Error(`架空の管理者でログインできません（${response.status}）`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload) => {
    const res = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const data = await res.json();
    if (res.status >= 300 || data.ok === false) throw new Error(`${method} ${path}: ${res.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
  return {post: (path, payload) => call('POST', path, payload), get: (path) => call('GET', path)};
}

const NEXT = {draft: 'pending_first', pending_first: 'tentative', tentative: 'pending_final', pending_final: 'confirmed'};
const ORDER = ['draft', 'pending_first', 'tentative', 'pending_final', 'confirmed'];
const key = (value) => String(value ?? '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();

export async function seedBroadcastDemo(db, {log = () => {}} = {}) {
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  if (!org || !await db.get('SELECT 1 FROM work_release_windows w JOIN works k ON k.org_id=w.org_id AND k.id=w.work_id WHERE w.org_id=? AND k.code=?', [org.id, 'DEMO-W01'])) {
    throw new Error(`組織 ${SALES_DEMO.orgCode} の営業基幹の架空データがありません。先に scripts/seed-sales-demo.mjs → scripts/seed-eigyo-demo.mjs を流してください`);
  }
  const api = await login(db);
  if ((await api.get('/session')).user.orgId !== org.id) throw new Error('架空の管理者が DEMO-SALES で入れていません');
  const done = {partners: 0, roles: 0, stationTypes: 0, slots: 0, transitions: 0, airings: 0, lists: 0, entries: 0, terms: 0, rights: 0, proposalDrafts: 0, proposalDeletions: 0};

  // 1. 放送局（取引先）と区分「放送局」・局の種別
  let partners = new Map((await api.get('/partner-lists')).partners.map((p) => [p.code, p]));
  for (const station of BROADCAST_DEMO.stations) {
    if (!partners.has(station.code)) { await api.post('/partners', {code: station.code, name: station.name, kind: 'other'}); done.partners += 1; }
  }
  partners = new Map((await api.get('/partner-lists')).partners.map((p) => [p.code, p]));
  for (const station of BROADCAST_DEMO.stations) {
    const partner = partners.get(station.code);
    const profile = await api.get(`/partners/${partner.id}/profile`);
    const current = profile.current;
    if (!current?.roles?.includes('broadcaster')) {
      const keep = current ? Object.fromEntries(['invoice_registration_number', 'postal_code', 'address', 'phone', 'contact_name', 'contact_email', 'billing_note', 'effective_from'].map((k) => [k, current[k]])) : {};
      await api.post(`/partners/${partner.id}/profile-versions`, {...keep, roles: [...new Set([...(current?.roles || []), 'customer', 'broadcaster'])], baseVersion: current?.version_no || 0});
      done.roles += 1;
    }
  }
  const types = new Map((await api.get('/broadcast/station-types')).stations.map((s) => [s.code, s]));
  for (const station of BROADCAST_DEMO.stations) {
    const current = types.get(station.code);
    if (current?.station_type === station.type) continue;
    await api.post('/broadcast/station-types', {partnerId: partners.get(station.code).id, stationType: station.type, baseVersion: current?.version_no || 0, reason: '局の種別を登録（架空データ・seed-broadcast-demo）'});
    done.stationTypes += 1;
  }

  // 2. 放送枠と実放送（承認は API の手順で確定まで）
  const works = new Map((await api.get('/bootstrap')).works.map((w) => [w.code, w]));
  const byCode = new Map(BROADCAST_DEMO.stations.map((s) => [key(s.name), s]));
  for (const item of slotPlan()) {
    const work = works.get(item.work);
    if (!work) throw new Error(`作品 ${item.work} がありません`);
    let slots = (await api.get(`/broadcast?workId=${work.id}`)).slots;
    let slot = slots.find((x) => x.broadcast_month === item.month && key(x.station_name) === key(item.station) && x.status !== 'cancelled');
    if (!slot) {
      const partner = partners.get(byCode.get(key(item.station)).code);
      await api.post('/broadcast/slots', {workId: work.id, broadcastMonth: item.month, stationName: item.station, customerPartnerId: partner.id, periodFrom: `${item.month}-01`, periodTo: eom(item.month),
        plannedRuns: item.runs, sourceReference: `架空の編成表 ${item.month}（デモ）`, reason: '放送の予定を登録（架空データ）'});
      done.slots += 1;
      slots = (await api.get(`/broadcast?workId=${work.id}`)).slots;
      slot = slots.find((x) => x.broadcast_month === item.month && key(x.station_name) === key(item.station) && x.status !== 'cancelled');
    }
    while (ORDER.indexOf(slot.status) < ORDER.indexOf(item.status)) {
      const next = NEXT[slot.status];
      const moved = await api.post(`/broadcast/slots/${slot.slot_id}/transition`, {baseRevision: slot.revision, status: next, reason: next === 'confirmed' ? '局の編成が確定（架空）' : '手順どおりに申請・承認（架空）'});
      slot = {...slot, status: next, revision: moved.revision};
      done.transitions += 1;
    }
    if (item.airings.length) {
      const recorded = (await api.get(`/broadcast/reconciliation?workId=${work.id}`)).rows.find((r) => r.slot_id === slot.slot_id)?.actual_runs || 0;
      if (!recorded) {
        for (const [airedOn, count] of item.airings) {
          await api.post(`/broadcast/slots/${slot.slot_id}/airings`, {airedOn, runCount: count, sourceReference: `架空の放送確認書 ${airedOn}（デモ）`});
          done.airings += 1;
        }
      }
    }
  }

  // 3. 取引先別リスト（CS の独占・CATV の商品指定の予定）
  const lists = (await api.get('/partner-lists')).lists;
  const entriesOf = async (listId) => (await api.get(`/partner-lists/${listId}/entries`)).entries;
  for (const plan of entryPlan()) {
    const partner = partners.get(STATION[plan.station].code);
    let list = lists.find((l) => l.partner_id === partner.id && l.name === plan.list);
    if (!list) {
      const created = await api.post('/partner-lists', {partnerId: partner.id, listKind: 'distribution', name: plan.list, serviceName: STATION[plan.station].name, reason: '局からの許諾通知を登録（架空データ・seed-broadcast-demo）'});
      list = {id: created.id, partner_id: partner.id, name: plan.list};
      lists.push(list);
      done.lists += 1;
    }
    const exists = (await entriesOf(list.id)).some((e) => e.work_code === plan.work && e.contract_start === plan.start);
    if (exists) continue;
    await api.post(`/partner-lists/${list.id}/entries`, {workId: works.get(plan.work).id, reason: '許諾通知書の内容を登録（架空データ）', values: {
      distribution_code: plan.code, territory: '日本', contract_start: plan.start, contract_end: plan.end, end_rule: plan.rule, status: plan.status, exclusivity: plan.excl,
      settlement_method: plan.method, amount_ex_tax: plan.amount, partner_category: plan.cat, product_sku: plan.product || '', source_reference: '架空の許諾通知書（デモ）'}});
    done.entries += 1;
  }

  // 4. 明細ごとの許諾放送回数とホールドバック
  const allLists = (await api.get('/partner-lists')).lists;
  for (const plan of termPlan()) {
    const partner = partners.get(STATION[plan.station].code);
    let entry = null;
    for (const list of allLists.filter((l) => l.partner_id === partner.id)) {
      entry = (await entriesOf(list.id)).find((e) => e.work_code === plan.work && e.contract_start === plan.start) || entry;
    }
    if (!entry) throw new Error(`許諾の明細がありません（${STATION[plan.station].code}・${plan.work}・${plan.start}）`);
    const current = (await api.get(`/partner-list-entries/${entry.entry_id}/broadcast-terms`)).current;
    if (current) continue;
    await api.post(`/partner-list-entries/${entry.entry_id}/broadcast-terms`, {baseVersion: 0, licensedRuns: plan.runs, holdbackMonths: plan.holdback, reason: '許諾通知書の放送回数とホールドバック（架空データ）'});
    done.terms += 1;
  }

  // 5. 放送の権利範囲（まだ放送の範囲が無い作品だけ）。委員会の作品は委員会の調達ケースの最新の版を改訂して範囲を足す（出資者・ほかの範囲はそのまま）
  const scoped = new Set((await db.all(`SELECT DISTINCT w.code FROM rights_intake_scopes s JOIN rights_intake_cases c ON c.org_id=s.org_id AND c.id=s.intake_case_id JOIN works w ON w.org_id=c.org_id AND w.id=c.work_id
    WHERE s.org_id=? AND s.channel='放送' AND NOT EXISTS(SELECT 1 FROM rights_intake_cases n WHERE n.org_id=c.org_id AND n.source_case_id=c.id)`, [org.id])).map((row) => row.code));
  for (const item of rightsPlan()) {
    if (scoped.has(item.workCode)) continue;
    const work = works.get(item.workCode);
    const scope = {channel: item.channel, territory: item.territory, rightsStart: item.rightsStart, rightsEnd: item.rightsEnd, exclusivity: item.exclusivity};
    const cases = item.committee ? (await api.get(`/intakes?workId=${work.id}`)).cases : [];
    const superseded = new Set(cases.map((c) => c.source_case_id).filter(Boolean));
    const latest = cases.filter((c) => c.intakeType === 'committee' && !superseded.has(c.id)).sort((a, b) => b.snapshot_version - a.snapshot_version || b.id - a.id)[0];
    if (latest) {
      await api.post('/intakes', {workId: work.id, sourceCaseId: latest.id, caseCode: `${item.workCode}-CMT-TV`, title: `${latest.title.replace(/（放送の権利範囲を追記）$/, '')}（放送の権利範囲を追記）`, intakeType: 'committee',
        documents: latest.documents.map((d) => ({title: d.title, reference: d.reference, versionLabel: d.version_label})),
        participants: latest.participants.map((p) => ({partyKind: p.party_kind, partnerId: p.partner_id, role: p.role, investmentYen: p.investment_yen, explicitShareBps: p.explicit_share_bps})),
        scopes: [...latest.scopes.map((s) => ({channel: s.channel, territory: s.territory, rightsStart: s.rights_start, rightsEnd: s.rights_end, exclusivity: s.exclusivity})), scope]});
    } else {
      await api.post('/intakes', {workId: work.id, caseCode: `${item.workCode}-TV-RIGHTS`, title: `${work.title} 放送の権利範囲（架空）`, intakeType: 'sole_owned',
        documents: [{title: `${work.title} 放送権の許諾書（架空）`, reference: `架空の許諾書 ${item.workCode}-TV-RIGHTS`, versionLabel: '第1版'}],
        scopes: [scope], participants: [{partyKind: 'current_org', role: '権利保有'}]});
    }
    done.rights += 1;
  }

  // 6. 放送ウィンドウ提案から作った放送枠の下書きと、合意に至らず削除した例。提案は API がその場で計算し直し、選んだ月が提案する期間の中かを確かめる。
  //    目印はメモの DEMO-BPD-n（削除したものも一覧の deleted に残るので、流し直しても作り直さない）
  const draftList = async () => api.get('/broadcast/window-proposals/drafts');
  let drafts = await draftList();
  const stationOf = new Map(drafts.stations.map((s) => [s.code, s]));
  let proposals = null;
  for (const plan of proposalDraftPlan()) {
    let row = [...drafts.rows, ...drafts.deleted].find((r) => String(r.memo || '').includes(plan.marker));
    if (!row) {
      proposals ??= (await api.get(`/broadcast/window-proposals?asOf=${BROADCAST_DEMO.asOf}`)).rows;
      const proposal = proposals.find((p) => p.work_code === plan.work && (p.product_sku || '') === plan.sku);
      if (proposal?.state !== 'ok') throw new Error(`${plan.work}（${plan.sku}）の放送ウィンドウ提案がありません（基準日 ${BROADCAST_DEMO.asOf}）`);
      const station = stationOf.get(STATION[plan.station].code);
      const created = await api.post('/broadcast/window-proposals/drafts', {workId: proposal.work_id, productId: proposal.product_id, asOf: BROADCAST_DEMO.asOf,
        stationPartnerId: station.partner_id, months: plan.months, runKind: plan.run, memo: `${plan.memo} ${plan.marker}`});
      done.proposalDrafts += created.count;
      drafts = await draftList();
      row = drafts.rows.find((r) => r.slot_id === created.slots[0].slotId);
    }
    if (plan.deleteReason && !row.deleted) {
      await api.post(`/broadcast/window-proposals/drafts/${row.slot_id}/delete`, {baseRevision: row.revision, reason: plan.deleteReason});
      done.proposalDeletions += 1;
      drafts = await draftList();
    }
  }
  const added = Object.values(done).reduce((n, v) => n + v, 0);
  log(added ? `放送: ${JSON.stringify(done)}` : '放送の架空データは投入済みです（何もしませんでした）');
  return {orgId: org.id, skipped: added === 0, ...done};
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index > 0 ? process.argv[index + 1] : null;
  };
  const target = option('--db');
  if (!target) {
    console.error('投入先のDBを --db で指定してください（例: --db C:/temp/demo-sales.sqlite）。既定のローカルDBへは書きません。');
    process.exit(2);
  }
  const mainDb = fileURLToPath(new URL('../data/integrated.sqlite', import.meta.url));
  if (resolve(target).toLowerCase() === resolve(mainDb).toLowerCase() && !process.argv.includes('--allow-main-db')) {
    console.error('data/integrated.sqlite への投入は --allow-main-db を付けたときだけ行います。');
    process.exit(2);
  }
  const db = new LocalDatabase(resolve(target));
  try {
    const started = Date.now();
    const result = await seedBroadcastDemo(db, {log: (message) => console.log(`  ${message}`)});
    console.log(result.skipped ? `${SALES_DEMO.orgCode} の放送の架空データは投入済みです（何もしませんでした）` : `投入しました（${((Date.now() - started) / 1000).toFixed(1)}秒）: ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}
