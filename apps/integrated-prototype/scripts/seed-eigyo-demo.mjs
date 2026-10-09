#!/usr/bin/env node
// 営業基幹（全作品のウィンドウ・取引先別リスト・売上集計シート）を画面で確かめるための架空データを、組織 DEMO-SALES に足す。
// 設計: docs/platform/team-development/eigyo-sales-sheet-design.md §6。
// 使い方: node scripts/seed-eigyo-demo.mjs --db <SQLiteのパス>
// ・先に scripts/seed-sales-demo.mjs（売上の架空データ）を流しておく（必須）。scripts/seed-kouban-demo.mjs（連続ドラマ）は任意で、
//   流してあれば連続ドラマ DEMO-D78 にもウィンドウを足す。
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番のD1・設定・秘密値は読まない。
// ・すべて API を通して登録する（検証・トリガー・監査は画面から登録したときと同じ）。
// ・節ごとに目印を持ち、2回流しても増えない（目印のある節は何もしない）。後の実装は節を足していく:
//   1. ウィンドウ（目印: DEMO-W01 にウィンドウがある）… 種別の採用・20作品＋連続ドラマのウィンドウ・警告を出す販売条件・権利範囲・放送枠
//   2. 取引先別の配信・販売リスト（目印: DEMO-PF-A にリストがある）… 配信A・B・C／放送2局（配信リスト）・レンタル・セル（販売リスト）、
//      追加の列2つ、自動更新・期限なし・再契約（空白あり）・独占どうしの重なり・終了間近・期間外の売上。配信Aは共通テンプレートの Excel 取込で入れる
//   3. 売上集計シート（83列）（目印: DEMO-SALES が列を採用済み）… 初期の83列の採用、海外の売上に外貨（北米は USD・台湾は TWD とレート）、
//      劇場の売上に劇場名・券種の区分・券種の税込単価、配信A（定額制）の売上に視聴UU数、レンタルの売上に延滞・回転率、保存した形2つ
//   4. 提案資料（目印: DEMO-N06 に提案資料に出す作品情報がある）… 公開前の新作6本（DEMO-N01〜N06・2026-10〜2027-03 に1本ずつ・
//      PVOD・EST・TVOD・SVOD の窓付き）、W09〜W20 の EST先行・TVOD先行、W13〜W20 の PVOD②、SVOD の窓の月額単価（新しい版）、
//      全作品の配信の権利範囲（委員会の作品は委員会の調達ケースの改訂）、26作品の作品カタログと提案資料に出す作品情報（どれも架空の文）。
//      この節は手順ごとに「もうあるか」を確かめるので、途中で止まっても流し直せば続きから入る
// ・名前はすべて「（架空）」付き、コードは DEMO-*。実在の社名・作品名・実データは使わない。
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {SALES_DEMO, addMonths} from './seed-sales-demo.mjs';
import {ADDITIONAL_CATALOG_VERSION} from '../src/sales-sheet/column-registry.mjs';
import {currentWindowInput} from '../src/sales-ops/release-window-model.mjs';

export const EIGYO_DEMO = Object.freeze({
  asOf: SALES_DEMO.asOf, // 状態（予定・確定）の決め方の基準日。架空データを毎回同じにするため今日ではなく固定
  windowsMarkerWork: 'DEMO-W01',
  firstRelease: '2024-07', // DEMO-W01 の劇場公開の月。DEMO-Wnn は1か月ずつ後（seed-sales-demo.mjs の作品と同じ並び）
  seriesWork: 'DEMO-D78',
  partnerListsMarkerPartner: 'DEMO-PF-A', // 取引先別リストの節の目印（この取引先にリストがあれば節2は何もしない）
  // 売上集計シートの節の目印は「DEMO-SALES に列の定義がある」こと（節3）
});

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const day = (ym, d) => `${ym}-${pad(Math.min(d, lastDay(ym)))}`;
export const releaseOf = (n) => addMonths(EIGYO_DEMO.firstRelease, n - 1);
const workCode = (n) => `DEMO-W${pad(n)}`;

// ---------- 1. ウィンドウ ----------
// 作品ごとのウィンドウの計画（版の順）。start・end・announce は画面・Excel と同じ文字（日付・月・年・時期の原文・未定）。
// 状態: 基準日までに始まるものは確定、先のものは予定。取り下げ・月まで・時期・未定・未登録を必ず含める
export function windowPlan({withSeries = false} = {}) {
  const plan = [];
  const add = (code, typeKey, ...versions) => plan.push({workCode: code, typeKey, versions});
  const statusFor = (start) => (start <= EIGYO_DEMO.asOf ? 'confirmed' : 'draft');
  const nonexclusive = 'nonexclusive', exclusive = 'exclusive';
  for (let n = 1; n <= 20; n += 1) {
    const code = workCode(n), R = releaseOf(n);
    add(code, 'theatrical', {start: day(R, 6 + (n % 5) * 5), status: 'confirmed', reason: '配給の公開日（架空）'});
    if (n >= 19) {
      // 発売月だけ決まっている（日は未定）＝月まで
      const m = addMonths(R, 9);
      add(code, 'package_sell', {start: m, status: 'draft', reason: '発売月だけ決まった（日は未定・架空）'});
      add(code, 'package_rental', {start: m, status: 'draft', reason: 'レンタル開始は発売と同じ月の予定（架空）'});
    } else {
      const d = day(addMonths(R, 6), 5);
      add(code, 'package_sell', {start: d, status: 'confirmed', reason: 'セルの発売日（架空）'});
      if (n === 11) {
        add(code, 'package_rental', {start: d, status: 'draft', reason: 'レンタル開始の予定（架空）'}, {start: d, status: 'withdrawn', reason: 'レンタル展開を見送った（架空）'});
      } else {
        add(code, 'package_rental', {start: d, status: 'confirmed', reason: 'レンタル開始日（架空）'});
      }
    }
    if (n >= 13) {
      const s = day(addMonths(R, 1), 15);
      add(code, 'pvod_early', {start: s, end: day(addMonths(R, 3), 14), announce: day(R, 1), status: n === 20 ? 'draft' : statusFor(s),
        fields: {price_ex_tax: '2500', viewing_hours: '48', exclusivity: nonexclusive}, reason: 'PVOD先行の条件（架空）'});
    }
    const s4 = day(addMonths(R, 4), 1);
    add(code, 'est_regular', {start: s4, status: statusFor(s4), fields: {price_ex_tax: '2000', exclusivity: nonexclusive}, reason: 'EST通常の解禁（期限なし・架空）'});
    add(code, 'tvod_regular', {start: s4, end: day(addMonths(R, 39), 31), status: statusFor(s4), fields: {price_ex_tax: '400', viewing_hours: '48', exclusivity: nonexclusive}, reason: 'TVOD通常の解禁（架空）'});
    if (n % 2 === 1) {
      const s8 = day(addMonths(R, 8), 1), e8 = day(addMonths(R, 19), 31), a8 = day(addMonths(R, 7), 15);
      const svod = {price_ex_tax: '', viewing_hours: '', exclusivity: exclusive};
      if (n === 1) {
        add(code, 'svod_early', {start: addMonths(R, 8), status: 'draft', reason: '解禁の月だけ決まった（架空）'},
          {start: s8, end: e8, announce: a8, status: 'confirmed', fields: svod, reason: '架空配信A と独占12か月で合意（架空）'});
      } else if (n === 15) {
        add(code, 'svod_early', {start: s8, end: e8, status: 'draft', fields: svod, reason: '先行独占の打診（架空）'},
          {start: s8, end: e8, status: 'withdrawn', fields: svod, reason: '先行独占は見送った（架空）'});
      } else if (n === 19) {
        add(code, 'svod_early', {start: '2027年春', status: 'draft', reason: '時期だけ決まっている（架空）'});
      } else {
        add(code, 'svod_early', {start: s8, end: e8, announce: a8, status: statusFor(s8), fields: svod, reason: 'SVOD先行（独占12か月・架空）'});
      }
    }
    if (n <= 12) {
      const s20 = day(addMonths(R, 20), 1);
      add(code, 'svod_regular', {start: s20, end: day(addMonths(R, 43), 31), status: statusFor(s20), fields: {exclusivity: nonexclusive}, reason: 'SVOD通常（非独占・架空）'});
    }
    if (n <= 8) {
      const s30 = day(addMonths(R, 30), 1);
      if (n === 8) add(code, 'avod', {start: s30, status: 'draft', reason: 'AVODの打診（架空）'}, {start: s30, status: 'withdrawn', reason: 'AVODは見送った（架空）'});
      else add(code, 'avod', {start: s30, status: statusFor(s30), reason: 'AVODの予定（架空）'});
    }
    if (n <= 16) {
      const s10 = day(addMonths(R, 10), 1);
      add(code, 'broadcast', {start: s10, end: day(addMonths(R, 33), 31), announce: day(addMonths(R, 9), 15), status: statusFor(s10), reason: '放送の解禁（架空）'});
    } else if (n === 20) {
      add(code, 'broadcast', {start: '未定', status: 'draft', reason: '放送は調整中（架空）'});
    }
    if ([1, 3, 4, 7, 10, 12, 18].includes(n)) {
      const s3 = day(addMonths(R, 3), 1);
      add(code, 'overseas', {start: s3, end: day(addMonths(R, 62), 31), status: statusFor(s3), reason: '海外セールスの期間（架空）'});
    }
    if (n === 5) {
      const s12 = day(addMonths(R, 12), 1);
      add(code, 'business_vod', {start: s12, end: day(addMonths(R, 35), 31), status: 'draft', fields: {price_ex_tax: '30000', exclusivity: nonexclusive}, reason: '業務用VODの予定（架空）'});
    }
  }
  if (withSeries) {
    // 連続ドラマ（制作の架空データ）: 放送は決まっている。配信の先行は月まで
    add(EIGYO_DEMO.seriesWork, 'broadcast', {start: '2026-10-05', end: '2027-03-31', announce: '2026-09-01', status: 'confirmed', reason: '連続ドラマの放送期間（架空）'});
    add(EIGYO_DEMO.seriesWork, 'svod_early', {start: '2026-10', status: 'draft', fields: {exclusivity: exclusive}, reason: '見逃し配信の開始月（架空）'});
  }
  return plan;
}

// 警告を出すための材料（販売条件・権利範囲・放送枠）。どれも API で登録する
export const WARNING_FIXTURES = Object.freeze({
  // 販売条件（流通別の販売条件）。W01 は SVOD の条件がウィンドウより短い（期間外）、W03 は TVOD の条件がウィンドウより後に始まる（期間外）、
  // W02 は EST の条件がウィンドウを含む（警告なし）
  availabilities: Object.freeze([
    {workCode: 'DEMO-W01', distributionCode: 'D005', territory: '日本', releaseOn: '2025-03-01', salesEndOn: '2025-12-31', exclusivity: 'exclusive', terms: 'SVOD 独占（架空）'},
    {workCode: 'DEMO-W03', distributionCode: 'D004', territory: '日本', releaseOn: '2025-02-01', salesEndOn: '2028-12-31', exclusivity: 'nonexclusive', terms: 'TVOD 非独占（架空）'},
    {workCode: 'DEMO-W02', distributionCode: 'D003', territory: '日本', releaseOn: '2024-11-01', salesEndOn: '2030-12-31', exclusivity: 'nonexclusive', terms: 'EST 非独占（架空）'},
  ]),
  // 権利範囲（単独保有の調達ケース）。W02 の配信の権利は 2027-07-31 まで
  rights: Object.freeze([
    {workCode: 'DEMO-W02', caseCode: 'DEMO-W02-RIGHTS', channel: '配信', territory: '日本', rightsStart: '2024-08-01', rightsEnd: '2027-07-31'},
  ]),
  // 放送枠。W04 の放送の解禁（2025-08）より前の月に枠がある
  slots: Object.freeze([
    {workCode: 'DEMO-W04', broadcastMonth: '2025-06', stationName: '架空BS放送（架空）'},
  ]),
});

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
  const bytes = async (path) => {
    const res = await app.request(`/api${path}`, {headers: {cookie}});
    if (res.status !== 200) throw new Error(`GET ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  return {post: (path, payload) => call('POST', path, payload), get: (path) => call('GET', path), bytes};
}

async function seedWindows(db, orgId, api, log) {
  const marker = await db.get('SELECT 1 FROM work_release_windows w JOIN works k ON k.org_id=w.org_id AND k.id=w.work_id WHERE w.org_id=? AND k.code=?', [orgId, EIGYO_DEMO.windowsMarkerWork]);
  if (marker) return {skipped: true};
  const typesBody = await api.get('/release-window-types');
  if (!typesBody.types.length) await api.post('/release-window-types/adopt', {reason: '架空データ（デモ）の組織で初期の種別を採用（seed-eigyo-demo）'});
  const types = new Map((await api.get('/release-window-types')).types.map((type) => [type.type_key, type]));
  const works = new Map((await api.get('/bootstrap')).works.map((work) => [work.code, work]));
  const withSeries = works.has(EIGYO_DEMO.seriesWork);
  let windows = 0, versions = 0;
  for (const item of windowPlan({withSeries})) {
    const work = works.get(item.workCode), type = types.get(item.typeKey);
    if (!work || !type) throw new Error(`作品 ${item.workCode} か種別 ${item.typeKey} がありません`);
    let base = 0;
    for (const version of item.versions) {
      await api.post('/release-windows', {workId: work.id, typeId: type.id, baseVersion: base, start: version.start, end: version.end ?? '', announce: version.announce ?? '',
        status: version.status, fields: version.fields || {}, sourceReference: '架空の営業資料（デモ）', reason: version.reason});
      base += 1;
      versions += 1;
    }
    windows += 1;
  }
  for (const a of WARNING_FIXTURES.availabilities) {
    await api.post('/sales-catalog', {workId: works.get(a.workCode).id, distributionCode: a.distributionCode, territory: a.territory, baseVersion: 0, releaseOn: a.releaseOn, salesEndOn: a.salesEndOn,
      terms: a.terms, sourceReference: '架空の販売条件（デモ）', exclusivity: a.exclusivity, status: 'confirmed'});
  }
  for (const r of WARNING_FIXTURES.rights) {
    const work = works.get(r.workCode);
    await api.post('/intakes', {workId: work.id, caseCode: r.caseCode, title: `${work.title} 権利範囲（架空）`, intakeType: 'sole_owned',
      documents: [{title: `${work.title} 権利許諾書（架空）`, reference: `架空の許諾書 ${r.caseCode}`, versionLabel: '第1版'}],
      scopes: [{channel: r.channel, territory: r.territory, rightsStart: r.rightsStart, rightsEnd: r.rightsEnd, exclusivity: 'nonexclusive'}],
      participants: [{partyKind: 'current_org', role: '権利保有'}]});
  }
  for (const s of WARNING_FIXTURES.slots) {
    await api.post('/broadcast/slots', {workId: works.get(s.workCode).id, broadcastMonth: s.broadcastMonth, stationName: s.stationName,
      periodFrom: `${s.broadcastMonth}-01`, periodTo: day(s.broadcastMonth, 31), plannedRuns: 1, sourceReference: '架空の編成案（デモ）', reason: '放送期間の前の枠（警告の確認用・架空）'});
  }
  log(`ウィンドウ ${windows}系列・${versions}版（連続ドラマ ${withSeries ? 'あり' : 'なし'}）`);
  return {skipped: false, windows, versions, withSeries, types: types.size};
}

// ---------- 2. 取引先別の配信・販売リスト ----------
// 明細は {work, code, start, end, rule, status, excl, method, rate, amount, pwc, cat, fields}。rule: date|auto_renew|perpetual|unknown、status: contracted|planned。
// 売上の架空データ（seed-sales-demo.mjs）の窓口と周期に合わせる: 配信A=公開7か月後から月次（SVOD）・配信B=4か月後から月次（TVOD）・配信C=10か月後から四半期（AVOD）、
// 放送BS=10か月後・地上波=16か月後（24か月の許諾）、レンタル=4か月後から月次、セル=5か月後から半期。
const eom = (ym) => day(ym, 31);
const first = (ym) => `${ym}-01`;
export function partnerListPlan() {
  const R = (n) => releaseOf(n);
  const pfa = [];
  for (let n = 1; n <= 20; n += 1) {
    const start = first(addMonths(R(n), 7));
    const base = {work: workCode(n), code: 'D005', start, end: eom(addMonths(R(n), 30)), rule: 'date', status: start <= EIGYO_DEMO.asOf ? 'contracted' : 'planned', excl: 'nonexclusive',
      method: 'RS', rate: '50', pwc: `DEMO-PFA-${pad(n)}`, cat: '見放題'};
    // 特別な明細（設計 §6 の必ず含めるもの）
    if (n === 1) Object.assign(base, {start: '2025-03-01', end: '2026-02-28', excl: 'exclusive', status: 'contracted', cat: '見放題（独占）'}); // 独占12か月 → 再契約まで1か月の空白
    if (n === 2) Object.assign(base, {start: '2025-03-01', end: '2026-02-28', rule: 'auto_renew', status: 'contracted'}); // 自動更新
    if (n === 3) base.fields = {sale_window: '2026-12 年末セール（架空）'};
    if (n === 5) base.end = '2026-10-20'; // 終了間近（30日以内）
    if (n === 6) Object.assign(base, {end: '2026-06-30', excl: 'exclusive'}); // 配信C の独占と重なる
    if (n === 7) base.end = '2026-11-15'; // 終了間近（60日以内）
    if (n === 9) base.end = '2026-12-10'; // 終了間近（90日以内）
    if (n === 11) Object.assign(base, {status: 'planned', cat: '見放題（交渉中）'}); // 予定のまま売上がある（契約済みの明細が無い売上）
    pfa.push(base);
  }
  return {
    fields: [
      {fieldKey: 'sale_window', label: 'セール実施期間', valueType: 'text', listKind: 'distribution', partnerCode: null, reason: '取引先の配信リストにある項目（架空）'},
      {fieldKey: 'viewing_hours', label: '視聴期間（時間）', valueType: 'integer', listKind: null, partnerCode: 'DEMO-PF-B', reason: '都度課金の取引先だけの項目（架空）'},
    ],
    lists: [
      {partnerCode: 'DEMO-PF-A', kind: 'distribution', name: '定額見放題の配信リスト（架空）', service: '架空配信A 見放題（架空）', contract: '配信基本契約 DEMO-CT-PFA（架空）', via: 'import',
        entries: pfa,
        // 再契約（2026-04-01 から・非独占）。前の明細は 2026-02-28 に終わっていて、2026年3月が空白。Excel の2回目の取込で入れる（再契約元は自動で結ぶ）
        renewals: [{work: 'DEMO-W01', code: 'D005', start: '2026-04-01', end: '2027-03-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '50', pwc: 'DEMO-PFA-01', cat: '見放題'}]},
      {partnerCode: 'DEMO-PF-B', kind: 'distribution', name: '都度課金の配信リスト（架空）', service: '架空配信B レンタル配信（架空）', via: 'api', entries: [
        {work: 'DEMO-W03', code: 'D004', start: '2025-01-01', rule: 'perpetual', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '60', cat: 'レンタル', fields: {viewing_hours: '48'}},
        {work: 'DEMO-W04', code: 'D004', start: '2025-02-01', end: '2027-01-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '60', cat: 'レンタル', fields: {viewing_hours: '48'}},
        {work: 'DEMO-W08', code: 'D004', start: '2025-06-01', end: '2026-05-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '60', cat: 'レンタル'},
        {work: 'DEMO-W10', code: 'D003', start: '2025-08-01', rule: 'perpetual', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '70', cat: '購入'},
      ]},
      {partnerCode: 'DEMO-PF-C', kind: 'distribution', name: '広告付き無料・見放題の配信リスト（架空）', service: '架空配信C（架空）', via: 'api', entries: [
        {work: 'DEMO-W01', code: 'D006', start: '2025-04-01', end: '2027-03-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '40', cat: '広告付き無料'},
        {work: 'DEMO-W03', code: 'D006', start: '2025-07-01', end: '2027-06-30', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '40', cat: '広告付き無料'},
        {work: 'DEMO-W04', code: 'D004', start: '2025-10-01', end: '2027-03-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '50', cat: 'レンタル'},
        {work: 'DEMO-W06', code: 'D005', start: '2026-01-01', end: '2026-12-31', rule: 'date', status: 'contracted', excl: 'exclusive', method: 'MG', amount: '3000000', cat: '見放題（独占）'},
      ]},
      {partnerCode: 'DEMO-TV-B', kind: 'distribution', name: 'BS放送の配信リスト（架空）', service: '架空BS放送（架空）', via: 'api', entries: [
        {work: 'DEMO-W01', code: 'B001', start: '2025-05-01', end: '2027-04-30', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'FLAT', amount: '4800000', cat: 'BS 2年3回'},
        {work: 'DEMO-W02', code: 'B001', start: '2025-07-01', end: '2027-06-30', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'FLAT', amount: '925000', cat: 'BS 2年2回'},
        {work: 'DEMO-W03', code: 'B001', start: '2025-07-01', end: '2027-06-30', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'FLAT', amount: '2100000', cat: 'BS 2年3回'},
        {work: 'DEMO-W04', code: 'B001', start: '2025-08-01', end: '2027-07-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'FLAT', amount: '3200000', cat: 'BS 2年3回'},
      ]},
      {partnerCode: 'DEMO-TV-A', kind: 'distribution', name: '地上波放送の配信リスト（架空）', service: '架空地上波テレビ（架空）', via: 'api', entries: [
        {work: 'DEMO-W01', code: 'B001', start: '2025-11-01', end: '2027-10-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'FLAT', amount: '6720000', cat: '地上波 2年1回'},
        {work: 'DEMO-W03', code: 'B001', start: '2026-01-01', end: '2027-12-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'FLAT', amount: '2940000', cat: '地上波 2年1回'},
      ]},
      {partnerCode: 'DEMO-RNT-A', kind: 'sales', name: 'レンタル卸の販売リスト（架空）', service: '架空レンタルチェーン（架空）', via: 'api', entries: [
        {work: 'DEMO-W01', code: 'R004', start: '2024-11-01', rule: 'perpetual', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '45', cat: 'レンタル（RSS）'},
        {work: 'DEMO-W02', code: 'R004', start: '2024-12-01', end: '2026-11-30', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '45', cat: 'レンタル（RSS）'},
        {work: 'DEMO-W03', code: 'R004', start: '2025-01-01', rule: 'perpetual', status: 'contracted', excl: 'nonexclusive', method: 'RS', rate: '45', cat: 'レンタル（RSS）'},
      ]},
      {partnerCode: 'DEMO-SEL-A', kind: 'sales', name: 'セル卸の販売リスト（架空）', service: '架空パッケージ販売（架空）', via: 'api', entries: [
        {work: 'DEMO-W01', code: 'S003', start: '2024-12-01', rule: 'perpetual', status: 'contracted', excl: 'nonexclusive', method: 'other', cat: '消化納品'},
        {work: 'DEMO-W02', code: 'S003', start: '2025-01-01', end: '2026-12-31', rule: 'date', status: 'contracted', excl: 'nonexclusive', method: 'other', cat: '消化納品'},
      ]},
    ],
    // 当社は売れるのに契約中の取引先が無い流通の確認用（W05 の AVOD）。W02 の EST（節1の販売条件）も同じく契約中の取引先が無い
    availabilities: [{workCode: 'DEMO-W05', distributionCode: 'D006', territory: '日本', releaseOn: '2025-09-01', salesEndOn: '2028-08-31', exclusivity: 'nonexclusive', terms: 'AVOD 非独占（架空）'}],
  };
}

const EXCLUSIVITY_TEXT = {exclusive: '独占', nonexclusive: '非独占', unknown: '未確認'};
const STATUS_TEXT = {contracted: '契約済', planned: '予定', withdrawn: '取り下げ'};
const RULE_TEXT = {date: '日付', auto_renew: '自動更新', perpetual: '期限なし', unknown: '未確認'};
const METHOD_TEXT = {RS: 'RS', FLAT: 'FLAT', MG: 'MG', other: 'その他', unverified: '未確認'};

// API の入力（Excel と同じキー）
function entryValues(entry, fieldIds) {
  const fields = {};
  for (const [key, value] of Object.entries(entry.fields || {})) fields[fieldIds.get(key)] = value;
  return {distribution_code: entry.code, territory: '日本', contract_start: entry.start, contract_end: entry.end || '', end_rule: entry.rule, status: entry.status,
    exclusivity: entry.excl, settlement_method: entry.method, rate_percent: entry.rate || '', amount_ex_tax: entry.amount || '', partner_work_code: entry.pwc || '',
    partner_category: entry.cat || '', source_reference: '架空の許諾通知書（デモ）', fields};
}

// 共通テンプレートの見出しに合わせた1行
function templateRow(headers, entry, fieldLabels) {
  const cells = headers.map(() => '');
  const put = (header, value) => { const index = headers.indexOf(header); if (index >= 0 && value !== undefined && value !== null) cells[index] = value; };
  put('作品コード', entry.work); put('流通ID', entry.code); put('地域', '日本'); put('契約開始日', entry.start); put('契約終了日', entry.end || '');
  put('終了の扱い', RULE_TEXT[entry.rule]); put('独占', EXCLUSIVITY_TEXT[entry.excl]); put('状態', STATUS_TEXT[entry.status]); put('取引方法', METHOD_TEXT[entry.method]);
  put('料率（%）', entry.rate || ''); put('契約金額（税抜）', entry.amount || ''); put('取引先側の作品コード', entry.pwc || ''); put('取引先側の区分', entry.cat || '');
  put('根拠', '架空の配信リスト（取引先の一覧・デモ）');
  for (const [key, value] of Object.entries(entry.fields || {})) put(fieldLabels.get(key), value);
  return cells;
}

async function importEntries(api, listId, entries, fieldLabels, {fileName, reason}) {
  const sheets = decodeXlsx(await api.bytes(`/partner-lists/${listId}/template.xlsx`));
  const input = sheets.find((sheet) => sheet.name === '入力');
  const meta = Object.fromEntries(sheets.find((sheet) => sheet.name === '_meta').rows.slice(1).map((row) => [row[0], row[1]]));
  const headers = input.rows[0].map((header) => String(header ?? ''));
  const table = {headers, rows: entries.map((entry, index) => ({rowNo: index + 2, cells: templateRow(headers, entry, fieldLabels)})), meta};
  const preview = await api.post(`/partner-lists/${listId}/import/preview`, {table, fileName, mode: 'partial'});
  if (!preview.token) throw new Error(`${fileName}: 登録するものがありません`);
  return api.post(`/partner-lists/${listId}/import/commit`, {token: preview.token, reason, confirmed: true});
}

async function seedPartnerLists(db, orgId, api, log) {
  const marker = await db.get('SELECT 1 FROM partner_lists l JOIN partners p ON p.org_id=l.org_id AND p.id=l.partner_id WHERE l.org_id=? AND p.code=?', [orgId, EIGYO_DEMO.partnerListsMarkerPartner]);
  if (marker) return {skipped: true};
  const plan = partnerListPlan();
  const partners = new Map((await api.get('/partner-lists')).partners.map((p) => [p.code, p.id]));
  for (const field of plan.fields) {
    await api.post('/partner-list-fields', {fieldKey: field.fieldKey, label: field.label, valueType: field.valueType, listKind: field.listKind, partnerId: field.partnerCode ? partners.get(field.partnerCode) : null, reason: field.reason});
  }
  const defined = (await api.get('/partner-list-fields')).fields;
  const fieldIds = new Map(defined.map((f) => [f.field_key, f.id]));
  const fieldLabels = new Map(defined.map((f) => [f.field_key, f.label]));
  const works = new Map((await api.get('/bootstrap')).works.map((work) => [work.code, work]));
  let entries = 0, imports = 0;
  for (const list of plan.lists) {
    const partnerId = partners.get(list.partnerCode);
    if (!partnerId) throw new Error(`取引先 ${list.partnerCode} がありません`);
    const created = await api.post('/partner-lists', {partnerId, listKind: list.kind, name: list.name, serviceName: list.service, contractReference: list.contract || null, reason: '取引先から届いた一覧を登録（架空データ・seed-eigyo-demo）'});
    if (list.via === 'import') {
      await importEntries(api, created.id, list.entries, fieldLabels, {fileName: `${list.name}_2026-04.xlsx`, reason: '取引先の一覧（Excel）を取り込む（架空データ）'});
      imports += 1;
      if (list.renewals?.length) {
        await importEntries(api, created.id, list.renewals, fieldLabels, {fileName: `${list.name}_再契約_2026-04.xlsx`, reason: '再契約の通知を取り込む（架空データ）'});
        imports += 1;
      }
      entries += list.entries.length + (list.renewals?.length || 0);
    } else {
      for (const entry of list.entries) {
        const work = works.get(entry.work);
        if (!work) throw new Error(`作品 ${entry.work} がありません`);
        await api.post(`/partner-lists/${created.id}/entries`, {workId: work.id, values: entryValues(entry, fieldIds), reason: '許諾通知書の内容を登録（架空データ）'});
        entries += 1;
      }
    }
  }
  for (const a of plan.availabilities) {
    await api.post('/sales-catalog', {workId: works.get(a.workCode).id, distributionCode: a.distributionCode, territory: a.territory, baseVersion: 0, releaseOn: a.releaseOn, salesEndOn: a.salesEndOn,
      terms: a.terms, sourceReference: '架空の販売条件（デモ）', exclusivity: a.exclusivity, status: 'confirmed'});
  }
  log(`取引先別リスト ${plan.lists.length}件・明細 ${entries}件（Excel 取込 ${imports}回）・追加の列 ${plan.fields.length}件`);
  return {skipped: false, lists: plan.lists.length, entries, imports, fields: plan.fields.length};
}

// ---------- 3. 売上集計シート（83列） ----------
// 為替レート（1外貨あたりの円・架空）。海外の売上の地域ごと
export const SALES_SHEET_RATES = Object.freeze({北米: {code: 'USD', rate: '148.25'}, 台湾: {code: 'TWD', rate: '4.6125'}});
// 外貨の額（小数2桁）＝ 円の計上額 ÷ レート。×100 の整数で丸める（外貨×レートが円と1円まで合う）
export const foreignAmountOf = (yen, rate) => (Math.round(yen * 100 / Number(rate)) / 100).toFixed(2);
// 劇場の売上（作品の劇場公開の月から4か月）に入れる劇場名・券種（W01〜W06）
export const THEATRE_ATTRIBUTES = Object.freeze([
  {workCode: 'DEMO-W01', theatre: '架空シネマ中央（架空）', category: '一般', unitIncTax: '1900'},
  {workCode: 'DEMO-W02', theatre: '架空ミニシアター北口（架空）', category: '一般', unitIncTax: '1800'},
  {workCode: 'DEMO-W03', theatre: '架空シネマ中央（架空）', category: 'シニア', unitIncTax: '1300'},
  {workCode: 'DEMO-W04', theatre: '架空シネマ湾岸（架空）', category: '一般', unitIncTax: '2000'},
  {workCode: 'DEMO-W05', theatre: '架空ミニシアター北口（架空）', category: '学生', unitIncTax: '1500'},
  {workCode: 'DEMO-W06', theatre: '架空シネマ湾岸（架空）', category: '一般', unitIncTax: '1900'},
]);
// 配信A（定額制）の視聴UU数 = 計上額（税抜）÷ 120（W01〜W05 の最初の6か月）。レンタルの延滞・回転率（W01〜W04 の最初の4か月）
export const uniqueViewersOf = (amountExTax) => Math.max(1, Math.round(amountExTax / 120));
export const rentalAttributesOf = (amountExTax, k) => ({overdue_count: 3 + k * 2, overdue_amount: (3 + k * 2) * 300, overdue_share: Math.round((3 + k * 2) * 300 * 0.45), rental_turnover: (2.4 - k * 0.3).toFixed(2)});
export const SALES_SHEET_VIEWS = Object.freeze([
  {name: '劇場の売上（劇場名・券種）（架空の保存例）', definition: {columns: ['booking_month', 'work_code', 'ref_work_title', 'partner_code', 'theatre_name', 'ticket_category', 'ticket_unit_inc_tax', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax'],
    grain: 'detail', dimensions: [], monthBasis: 'accounting', taxBasis: 'ex', pivot: false, hideEmpty: true, filters: {kind: 'theatrical'}}},
  {name: '取引先×流通の月別（架空の保存例）', definition: {columns: ['amount_ex_tax', 'tax_amount', 'amount_inc_tax', 'rs_count', 'tax_rate'], grain: 'aggregate', dimensions: ['partner', 'distribution'],
    monthBasis: 'accounting', taxBasis: 'ex', pivot: true, hideEmpty: true, filters: {}}},
]);

async function seedSalesSheet(db, orgId, api, log) {
  const initial = await seedInitialSalesSheet(db, orgId, api, log);
  // 83列を採用済みの架空組織にも追加できる独立した節。API が残す採用の監査を目印にする。
  const marker = await db.get(`SELECT 1 FROM audit_log WHERE org_id=? AND entity_type='sales_sheet_column' AND action='adopt'
    AND json_extract(detail_json,'$.template')=? LIMIT 1`, [orgId, ADDITIONAL_CATALOG_VERSION]);
  let additional = {skipped: true};
  if (!marker) {
    const out = await api.post('/sales-sheet/columns/adopt-additional', {reason: '架空データ（デモ）の組織で売上集計シートの追加の列を採用（seed-eigyo-demo）'});
    additional = {skipped: out.adopted === 0, columns: out.adopted};
    log(`売上集計シート: 追加の列 ${out.adopted}列を採用`);
  }
  return {...initial, skipped: initial.skipped && additional.skipped, additional};
}

async function seedInitialSalesSheet(db, orgId, api, log) {
  if (await db.get('SELECT 1 FROM sales_sheet_column_versions WHERE org_id=? LIMIT 1', [orgId])) return {skipped: true};
  await api.post('/sales-sheet/columns/adopt', {reason: '架空データ（デモ）の組織で売上集計シートの初期の83列を採用（seed-eigyo-demo）'});
  const lines = await db.all(`SELECT s.id,s.amount_ex_tax,s.accounting_month,w.code AS work_code,p.code AS partner_code,r.kind,
      (SELECT d.territory FROM sale_distribution_versions d WHERE d.org_id=s.org_id AND d.sale_id=s.id ORDER BY d.version_no DESC LIMIT 1) AS territory
    FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id JOIN partners p ON p.org_id=s.org_id AND p.id=s.partner_id
    WHERE s.org_id=? AND r.status='active' ORDER BY w.code,s.accounting_month,s.id`, [orgId]);
  // 外貨（海外の売上すべて）
  let currencies = 0;
  for (const line of lines.filter((row) => row.partner_code === 'DEMO-OS-A' && SALES_SHEET_RATES[row.territory])) {
    const {code, rate} = SALES_SHEET_RATES[line.territory];
    await api.post(`/sales-sheet/sales/${line.id}/currency`, {baseVersion: 0, currencyCode: code, originalAmount: foreignAmountOf(line.amount_ex_tax, rate), exchangeRate: rate,
      rateDate: `${line.accounting_month}-01`, basis: `架空の為替レート表 ${line.accounting_month}（デモ）`, reason: '海外セールスの契約通貨と換算レートを記録（架空データ）'});
    currencies += 1;
  }
  const changes = [];
  const push = (saleId, columnKey, value) => changes.push({saleId, columnKey, baseVersion: 0, value: String(value)});
  // 劇場名・券種（劇場の売上）
  for (const item of THEATRE_ATTRIBUTES) {
    for (const line of lines.filter((row) => row.work_code === item.workCode && row.kind === 'theatrical')) {
      push(line.id, 'theatre_name', item.theatre);
      push(line.id, 'ticket_category', item.category);
      push(line.id, 'ticket_unit_inc_tax', item.unitIncTax);
    }
  }
  // 視聴UU数（配信A の最初の6か月・W01〜W05）
  for (const n of [1, 2, 3, 4, 5]) {
    for (const line of lines.filter((row) => row.work_code === `DEMO-W${String(n).padStart(2, '0')}` && row.partner_code === 'DEMO-PF-A').slice(0, 6)) push(line.id, 'unique_viewers', uniqueViewersOf(line.amount_ex_tax));
  }
  // 延滞・回転率（レンタルの最初の4か月・W01〜W04）
  for (const n of [1, 2, 3, 4]) {
    lines.filter((row) => row.work_code === `DEMO-W${String(n).padStart(2, '0')}` && row.partner_code === 'DEMO-RNT-A').slice(0, 4).forEach((line, k) => {
      for (const [key, value] of Object.entries(rentalAttributesOf(line.amount_ex_tax, k))) push(line.id, key, value);
    });
  }
  for (let start = 0; start < changes.length; start += 400) {
    await api.post('/sales-sheet/values', {changes: changes.slice(start, start + 400), reason: '取引先の報告書にある項目を売上集計シートへ記録（架空データ）'});
  }
  for (const view of SALES_SHEET_VIEWS) await api.post('/sales-sheet/views', {...view, reason: 'よく見る形を保存（架空データ）'});
  log(`売上集計シート: 列の採用・外貨 ${currencies}件・拡張属性の値 ${changes.length}件・保存した形 ${SALES_SHEET_VIEWS.length}件`);
  return {skipped: false, currencies, attributes: changes.length, views: SALES_SHEET_VIEWS.length};
}

// ---------- 4. 提案資料 ----------
// 公開前の新作（2026-10〜2027-03 に1本ずつ）。劇場公開と同じ月に配信を段階的に始める（PVOD 同時→EST・TVOD 先行→通常）。
// 公開は基準日（2026-09-25）の後なので予定。N01・N02 は配信の契約まで済んでいる（確定）
export const PROPOSAL_DEMO = Object.freeze({
  markerWork: 'DEMO-N06',
  project: Object.freeze({code: 'DEMO-P5', title: '架空ラインナップ2026後期（架空）', budget: 150000000}),
  newWorks: Object.freeze([
    {code: 'DEMO-N01', title: '潮見坂の郵便配達（架空）', release: '2026-10', confirmed: true},
    {code: 'DEMO-N02', title: '冬の観覧車（架空）', release: '2026-11', confirmed: true},
    {code: 'DEMO-N03', title: '三番線の忘れもの（架空）', release: '2026-12'},
    {code: 'DEMO-N04', title: '雪解けの採石場（架空）', release: '2027-01'},
    {code: 'DEMO-N05', title: '放課後の気象観測（架空）', release: '2027-02'},
    {code: 'DEMO-N06', title: '春待ちの灯籠流し（架空）', release: '2027-03'},
  ].map((work) => Object.freeze(work))),
  // 製作委員会の作品（seed-sales-demo.mjs の COMMITTEES と同じ）。権利範囲は委員会の調達ケースの改訂で足す
  committeeWorks: Object.freeze(['DEMO-W01', 'DEMO-W03', 'DEMO-W04', 'DEMO-W07', 'DEMO-W10', 'DEMO-W12', 'DEMO-W15', 'DEMO-W18']),
  rightsYears: 7,
});
const newWorkOf = (code) => PROPOSAL_DEMO.newWorks.find((work) => work.code === code) || null;
const newWorkIndex = (code) => PROPOSAL_DEMO.newWorks.findIndex((work) => work.code === code) + 1;
// 作品の最初の月（W は劇場公開の月、N は新作の公開の月）
export const releaseMonthOf = (code) => newWorkOf(code)?.release || releaseOf(Number(code.slice(-2)));

// 窓の計画（版の順。節1の windowPlan と同じ形）。W09〜W20 の EST先行・TVOD先行は公開の3か月後（2025-06〜2026-05）、
// W13〜W20 の PVOD② は PVOD先行の終わりの翌日から2か月（2025-10〜2026-05）。新作は公開の月に PVOD・先行・通常、3か月後に SVOD先行、15か月後に SVOD通常
export function proposalWindowPlan() {
  const plan = [];
  const add = (code, typeKey, version) => plan.push({workCode: code, typeKey, versions: [version]});
  const statusFor = (start) => (start <= EIGYO_DEMO.asOf ? 'confirmed' : 'draft');
  for (let n = 9; n <= 20; n += 1) {
    const code = workCode(n), R3 = addMonths(releaseOf(n), 3);
    add(code, 'est_early', {start: first(R3), end: eom(R3), status: statusFor(first(R3)), fields: {price_ex_tax: '2500', exclusivity: 'exclusive'}, reason: 'EST先行（1か月・独占・架空）'});
    add(code, 'tvod_early', {start: day(R3, 15), end: eom(R3), status: statusFor(day(R3, 15)), fields: {price_ex_tax: '500', viewing_hours: '48', exclusivity: 'exclusive'}, reason: 'TVOD先行（半月・独占・架空）'});
  }
  // 年だけ決まっている窓（提案資料の「月が決まっていない候補」の確認用。2026年の各月の TVOD先行基準に出る）
  add('DEMO-W08', 'tvod_early', {start: '2026', status: 'draft', reason: '再先行の打診・年だけ決まっている（架空）'});
  for (let n = 13; n <= 20; n += 1) {
    const code = workCode(n), R = releaseOf(n);
    const start = day(addMonths(R, 3), 15);
    add(code, 'pvod_second', {start, end: day(addMonths(R, 5), 14), status: n === 20 ? 'draft' : statusFor(start), fields: {price_ex_tax: '2000', viewing_hours: '48', exclusivity: 'nonexclusive'},
      reason: 'PVOD②（PVOD先行の後の2か月・架空）'});
  }
  PROPOSAL_DEMO.newWorks.forEach((work, index) => {
    const M = work.release, k = index + 1;
    const status = work.confirmed ? 'confirmed' : 'draft';
    const reason = (text) => `${text}（公開前の新作・架空）`;
    add(work.code, 'theatrical', {start: day(M, 2), status, reason: reason('劇場公開日')});
    add(work.code, 'pvod_early', {start: day(M, 2), end: day(M, 15), announce: day(addMonths(M, -1), 20), status, fields: {price_ex_tax: '2500', viewing_hours: '48', exclusivity: 'nonexclusive'}, reason: reason('劇場と同時のPVOD（2週間）')});
    add(work.code, 'pvod_second', {start: day(M, 16), end: eom(addMonths(M, 1)), status, fields: {price_ex_tax: '2000', viewing_hours: '48', exclusivity: 'nonexclusive'}, reason: reason('PVOD②')});
    add(work.code, 'est_early', {start: day(M, 9), end: day(M, 22), status, fields: {price_ex_tax: '2800', exclusivity: 'exclusive'}, reason: reason('EST先行（2週間・独占）')});
    add(work.code, 'tvod_early', {start: day(M, 9), end: day(M, 22), status, fields: {price_ex_tax: '600', viewing_hours: '48', exclusivity: 'exclusive'}, reason: reason('TVOD先行（2週間・独占）')});
    add(work.code, 'est_regular', {start: day(M, 23), status, fields: {price_ex_tax: '2200', exclusivity: 'nonexclusive'}, reason: reason('EST通常（期限なし）')});
    add(work.code, 'tvod_regular', {start: day(M, 23), end: eom(addMonths(M, 36)), status, fields: {price_ex_tax: '500', viewing_hours: '48', exclusivity: 'nonexclusive'}, reason: reason('TVOD通常')});
    add(work.code, 'svod_early', {start: first(addMonths(M, 3)), end: eom(addMonths(M, 14)), status: 'draft', fields: {price_ex_tax: String(200000 - (k - 1) * 10000), exclusivity: 'exclusive'},
      reason: reason('SVOD先行（独占12か月・月額単価）')});
    add(work.code, 'svod_regular', {start: first(addMonths(M, 15)), end: eom(addMonths(M, 38)), status: 'draft', fields: {price_ex_tax: '90000', exclusivity: 'nonexclusive'}, reason: reason('SVOD通常（月額単価）')});
  });
  return plan;
}

// 既存の SVOD の窓に足す月額単価（税抜・架空）。W01 の SVOD先行は「単価が無いと空欄」の確認用に入れない。W15 の SVOD先行は取り下げ
export function svodPricePlan() {
  const out = [];
  for (let n = 1; n <= 20; n += 1) {
    if (n % 2 === 1 && n !== 1 && n !== 15) out.push({workCode: workCode(n), typeKey: 'svod_early', price: 150000 + (n % 4) * 25000});
    if (n <= 12) out.push({workCode: workCode(n), typeKey: 'svod_regular', price: 60000 + (n % 3) * 10000});
  }
  return out;
}

// 配信の権利範囲（日本・独占・公開の月の1日から7年）。W02 は節1の権利範囲（2027-07-31 まで・警告の確認用）のままにする
export function proposalRightsPlan() {
  const codes = [...Array.from({length: 20}, (_, i) => workCode(i + 1)).filter((code) => code !== 'DEMO-W02'), ...PROPOSAL_DEMO.newWorks.map((work) => work.code)];
  return codes.map((code) => {
    const start = releaseMonthOf(code);
    return {workCode: code, channel: '配信', territory: '日本', rightsStart: first(start), rightsEnd: eom(addMonths(start, PROPOSAL_DEMO.rightsYears * 12 - 1)), exclusivity: 'exclusive',
      committee: PROPOSAL_DEMO.committeeWorks.includes(code)};
  });
}

// 作品情報（どれも架空）。フリガナ・英題は作品ごとに書き下す
const TITLE_INFO = Object.freeze({
  'DEMO-W01': ['ヨアケノカモツセン', 'The Dawn Freight Line'], 'DEMO-W02': ['シチガツノヒョウホンシツ', 'The July Specimen Room'],
  'DEMO-W03': ['ウミギリノアーカイブ', 'Sea Fog Archive'], 'DEMO-W04': ['スナドケイノマチ', 'Hourglass Town'],
  'DEMO-W05': ['ヒトリボッチノテンモンダイ', 'The Lonely Observatory'], 'DEMO-W06': ['カミヒコウキノユクエ', 'Where Paper Planes Go'],
  'DEMO-W07': ['アメアガリノシンゴウキ', 'Traffic Light After the Rain'], 'DEMO-W08': ['トウダイモリノゴゴ', "The Lighthouse Keeper's Afternoon"],
  'DEMO-W09': ['ギンイロノジテンシャ', 'The Silver Bicycle'], 'DEMO-W10': ['フウリントテンコウセイ', 'Wind Chimes and the New Student'],
  'DEMO-W11': ['マヨナカノキュウスイトウ', 'The Midnight Water Tower'], 'DEMO-W12': ['シロイサカミチノキオク', 'Memories of the White Slope'],
  'DEMO-W13': ['スイヨウビノヒョウリュウシャ', 'Wednesday Castaways'], 'DEMO-W14': ['イテツクロメンデンシャ', 'The Frozen Streetcar'],
  'DEMO-W15': ['ハナノナイオンシツ', 'The Greenhouse Without Flowers'], 'DEMO-W16': ['トオイキテキノマチ', 'Town of the Distant Whistle'],
  'DEMO-W17': ['ゲツヨウビノトショガカリ', 'The Monday Librarian'], 'DEMO-W18': ['サヨナラノカッソウロ', 'Runway of Goodbyes'],
  'DEMO-W19': ['ハクメイノパンヤ', 'The Twilight Bakery'], 'DEMO-W20': ['ホクイヨンジュウサンドノヤクソク', 'A Promise at 43 Degrees North'],
  'DEMO-N01': ['シオミザカノユウビンハイタツ', 'The Shiomizaka Mail Carrier'], 'DEMO-N02': ['フユノカンランシャ', 'The Winter Ferris Wheel'],
  'DEMO-N03': ['サンバンセンノワスレモノ', 'Left Behind on Platform Three'], 'DEMO-N04': ['ユキドケノサイセキジョウ', 'The Quarry in the Thaw'],
  'DEMO-N05': ['ホウカゴノキショウカンソク', 'After-School Weather Watch'], 'DEMO-N06': ['ハルマチノトウロウナガシ', 'Lanterns Waiting for Spring'],
});
const GENRES = ['ヒューマンドラマ', 'ミステリー', '青春', 'コメディ', 'サスペンス', 'ファンタジー', 'ロードムービー', '家族ドラマ'];
const PLACES = ['港町', '山あいの集落', '終着駅のある町', '雪深い盆地', '川沿いの商店街', '海辺の団地', '古い映画館のある町', '島の小学校'];
const HEROES = ['郵便局員', '元天文部の女子高生', '定年間近の鉄道員', '引っ越してきた少年', '売れない漫画家', '夜勤明けの看護師', '町の写真館の三代目', '廃業を決めたパン職人'];
const EVENTS = ['一通の宛先不明の手紙', '閉館の知らせ', '三十年ぶりの帰郷', '祖母の遺した地図', '見知らぬ少女との約束', '古いフィルムの発見', '季節外れの台風', '町の祭りの中止'];
const FAMILY = ['朝霧', '久遠', '汐見', '柊', '真砂', '鳴海', '高遠', '水無瀬', '樫村', '鈴鹿', '雨宮', '白石'];
const GIVEN = ['蒼', '灯', 'ひかり', '透', '湊', '千景', '柚', '航', '紬', '颯', '澪', '栞'];
const personOf = (n, k) => `${FAMILY[(n * 3 + k) % FAMILY.length]} ${GIVEN[(n * 5 + k * 7) % GIVEN.length]}（架空）`;

export function catalogPlan(code, title) {
  const n = newWorkOf(code) ? 20 + newWorkIndex(code) : Number(code.slice(-2));
  const base = title.replace('（架空）', '');
  const place = PLACES[n % PLACES.length], hero = HEROES[(n * 3) % HEROES.length], event = EVENTS[(n * 5) % EVENTS.length];
  const year = Number(releaseMonthOf(code).slice(0, 4)) - (newWorkOf(code) ? 0 : 1);
  return {
    baseRevision: 0,
    synopsis_short: `${place}で暮らす${hero}が、${event}をきっかけに、忘れかけていた約束をたどり直す（架空のあらすじ）。`,
    synopsis_long: `${place}で暮らす${hero}は、毎日同じ道を往復するだけの日々を送っている。ある日、${event}が届き、町の誰もが口を閉ざしてきた出来事が少しずつ明らかになる。`
      + `家族と友人、そして町そのものと向き合いながら、主人公は自分が本当に守りたかったものに気づいていく。『${base}』は、小さな町の一年を描く群像劇である（架空のあらすじ）。`,
    catch_short: `あの日の約束を、まだ覚えている。（架空）`,
    catch_long: `${place}の一年と、ひとつの約束。見送った人と、残った人の物語。（架空のキャッチコピー）`,
    production_year: year, creation_year: year,
    source_reference: '架空の作品資料（デモ・seed-eigyo-demo）',
    credits: [
      {role: 'director', name: personOf(n, 0), detail: null},
      {role: 'writer', name: personOf(n, 1), detail: null},
      {role: 'cast', name: personOf(n, 2), detail: '主演'},
      {role: 'cast', name: personOf(n, 3), detail: null},
      {role: 'cast', name: personOf(n, 4), detail: null},
      {role: 'staff', name: personOf(n, 5), detail: '撮影'},
      {role: 'staff', name: personOf(n, 6), detail: '音楽'},
    ],
    editions: [{edition_key: 'main', name: '本編', runtime_seconds: (88 + (n * 7) % 40) * 60, aspect_ratio: '1.85:1', rating_authority: '映倫', rating_code: n % 5 === 0 ? 'PG12' : 'G',
      country: ['日本'], language: n % 6 === 0 ? ['日本語', '英語'] : ['日本語'], music_society: []}],
    bindings: [],
  };
}

export function profilePlan(code, title) {
  const n = newWorkOf(code) ? 20 + newWorkIndex(code) : Number(code.slice(-2));
  const [kana, english] = TITLE_INFO[code];
  const base = title.replace('（架空）', '');
  const year = Number(releaseMonthOf(code).slice(0, 4)) - (newWorkOf(code) ? 0 : 1);
  const committee = PROPOSAL_DEMO.committeeWorks.includes(code);
  const image = n % 2 === 1
    ? {image_url: `https://example.invalid/demo/key-visual/${code}.jpg`, image_key: '', image_file_name: `${code}_key-visual.jpg`}
    : {image_url: '', image_key: `demo/key-visual/${code}.jpg`, image_file_name: `${code}_key-visual.jpg`};
  return {
    baseRevision: 0, title_kana: kana, title_en: english, genre: GENRES[n % GENRES.length],
    copyright_notice: committee ? `©${year}「${base}」製作委員会（架空）` : `©${year} 架空データ映像（架空）`,
    caution: n % 3 === 0 ? '劇中の楽曲は配信の期間に制限がある（架空の注意事項）。予告編の使用は事前に確認する。' : '',
    intro_short: `${PLACES[n % PLACES.length]}を舞台に、${HEROES[(n * 3) % HEROES.length]}の一年を描く（架空のイントロダクション）。`,
    intro_long: `『${base}』は、${PLACES[n % PLACES.length]}を舞台にした${GENRES[n % GENRES.length]}。地元の人々の協力を得て、四季を通して撮影した（架空のイントロダクション）。`
      + '小さな出来事の積み重ねが、やがて町全体を動かしていく。',
    info_url: `https://example.invalid/demo/works/${code}`,
    ...image,
    source_reference: '架空の宣伝資料（デモ・seed-eigyo-demo）',
  };
}

const plainInput = (version, type) => {
  const input = currentWindowInput(version, type);
  return {start: input.start ?? '', end: input.end ?? '', announce: input.announce ?? '', status: input.status, fields: Object.fromEntries(Object.entries(input.fields).map(([k, v]) => [k, String(v)]))};
};

async function seedProposals(db, orgId, api, log) {
  const marker = await db.get('SELECT 1 FROM work_proposal_profiles d JOIN works w ON w.org_id=d.org_id AND w.id=d.work_id WHERE d.org_id=? AND w.code=?', [orgId, PROPOSAL_DEMO.markerWork]);
  if (marker) return {skipped: true};
  const done = {works: 0, windows: 0, prices: 0, rights: 0, catalogs: 0, profiles: 0};
  // 1. 公開前の新作（案件 DEMO-P5）
  let boot = await api.get('/bootstrap');
  let project = boot.projects.find((p) => p.code === PROPOSAL_DEMO.project.code);
  if (!project) project = {id: (await api.post('/projects', {code: PROPOSAL_DEMO.project.code, title: PROPOSAL_DEMO.project.title, status: 'active', budget_yen: PROPOSAL_DEMO.project.budget})).id};
  for (const work of PROPOSAL_DEMO.newWorks) {
    if (boot.works.some((w) => w.code === work.code)) continue;
    await api.post('/works', {project_id: project.id, code: work.code, title: work.title, format: 'film', forecast_yen: 30000000});
    done.works += 1;
  }
  boot = await api.get('/bootstrap');
  const works = new Map(boot.works.map((work) => [work.code, work]));
  const types = new Map((await api.get('/release-window-types')).types.map((type) => [type.type_key, type]));
  const windowsNow = async () => new Map((await api.get('/release-windows?pageSize=200')).rows.map((row) => [row.work_code, row.windows]));
  // 2. 窓（まだ無い系列だけ）
  let current = await windowsNow();
  for (const item of proposalWindowPlan()) {
    if (current.get(item.workCode)?.[item.typeKey]?.version) continue;
    const version = item.versions[0];
    await api.post('/release-windows', {workId: works.get(item.workCode).id, typeId: types.get(item.typeKey).id, baseVersion: 0, start: version.start, end: version.end ?? '', announce: version.announce ?? '',
      status: version.status, fields: version.fields || {}, sourceReference: '架空の営業資料（デモ）', reason: version.reason});
    done.windows += 1;
  }
  // 3. SVOD の月額単価（今の版の日付・状態のまま、価格だけを入れた新しい版）
  current = await windowsNow();
  for (const item of svodPricePlan()) {
    const version = current.get(item.workCode)?.[item.typeKey]?.version;
    if (!version || version.fields?.price_ex_tax) continue;
    const type = types.get(item.typeKey);
    const input = plainInput(version, type);
    await api.post('/release-windows', {workId: works.get(item.workCode).id, typeId: type.id, baseVersion: version.version_no, ...input, fields: {...input.fields, price_ex_tax: String(item.price)},
      sourceReference: '架空の SVOD 提案条件（デモ）', reason: 'SVOD の月額単価（税抜）を入れた（架空）'});
    done.prices += 1;
  }
  // 4. 配信の権利範囲（まだ配信の範囲が無い作品だけ）。委員会の作品は委員会の調達ケースを改訂して範囲を足す（出資者はそのまま）
  const scoped = new Set((await db.all(`SELECT DISTINCT w.code FROM rights_intake_scopes s JOIN rights_intake_cases c ON c.org_id=s.org_id AND c.id=s.intake_case_id JOIN works w ON w.org_id=c.org_id AND w.id=c.work_id
    WHERE s.org_id=? AND s.channel='配信' AND NOT EXISTS(SELECT 1 FROM rights_intake_cases n WHERE n.org_id=c.org_id AND n.source_case_id=c.id)`, [orgId])).map((row) => row.code));
  for (const item of proposalRightsPlan()) {
    if (scoped.has(item.workCode)) continue;
    const work = works.get(item.workCode);
    const scope = {channel: item.channel, territory: item.territory, rightsStart: item.rightsStart, rightsEnd: item.rightsEnd, exclusivity: item.exclusivity};
    const committeeCase = item.committee ? (await api.get(`/intakes?workId=${work.id}`)).cases.find((row) => row.intakeType === 'committee' && !row.source_case_id) : null;
    if (committeeCase) {
      await api.post('/intakes', {workId: work.id, sourceCaseId: committeeCase.id, caseCode: `${item.workCode}-CMT-R2`, title: `${committeeCase.title}（配信の権利範囲を追記）`, intakeType: 'committee',
        documents: committeeCase.documents.map((d) => ({title: d.title, reference: d.reference, versionLabel: d.version_label})),
        participants: committeeCase.participants.map((p) => ({partyKind: p.party_kind, partnerId: p.partner_id, role: p.role, investmentYen: p.investment_yen, explicitShareBps: p.explicit_share_bps})),
        scopes: [scope]});
    } else {
      await api.post('/intakes', {workId: work.id, caseCode: `${item.workCode}-RIGHTS`, title: `${work.title} 配信の権利範囲（架空）`, intakeType: 'sole_owned',
        documents: [{title: `${work.title} 権利許諾書（架空）`, reference: `架空の許諾書 ${item.workCode}-RIGHTS`, versionLabel: '第1版'}],
        scopes: [scope], participants: [{partyKind: 'current_org', role: '権利保有'}]});
    }
    done.rights += 1;
  }
  // 5. 作品カタログと 6. 提案資料に出す作品情報（まだ版が無い作品だけ。W・N の26作品）
  const codes = [...Array.from({length: 20}, (_, i) => workCode(i + 1)), ...PROPOSAL_DEMO.newWorks.map((work) => work.code)];
  const catalogs = new Set((await db.all('SELECT DISTINCT w.code FROM catalog_profiles p JOIN works w ON w.org_id=p.org_id AND w.id=p.work_id WHERE p.org_id=?', [orgId])).map((row) => row.code));
  for (const code of codes) {
    if (catalogs.has(code)) continue;
    await api.post(`/work-catalog/${works.get(code).id}`, catalogPlan(code, works.get(code).title));
    done.catalogs += 1;
  }
  const profiles = new Set((await db.all('SELECT DISTINCT w.code FROM work_proposal_profiles p JOIN works w ON w.org_id=p.org_id AND w.id=p.work_id WHERE p.org_id=?', [orgId])).map((row) => row.code));
  for (const code of codes) {
    if (profiles.has(code)) continue;
    await api.post(`/work-proposal-profiles/${works.get(code).id}`, profilePlan(code, works.get(code).title));
    done.profiles += 1;
  }
  log(`提案資料: 新作 ${done.works}本・窓 ${done.windows}系列・SVOD の月額単価 ${done.prices}件・権利範囲 ${done.rights}件・作品カタログ ${done.catalogs}件・提案用の作品情報 ${done.profiles}件`);
  return {skipped: false, ...done};
}

export async function seedEigyoDemo(db, {log = () => {}} = {}) {
  const org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  if (!org || !await db.get('SELECT 1 FROM works WHERE org_id=? AND code=?', [org.id, EIGYO_DEMO.windowsMarkerWork])) {
    throw new Error(`組織 ${SALES_DEMO.orgCode} の売上の架空データがありません。先に scripts/seed-sales-demo.mjs を流してください`);
  }
  const api = await login(db);
  if ((await api.get('/session')).user.orgId !== org.id) throw new Error('架空の管理者が DEMO-SALES で入れていません');
  const windows = await seedWindows(db, org.id, api, log);
  const partnerLists = await seedPartnerLists(db, org.id, api, log);
  const salesSheet = await seedSalesSheet(db, org.id, api, log);
  const proposals = await seedProposals(db, org.id, api, log);
  return {orgId: org.id, windows, partnerLists, salesSheet, proposals};
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
    const result = await seedEigyoDemo(db, {log: (message) => console.log(`  ${message}`)});
    const done = Object.entries(result).filter(([key, value]) => key !== 'orgId' && !value.skipped).map(([key]) => key);
    console.log(done.length ? `投入しました（${((Date.now() - started) / 1000).toFixed(1)}秒）: ${JSON.stringify(result)}` : `${SALES_DEMO.orgCode} の営業基幹の架空データは投入済みです（何もしませんでした）`);
  } finally {
    db.close();
  }
}
