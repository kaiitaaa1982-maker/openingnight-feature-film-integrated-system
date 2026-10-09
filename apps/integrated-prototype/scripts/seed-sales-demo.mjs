#!/usr/bin/env node
// 売上基幹（計上・MG・ロイヤリティ・製作委員会）を画面で確かめるための架空データを、別組織 DEMO-SALES に投入する。
// 設計: docs/platform/team-development/royalty-committee-design.md §6。
// 使い方: node scripts/seed-sales-demo.mjs --db <SQLiteのパス> [--as-of 2026-09-25]
// ・--db の指定は必須。data/integrated.sqlite へは --allow-main-db を付けたときだけ書く。本番のD1・設定・秘密値は読まない。
// ・直接SQLで作るのは組織・利用者・所属（と、取込が参照する組織の項目定義の版 schema_meta）だけ。
//   ほかはすべて API を通して登録するので、検証・トリガー・監査は画面から登録したときと同じになる。
// ・架空の管理者 demo-admin@openingnight.invalid は DEMO-SALES だけに所属する。既存の架空管理者 admin@openingnight.invalid にも
//   DEMO-SALES の所属を足し、ローカルで組織の切替を試せるようにする。
// ・2回流しても増えない（DEMO-SALES に作品があれば何もしない）。コードはすべて DEMO-*、名前にはすべて「架空」を付ける。
// ・API の登録は取り消せないので、途中で失敗したときは新しいDBファイルで流し直す。
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {LocalDatabase} from '../src/db.mjs';
import {expenseDemoWriter} from './seed-expense-support.mjs';
import {createApp} from '../src/app.mjs';
import {toCsv} from '../src/csv.mjs';

export const SALES_DEMO = Object.freeze({
  orgCode: 'DEMO-SALES', orgName: '架空データ（デモ）',
  adminEmail: 'demo-admin@openingnight.invalid', adminName: '架空デモ管理者', fixtureAdminEmail: 'admin@openingnight.invalid',
  asOf: '2026-09-25', // 最後の一括作成と、報告・支払の記録の基準日
  stageAsOf: '2026-01-15', // 1回目の一括作成（2025年12月締めまで）。この後に保留の解除と遅れて届いた報告を入れる
  salesFrom: '2024-07', salesTo: '2026-06',
});

// ---------- 月・日 ----------
const pad = (n) => String(n).padStart(2, '0');
export function addMonths(ym, n) {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const dayOf = (ym, d) => `${ym}-${pad(d === 'eom' ? lastDay(ym) : Math.min(d, lastDay(ym)))}`;
const minusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
function quarterOf(ym) {
  const q = Math.floor((Number(ym.slice(5, 7)) - 1) / 3);
  const start = `${ym.slice(0, 4)}-${pad(q * 3 + 1)}`;
  return {start, end: addMonths(start, 2), label: `${ym.slice(0, 4)}Q${q + 1}`};
}
function halfOf(ym) {
  const second = Number(ym.slice(5, 7)) > 6;
  const start = `${ym.slice(0, 4)}-${second ? '07' : '01'}`;
  return {start, end: addMonths(start, 5), label: `${ym.slice(0, 4)}H${second ? 2 : 1}`};
}
// 同じ数字の並びを毎回作る疑似乱数（mulberry32）
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 取引先・権利者・作品 ----------
const PARTNERS = [
  // 製作委員会の参加者（自社を含む）。劇場の窓口は架空シネマ配給、ビデオグラムは架空ビデオ、放送は架空テレビ企画
  {key: 'SELF', code: 'DEMO-SELF', name: '架空データ映像（自社・架空）', kind: 'other'},
  {key: 'HAI', code: 'DEMO-INV-HAI', name: '架空シネマ配給（配給・出資・架空）', kind: 'cinema'},
  {key: 'VID', code: 'DEMO-INV-VID', name: '架空ビデオ（出資・架空）', kind: 'vendor'},
  {key: 'TVI', code: 'DEMO-INV-TV', name: '架空テレビ企画（出資・架空）', kind: 'other'},
  {key: 'PUB', code: 'DEMO-INV-PUB', name: '架空書房（出資・架空）', kind: 'other'},
  {key: 'ADV', code: 'DEMO-INV-AD', name: '架空広告社（出資・架空）', kind: 'agency'},
  // 売上の報告元
  {key: 'RNT', code: 'DEMO-RNT-A', name: '架空レンタルチェーン（架空）', kind: 'retailer'},
  {key: 'SEL', code: 'DEMO-SEL-A', name: '架空パッケージ販売（架空）', kind: 'retailer'},
  {key: 'PFA', code: 'DEMO-PF-A', name: '架空配信A・定額制（架空）', kind: 'platform'},
  {key: 'PFB', code: 'DEMO-PF-B', name: '架空配信B・都度課金（架空）', kind: 'platform'},
  {key: 'PFC', code: 'DEMO-PF-C', name: '架空配信C・広告型（架空）', kind: 'platform'},
  {key: 'TVA', code: 'DEMO-TV-A', name: '架空地上波テレビ（架空）', kind: 'other'},
  {key: 'TVB', code: 'DEMO-TV-B', name: '架空BS放送（架空）', kind: 'other'},
  {key: 'OSA', code: 'DEMO-OS-A', name: '架空海外セールス（架空）', kind: 'agency'},
];

// 権利者20者（監督・脚本・音楽・原作 各5）。cycle はその権利者の契約の既定のサイクル
const HOLDERS = [
  {key: 'D1', name: '朝霧 蒼（架空・監督）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'D2', name: '久遠 灯（架空・監督）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'D3', name: '白峰 睦（架空・監督）', cycle: {kind: 'quarterly', anchor: 3}},
  {key: 'D4', name: '汐見 遥人（架空・監督）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'D5', name: '宵町 律（架空・監督）', cycle: {kind: 'semiannual', anchor: 6, payment: 3}},
  {key: 'S1', name: '綴木 栞（架空・脚本）', cycle: {kind: 'semiannual', anchor: 6}, minPaymentYen: 300000},
  {key: 'S2', name: '雨宮 硯（架空・脚本）', cycle: {kind: 'annual', anchor: 6, report: 2, payment: 3}},
  {key: 'S3', name: '橘 文乃（架空・脚本）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'S4', name: '仮名垣 詠（架空・脚本）', cycle: {kind: 'quarterly', anchor: 3, payment: 3}},
  {key: 'S5', name: '行間 絢（架空・脚本）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'M1', name: '音楽出版 楓舎（架空）', cycle: {kind: 'monthly'}},
  {key: 'M2', name: '音楽出版 潮騒レコーズ（架空）', cycle: {kind: 'quarterly', anchor: 3}},
  {key: 'M3', name: '鳴海 奏（架空・作曲）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'M4', name: '音楽出版 夜想館（架空）', cycle: {kind: 'custom', custom: '2024-12,2025-06,2025-09,2026-03,2026-09'}},
  {key: 'M5', name: '音楽出版 風見堂（架空）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'O1', name: '灯野 綴（架空・原作）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'O2', name: '架空文庫（原作）', cycle: {kind: 'quarterly', anchor: 3}},
  {key: 'O3', name: '架空コミックス（原作）', cycle: {kind: 'semiannual', anchor: 6}},
  {key: 'O4', name: '霧島 頁（架空・原作）', cycle: {kind: 'annual', anchor: 12}},
  {key: 'O5', name: '架空出版 原作部（原作）', cycle: {kind: 'semiannual', anchor: 6, payment: 3}},
];

// 作品20本。theatrical は劇場の配給収入の総額（0なら劇場公開なし）。committee は製作委員会の作品
const PROJECTS = [
  {code: 'DEMO-P1', title: '架空ラインナップ2024（架空）', budget: 420000000},
  {code: 'DEMO-P2', title: '架空ラインナップ2025前期（架空）', budget: 310000000},
  {code: 'DEMO-P3', title: '架空ラインナップ2025後期（架空）', budget: 260000000},
  {code: 'DEMO-P4', title: '架空ラインナップ2026（架空）', budget: 90000000},
];
const WORKS = [
  {n: 1, title: '夜明けの貨物線（架空）', project: 0, release: '2024-07', theatrical: 96000000, committee: true},
  {n: 2, title: '七月の標本室（架空）', project: 0, release: '2024-08', theatrical: 18500000},
  {n: 3, title: '海霧のアーカイブ（架空）', project: 0, release: '2024-09', theatrical: 42000000, committee: true},
  {n: 4, title: '砂時計の町（架空）', project: 0, release: '2024-10', theatrical: 64000000, committee: true},
  {n: 5, title: 'ひとりぼっちの天文台（架空）', project: 0, release: '2024-11', theatrical: 7800000},
  {n: 6, title: '紙飛行機の行方（架空）', project: 0, release: '2024-12', theatrical: 23000000},
  {n: 7, title: '雨上がりの信号機（架空）', project: 1, release: '2025-01', theatrical: 31000000, committee: true},
  {n: 8, title: '灯台守の午後（架空）', project: 1, release: '2025-02', theatrical: 5400000},
  {n: 9, title: '銀色の自転車（架空）', project: 1, release: '2025-03', theatrical: 12600000},
  {n: 10, title: '風鈴と転校生（架空）', project: 1, release: '2025-04', theatrical: 27000000, committee: true},
  {n: 11, title: '真夜中の給水塔（架空）', project: 1, release: '2025-05', theatrical: 3900000},
  {n: 12, title: '白い坂道の記憶（架空）', project: 1, release: '2025-06', theatrical: 38000000, committee: true},
  {n: 13, title: '水曜日の漂流者（架空）', project: 2, release: '2025-07', theatrical: 9700000},
  {n: 14, title: '凍てつく路面電車（架空）', project: 2, release: '2025-08', theatrical: 15200000},
  {n: 15, title: '花のない温室（架空）', project: 2, release: '2025-09', theatrical: 6100000, committee: true, flop: true},
  {n: 16, title: '遠い汽笛の町（架空）', project: 2, release: '2025-10', theatrical: 21000000},
  {n: 17, title: '月曜日の図書係（架空）', project: 2, release: '2025-11', theatrical: 2800000},
  {n: 18, title: 'さよならの滑走路（架空）', project: 2, release: '2025-12', theatrical: 33000000, committee: true},
  {n: 19, title: '薄明のパン屋（架空）', project: 3, release: '2026-01', theatrical: 11000000},
  {n: 20, title: '北緯四十三度の約束（架空）', project: 3, release: '2026-02', theatrical: 8400000},
].map((work) => ({...work, code: `DEMO-W${pad(work.n)}`}));

// 製作委員会（8本）。members は参加者と持分（bp）。windows は窓口ごとの受取先と料率。other（海外）の窓口が無い作品は海外の売上が保留になる
const COMMITTEES = {
  'DEMO-W01': {cost: 120000000, manager: 'SELF', members: [['SELF', 5100, '幹事・出資'], ['HAI', 2000, '出資・劇場窓口'], ['VID', 1500, '出資・ビデオグラム窓口'], ['ADV', 1400, '出資・宣伝']],
    windows: {theatrical: ['HAI', 0, 2500], package: ['VID', 0, 2000], digital: ['SELF', 2000, 1500], broadcast: ['SELF', 0, 1500], other: ['SELF', 0, 2500]}, managerFeeBps: 500,
    feeShares: {digital: [['SELF', 7000], ['ADV', 3000]]}},
  'DEMO-W03': {cost: 80000000, manager: 'SELF', members: [['SELF', 2500, '幹事・出資'], ['HAI', 2500, '出資・劇場窓口'], ['VID', 2500, '出資・ビデオグラム窓口'], ['TVI', 2500, '出資・放送窓口']],
    windows: {theatrical: ['HAI', 0, 2500], package: ['VID', 0, 2000], digital: ['SELF', 0, 1500], broadcast: ['TVI', 0, 1500], other: ['SELF', 0, 2500]}, managerFeeBps: 300,
    feeShares: {package: [['VID', 6000], ['SELF', 4000]]}},
  'DEMO-W04': {cost: 150000000, manager: 'SELF', members: [['SELF', 4000, '幹事・出資'], ['HAI', 3000, '出資・劇場窓口'], ['TVI', 2000, '出資・放送窓口'], ['PUB', 1000, '出資・原作']],
    windows: {theatrical: ['HAI', 0, 2500], package: ['SELF', 0, 2000], digital: ['SELF', 2000, 1500], broadcast: ['TVI', 0, 1500], other: ['SELF', 0, 2500]}, managerFeeBps: 400, managerBasis: 'platform_net'},
  'DEMO-W07': {cost: 70000000, manager: 'SELF', members: [['SELF', 6000, '幹事・出資'], ['VID', 2500, '出資・ビデオグラム窓口'], ['ADV', 1500, '出資・宣伝']],
    windows: {theatrical: ['SELF', 0, 2500], package: ['VID', 0, 2000], digital: ['SELF', 0, 1500], broadcast: ['SELF', 0, 1500], other: ['SELF', 0, 2500]}, managerFeeBps: 500},
  'DEMO-W10': {cost: 60000000, manager: 'SELF', members: [['SELF', 3400, '幹事・出資'], ['HAI', 3300, '出資・劇場窓口'], ['VID', 3300, '出資・ビデオグラム窓口']],
    windows: {theatrical: ['HAI', 0, 2500], package: ['VID', 0, 2000], digital: ['SELF', 0, 1500], broadcast: ['SELF', 0, 1500], other: ['SELF', 0, 2500]}, managerFeeBps: 400, managerFirst: true},
  'DEMO-W12': {cost: 90000000, manager: 'SELF', members: [['SELF', 5000, '幹事・出資'], ['HAI', 2500, '出資・劇場窓口'], ['TVI', 2500, '出資・放送窓口']],
    windows: {theatrical: ['HAI', 0, 2500], package: ['SELF', 0, 2000], digital: ['SELF', 0, 1500], broadcast: ['TVI', 0, 1500]}, managerFeeBps: 300},
  'DEMO-W15': {cost: 45000000, manager: 'SELF', members: [['SELF', 3000, '幹事・出資'], ['VID', 3000, '出資・ビデオグラム窓口'], ['ADV', 2000, '出資・宣伝'], ['PUB', 2000, '出資・原作']],
    windows: {theatrical: ['SELF', 0, 2500], package: ['VID', 0, 2000], digital: ['SELF', 0, 1500], broadcast: ['SELF', 0, 1500], other: ['SELF', 0, 2500]}, managerFeeBps: 500},
  'DEMO-W18': {cost: 75000000, manager: 'SELF', members: [['SELF', 4500, '幹事・出資'], ['HAI', 2000, '出資・劇場窓口'], ['VID', 2000, '出資・ビデオグラム窓口'], ['TVI', 1500, '出資・放送窓口']],
    windows: {theatrical: ['HAI', 0, 2500], package: ['VID', 0, 2000], digital: ['SELF', 0, 1500], broadcast: ['TVI', 0, 1500], other: ['SELF', 0, 2500]}, managerFeeBps: 400},
};
const WINDOW_LABELS = {theatrical: '劇場（配給）', package: 'ビデオグラム', digital: '配信', broadcast: '放送', other: '海外・その他'};

// 商品（作品×流通）。BOX は2作品に半分ずつ配賦するセル商品
const PRODUCT_KINDS = [
  {suffix: 'THR', channel: 'theatrical', label: '劇場公開'},
  {suffix: 'RNT', channel: 'package', label: 'DVD（レンタル）'},
  {suffix: 'SEL', channel: 'package', label: 'DVD・BD（セル）'},
  {suffix: 'DIG', channel: 'digital', label: '配信'},
  {suffix: 'TV', channel: 'broadcast', label: '放送権'},
  {suffix: 'OS', channel: 'other', label: '海外配給権'},
];
const BOX = {sku: 'DEMO-BOX-W01W02', name: '「夜明けの貨物線」「七月の標本室」ツインパック（架空）', allocations: [['DEMO-W01', 5000], ['DEMO-W02', 5000]]};

// ---------- 流通の分類（流通マスタの流通ID・精算方式） ----------
// 報告の計画（buildReports）は、報告の流通を旧区分（theatrical・tvod など）で書く。登録するときに流通マスタの流通IDと精算方式へ置き換える。
// 2026-09-26 代表の指示で、架空データを流通マスタの ID で分類し直した。対応の理由は
// docs/platform/team-development/demo-entry-and-sales-sheet-findability.md §3「流通IDの分類し直し」。
// 2026-09-25 に本番へ入れた架空データ（旧区分のまま）は、scripts/seed-sales-distribution.mjs が同じ対応で付け替える。
export const DEMO_DISTRIBUTION = Object.freeze({
  theatrical: Object.freeze({code: 'H001', settlementMethod: 'royalty'}), // 配給・RS・劇場_RS（配給会社の月次報告の配給収入）
  package_rental: Object.freeze({code: 'R004', settlementMethod: 'royalty'}), // レンタル_RSS・RS（貸出の月の実績で分ける。延滞・回転率の報告）
  package_sell: Object.freeze({code: 'S001', settlementMethod: 'other'}), // セル・委託（半期の報告で返品を差し引く）
  package_sell_return: Object.freeze({code: 'S002', settlementMethod: 'other'}), // セル・委託返品（セルの報告の返品の行）
  tvod: Object.freeze({code: 'D004', settlementMethod: 'royalty'}), // 配信・RS・TVOD（架空配信B・都度課金）
  svod: Object.freeze({code: 'D005', settlementMethod: 'royalty'}), // 配信・RS・SVOD（架空配信A・定額制）
  avod: Object.freeze({code: 'D006', settlementMethod: 'royalty'}), // 配信・RS・AVOD（架空配信C・広告型）
  broadcast_bs: Object.freeze({code: 'B001', settlementMethod: 'FLAT'}), // 放送・FLAT（BS の放送許諾料）
  broadcast_free: Object.freeze({code: 'B001', settlementMethod: 'FLAT'}), // 放送・FLAT（地上波の放送許諾料）
  other: Object.freeze({code: 'A001', settlementMethod: 'FLAT'}), // 海外・FLAT（海外配給権の許諾料）
  other_mg: Object.freeze({code: 'A003', settlementMethod: 'MG'}), // 海外・MG・クロスリクープ_RS（受取の最低保証の契約がある作品の海外配給権）
});
// 受取の最低保証（海外セールス）の契約がある作品。海外の売上を A003 にする（下の MG の節の DEMO-MGI-W04-OS）
export const DEMO_OVERSEAS_MG_WORKS = Object.freeze(['DEMO-W04']);
export const DEMO_CLASSIFY_REASON = Object.freeze({
  legacy: '架空データ: 報告書の区分と地域', // 2026-09-25 までの seed が旧区分で入れたときの理由（付け替えの対象の目印）
  master: '架空データ: 報告書の区分と地域（流通マスタの流通ID）',
});
// 旧区分（buildReports の classify.code）・明細の額・作品 → {code, settlementMethod}。対応が無ければ null
export function demoDistributionOf(legacyCode, {amount = 0, workCode = null} = {}) {
  if (legacyCode === 'package_sell' && Number(amount) < 0) return DEMO_DISTRIBUTION.package_sell_return;
  if (legacyCode === 'other' && DEMO_OVERSEAS_MG_WORKS.includes(workCode)) return DEMO_DISTRIBUTION.other_mg;
  if (legacyCode === 'package_sell_return' || legacyCode === 'other_mg') return null;
  return Object.hasOwn(DEMO_DISTRIBUTION, legacyCode) ? DEMO_DISTRIBUTION[legacyCode] : null;
}

// ---------- 売上報告の計画 ----------
// 報告は計上月ごとに1通（取込の決まり）。窓口ごとに周期を変える:
//   劇場=月次（販売月）、レンタル=四半期の報告を月ごとに分けて（販売月）、セル=半年ごと（受領月）、
//   配信A=月次（販売月）、配信B=月次（翌月受領）、配信C=四半期（受領月）、放送=許諾ごと（利用開始月）、海外=契約ごと（契約開始月）。
function buildReports(work, rnd) {
  const T = work.theatrical;
  const size = Math.max(T, 6000000);
  const R = work.release;
  const end = SALES_DEMO.salesTo;
  const yen = (value) => Math.max(1, Math.round(value * (0.88 + rnd() * 0.24)));
  const reports = [];
  const line = (product, amount, description, classify, extra = {}) => ({product, amount, description, classify, ...extra});
  const domestic = (code, service) => ({code, territory: '日本', service});
  // 劇場（公開月から4か月）
  if (T > 0) {
    [0.46, 0.29, 0.16, 0.09].forEach((weight, k) => {
      const m = addMonths(R, k);
      if (m > end) return;
      reports.push({kind: 'theatrical', partner: 'HAI', key: `${work.code}-THR-${m}`, periodFrom: dayOf(m, 1), periodTo: dayOf(m, 'eom'),
        recognition: {basis: 1, month: m, reason: '配給会社の月次報告（興行の月で計上）'}, accountingMonth: m,
        lines: [line('THR', yen(T * weight), `劇場配給収入 ${m}`, domestic('theatrical', '劇場公開'))]});
    });
  }
  // レンタル（公開4か月後から。四半期の報告を月ごとの報告に分ける）
  for (let m = addMonths(R, 4), k = 0; m <= end; m = addMonths(m, 1), k += 1) {
    const q = quarterOf(m);
    const amount = Math.max(2000, yen(size * 0.06 * 0.78 ** k));
    reports.push({kind: 'package', partner: 'RNT', key: `${work.code}-RNT-${q.label}-${m.slice(5)}`, periodFrom: dayOf(q.start, 1), periodTo: dayOf(q.end, 'eom'),
      recognition: {basis: 1, month: m, reason: 'レンタルの四半期報告（貸出の月で計上）'}, accountingMonth: m,
      lines: [line('RNT', amount, `レンタル収入 ${m}`, domestic('package_rental', 'レンタル'), {salesFrom: dayOf(m, 1), salesTo: dayOf(m, 'eom')})]});
  }
  // セル（公開5か月後から半年ごと。受領月で計上。3通目は返品が多い）
  let sellIndex = 0;
  for (let h = halfOf(addMonths(R, 5)); ; h = halfOf(addMonths(h.end, 1)), sellIndex += 1) {
    const received = addMonths(h.end, 1);
    if (received > end) break;
    const from = sellIndex === 0 ? addMonths(R, 5) : h.start;
    const factor = [0.08, 0.025, 0.012, 0.006][sellIndex] ?? 0.004;
    const classify = work.n === 10 ? null : domestic('package_sell', 'セル'); // 風鈴と転校生はレンタル／セル未確認のまま残す
    const lines = [line('SEL', yen(size * factor), `セル販売 ${h.label}`, classify, {salesFrom: dayOf(from, 1), salesTo: dayOf(h.end, 'eom')})];
    // 返品が売上を上回り、計上月がマイナスになる報告（3通目と、2本の作品の2通目）
    const returns = sellIndex === 2 ? 0.016 : sellIndex === 1 && [5, 6].includes(work.n) ? 0.032 : 0;
    if (returns) lines.push(line('SEL', -Math.round(size * returns), `セル返品 ${h.label}`, classify, {salesFrom: dayOf(from, 1), salesTo: dayOf(h.end, 'eom')}));
    if (work.n === 1 && sellIndex === 1) lines.push(line('BOX', 1234567, `ツインパック販売 ${h.label}`, domestic('package_sell', 'セル'), {salesFrom: dayOf(from, 1), salesTo: dayOf(h.end, 'eom')}));
    reports.push({kind: 'package', partner: 'SEL', key: `${work.code}-SEL-${h.label}`, periodFrom: dayOf(from, 1), periodTo: dayOf(h.end, 'eom'),
      recognition: {basis: 2, receivedOn: dayOf(received, 20), reason: 'セル販売の半期報告（報告を受け取った月で計上）'}, accountingMonth: received, lines});
  }
  // 配信B（都度課金。公開4か月後から月次、翌月15日に受領して計上）
  for (let m = addMonths(R, 4), k = 0; addMonths(m, 1) <= end; m = addMonths(m, 1), k += 1) {
    const lines = [line('DIG', Math.max(3000, yen(size * 0.04 * 0.85 ** k)), `都度課金の配信収入 ${m}`, domestic('tvod', '架空配信B'))];
    if (work.n === 4 && k === 8) lines.push(line('DIG', -12345, `返金（チャージバック） ${m}`, domestic('tvod', '架空配信B')));
    reports.push({kind: 'digital', partner: 'PFB', key: `${work.code}-PFB-${m}`, periodFrom: dayOf(m, 1), periodTo: dayOf(m, 'eom'),
      recognition: {basis: 2, receivedOn: dayOf(addMonths(m, 1), 15), reason: '配信事業者の月次報告（受け取った月で計上）'}, accountingMonth: addMonths(m, 1), lines});
  }
  // 配信A（定額制。公開7か月後から月次、販売月で計上。長く続く）
  for (let m = addMonths(R, 7), k = 0; m <= end; m = addMonths(m, 1), k += 1) {
    reports.push({kind: 'digital', partner: 'PFA', key: `${work.code}-PFA-${m}`, periodFrom: dayOf(m, 1), periodTo: dayOf(m, 'eom'),
      recognition: {basis: 1, month: m, reason: '定額制配信の月次報告（視聴の月で計上）'}, accountingMonth: m,
      lines: [line('DIG', Math.max(2000, yen(size * 0.012 * 0.97 ** k)), `定額制の配信収入 ${m}`, domestic('svod', '架空配信A'))]});
  }
  // 配信C（広告型。公開10か月後から四半期、受領月で計上）
  for (let q = quarterOf(addMonths(R, 10)); ; q = quarterOf(addMonths(q.end, 1))) {
    const received = addMonths(q.end, 1);
    if (received > end) break;
    reports.push({kind: 'digital', partner: 'PFC', key: `${work.code}-PFC-${q.label}`, periodFrom: dayOf(q.start, 1), periodTo: dayOf(q.end, 'eom'),
      recognition: {basis: 2, receivedOn: dayOf(received, 25), reason: '広告型配信の四半期報告（受け取った月で計上）'}, accountingMonth: received,
      lines: [line('DIG', yen(size * 0.006), `広告型の配信収入 ${q.label}`, domestic('avod', '架空配信C'))]});
  }
  // 放送（劇場の大きい作品だけ。BSは公開10か月後、地上波は16か月後の利用開始月で計上）
  if (T >= 10000000) {
    for (const [offset, partner, factor, code, service] of [[10, 'TVB', 0.05, 'broadcast_bs', '架空BS放送'], [16, 'TVA', 0.07, 'broadcast_free', '架空地上波テレビ']]) {
      const m = addMonths(R, offset);
      if (m > end) continue;
      reports.push({kind: 'broadcast', partner, key: `${work.code}-${partner}-${m}`, periodFrom: dayOf(m, 1), periodTo: dayOf(addMonths(m, 23), 'eom'),
        recognition: {basis: 4, licenseStartOn: dayOf(m, 1), reason: '放送の許諾料（利用開始月で計上）'}, accountingMonth: m,
        lines: [line('TV', yen(size * factor), `放送許諾料（${service}）`, {code, territory: '日本', service})]});
    }
  }
  // 海外（劇場の大きい作品だけ。台湾は公開3か月後、北米は9か月後の契約開始月で計上。免税）
  if (T >= 15000000) {
    for (const [offset, territory, factor] of [[3, '台湾', 0.025], [9, '北米', 0.04]]) {
      const m = addMonths(R, offset);
      if (m > end) continue;
      reports.push({kind: 'other', partner: 'OSA', key: `${work.code}-OS-${m}`, periodFrom: dayOf(m, 1), periodTo: dayOf(m, 'eom'),
        recognition: {basis: 3, contractStartOn: dayOf(m, 1), reason: '海外の配給権の許諾（契約開始月で計上）'}, accountingMonth: m, taxFree: true,
        lines: [line('OS', yen(size * factor), `海外配給権（${territory}）`, {code: 'other', territory, service: '海外配給'})]});
    }
  }
  return reports.filter((report) => report.accountingMonth <= end);
}

// 1回目の一括作成の後に届く報告（締めた後に届いた売上として、次の報告書へ「報告後の修正」で入る）
const LATE_REPORTS = [
  {work: 'DEMO-W06', kind: 'digital', partner: 'PFA', key: 'DEMO-W06-PFA-2025-11-ADD', periodFrom: '2025-11-01', periodTo: '2025-11-30',
    recognition: {basis: 1, month: '2025-11', reason: '定額制配信の追加報告（集計漏れの分。視聴の月で計上）'}, accountingMonth: '2025-11',
    lines: [{product: 'DIG', amount: 234567, description: '定額制の配信収入 2025-11（追加報告）', classify: {code: 'svod', territory: '日本', service: '架空配信A'}}]},
];

// ---------- 経費 ----------
function buildExpenses(work, rnd) {
  const T = work.theatrical;
  const R = work.release;
  const yen = (value) => Math.round(value * (0.9 + rnd() * 0.2));
  const rows = [];
  const add = (month, category, description, amount) => { if (month <= SALES_DEMO.salesTo && amount > 0) rows.push({month, category, description, amount}); };
  const pa = work.flop ? [1.2, 0.8] : [0.35, 0.25];
  if (T > 0) {
    add(addMonths(R, -1), 'P&A', '劇場公開の宣伝費（予告編・広告出稿）', yen(T * pa[0]));
    add(R, 'P&A', '劇場公開の宣伝費（公開週の広告）', yen(T * pa[1]));
  }
  add(addMonths(R, 4), '宣伝費', 'パッケージ・配信の宣伝費', yen(Math.max(T, 6000000) * 0.02 + 300000));
  add(addMonths(R, 4), 'パッケージ製作費', 'DVD・BDのオーサリング・プレス', yen(1200000 + Math.max(T, 6000000) * 0.01));
  add(addMonths(R, 4), '配信マスター制作費', '配信用マスター・字幕データ', yen(350000));
  if (T >= 15000000) add(addMonths(R, 3), '海外素材費', '海外向けの字幕・素材', yen(280000));
  add(addMonths(R, 12), '事務費', '権利処理・契約管理の事務費', yen(120000));
  return rows;
}

// ---------- ロイヤリティ契約 ----------
const NON_THEATRICAL = ['rental', 'sell', 'digital', 'broadcast', 'overseas', 'other'];
const CHANNEL_COSTS = ['パッケージ製作費', '配信マスター制作費', '宣伝費'];
const holderOf = (category, n) => {
  const i = n - 1;
  if (category === 'director') return `D${(i % 5) + 1}`;
  if (category === 'screenplay') return `S${((i + 2) % 5) + 1}`;
  if (category === 'music') return `M${((i + 1) % 5) + 1}`;
  return `O${((i + 3) % 5) + 1}`;
};
const CATEGORY_TEXT = {director: ['DIR', '監督料', '監督契約書'], screenplay: ['SCR', '脚本料', '脚本契約書'], music: ['MUS', '音楽著作権料', '音楽利用許諾書'], original: ['ORG', '原作料', '原作利用許諾契約書']};

function phaseOf(startsMonth, cycle, overrides = {}) {
  const c = {...cycle, ...overrides};
  return {startsMonth, endsMonth: c.endsMonth ?? null, cycleKind: c.kind, anchorMonth: c.anchor ?? null, customCloseMonths: c.custom ?? null,
    firstCloseImmediate: Boolean(c.first), reportOffsetMonths: c.report ?? 1, reportDay: 'eom', paymentOffsetMonths: c.payment ?? 2, paymentDay: 'eom', note: c.note ?? null};
}

function buildAgreements() {
  const holders = new Map(HOLDERS.map((holder) => [holder.key, holder]));
  const agreements = [];
  for (const work of WORKS) {
    for (const category of ['director', 'screenplay', 'music', 'original']) {
      const holderKey = holderOf(category, work.n);
      const holder = holders.get(holderKey);
      const [suffix, label, documentName] = CATEGORY_TEXT[category];
      const code = `DEMO-RY-${work.code.slice(5)}-${suffix}`;
      let term;
      if (category === 'director' || category === 'screenplay') {
        const rate = (category === 'director' ? 250 : 180) + (work.n % 3) * 25;
        term = work.committee
          ? {calcMethod: 'rate', baseKind: 'committee_income_after_expenses', rateBps: rate, channels: NON_THEATRICAL, expenseCategories: CHANNEL_COSTS, clauseReference: `第8条（${label}・本委員会収入から経費を引いた額）`}
          : {calcMethod: 'rate', baseKind: 'after_window_fee_and_expenses', windowFeeBps: 2500, rateBps: rate + 50, channels: NON_THEATRICAL, expenseCategories: CHANNEL_COSTS.slice(0, 2), clauseReference: `第8条（${label}・窓口手数料と経費を引いた額）`};
        if (code === 'DEMO-RY-W04-DIR') term = {...term, expenseCategories: [], clauseReference: '第8条（監督料・本委員会収入から経費すべてを引いた額）'};
        if (code === 'DEMO-RY-W10-SCR') term = {calcMethod: 'rate', baseKind: 'committee_income', rateBps: 150, channels: NON_THEATRICAL, clauseReference: '第7条（脚本料・本委員会収入）'};
      } else if (category === 'music') {
        term = ['M2', 'M5'].includes(holderKey)
          ? {calcMethod: 'manual', clauseReference: '音楽利用許諾書 第5条（分配明細の額）'}
          : {calcMethod: 'rate', baseKind: 'gross_sales', rateBps: {M1: 60, M3: 80, M4: 50}[holderKey], clauseReference: '音楽利用許諾書 第4条（売上の料率）'};
      } else {
        term = {O1: {calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 200},
          O2: {calcMethod: 'rate', baseKind: 'after_window_fee', windowFeeBps: 3000, rateBps: 400},
          O3: {calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 150},
          O4: {calcMethod: 'rate', baseKind: 'after_window_fee', windowFeeBps: 2500, rateBps: 300},
          O5: {calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 250, channels: ['rental', 'sell', 'digital']}}[holderKey];
        term = {...term, clauseReference: '原作利用許諾契約書 第6条（原作使用料）'};
        if (code === 'DEMO-RY-W04-ORG') term = {calcMethod: 'rate', baseKind: 'gross_sales', rateBps: 200, clauseReference: '原作利用許諾契約書 第6条（原作使用料）'};
        if (code === 'DEMO-RY-W10-ORG') term = {...term, channels: ['sell', 'digital'], clauseReference: '原作利用許諾契約書 第6条（セル・配信の売上だけが対象）'};
        if (code === 'DEMO-RY-W03-ORG') term = {...term, advanceYen: 1500000, clauseReference: '原作利用許諾契約書 第6条・第7条（前払金1,500,000円を充当）'};
      }
      if (holder.minPaymentYen) term = {...term, minPaymentYen: holder.minPaymentYen};
      term = {effectiveFrom: work.release, channels: [], expenseCategories: [], ...term};
      let phase = phaseOf(work.release, holder.cycle);
      if (code === 'DEMO-RY-W12-DIR') phase = phaseOf(work.release, {kind: 'none', note: '監督料は製作費に含む（架空の契約）'});
      if (code === 'DEMO-RY-W13-SCR') phase = phaseOf(work.release, {kind: 'manual', note: '報告時期は別途協議（架空の契約）'});
      if (code === 'DEMO-RY-W13-DIR') phase = phaseOf(work.release, holder.cycle, {first: true, note: '公開月は即締めて報告'});
      const agreement = {code, work: work.code, holder: holderKey, category, title: `「${work.title.replace('（架空）', '')}」${label}（架空）`,
        documentReference: `架空の${documentName} 第1版（${work.code}）`, term, schedule: {phases: [phase]}, extraTerms: [], extraSchedules: []};
      if (code === 'DEMO-RY-W01-DIR') agreement.extraTerms.push({...term, effectiveFrom: '2025-10', rateBps: 300, reason: '覚書（2025年9月・架空）で10月計上分から料率を改定'});
      if (code === 'DEMO-RY-W04-ORG') agreement.extraTerms.push({...term, effectiveFrom: '2025-07', baseKind: 'after_window_fee', windowFeeBps: 3000, rateBps: 350, reason: '再契約（2025年6月・架空）で窓口手数料を引いた額の料率に変更'});
      if (code === 'DEMO-RY-W09-DIR') agreement.extraSchedules.push({reason: '覚書（2025年6月・架空）で2025年7月計上分から四半期ごとの報告に変更',
        phases: [phaseOf(work.release, holder.cycle, {endsMonth: '2025-06'}), phaseOf('2025-07', {kind: 'quarterly', anchor: 3})]});
      agreements.push(agreement);
    }
  }
  return agreements;
}

// 音楽の実額（分配明細）。四半期ごとの額
function buildManualAccruals(agreements, rnd) {
  const rows = [];
  for (const agreement of agreements.filter((a) => a.term.calcMethod === 'manual')) {
    const work = WORKS.find((w) => w.code === agreement.work);
    let m = quarterOf(addMonths(work.release, 2)).end;
    for (let k = 0; m <= SALES_DEMO.salesTo; m = addMonths(m, 3), k += 1) {
      const amount = Math.round((Math.max(work.theatrical, 6000000) * 0.003 + 20000) * 0.82 ** k * (0.85 + rnd() * 0.3));
      rows.push({agreement: agreement.code, month: m, amount, sourceReference: `架空の分配明細 ${m} ${work.code}`, reason: '音楽出版社の分配明細の額'});
    }
  }
  return rows;
}

// ---------- 実行 ----------
// 制作の架空データ（scripts/seed-kouban-demo.mjs）も同じ組織を使う
export async function createOrganization(db) {
  const orgId = Number((await db.get('SELECT COALESCE(MAX(id),0)+1 AS id FROM organizations')).id);
  await db.batch([
    {sql: 'INSERT INTO organizations(id,code,name) VALUES(?,?,?)', params: [orgId, SALES_DEMO.orgCode, SALES_DEMO.orgName]},
    {sql: 'INSERT INTO schema_meta(org_id,version) VALUES(?,1) ON CONFLICT(org_id) DO NOTHING', params: [orgId]},
    {sql: 'INSERT INTO users(email,display_name) VALUES(?,?) ON CONFLICT(email) DO NOTHING', params: [SALES_DEMO.adminEmail, SALES_DEMO.adminName]},
    {sql: "INSERT INTO memberships(org_id,user_id,role) SELECT ?,id,'admin' FROM users WHERE email=? ON CONFLICT(org_id,user_id) DO NOTHING", params: [orgId, SALES_DEMO.adminEmail]},
    {sql: "INSERT INTO memberships(org_id,user_id,role) SELECT ?,id,'admin' FROM users WHERE email=? ON CONFLICT(org_id,user_id) DO NOTHING", params: [orgId, SALES_DEMO.fixtureAdminEmail]},
  ]);
  return orgId;
}

// legacyDistribution: true は試験用。2026-09-25 に本番へ入れたときと同じく、流通の分類を旧区分（精算方式は未確認）で入れる
export async function seedSalesDemo(db, {asOf = SALES_DEMO.asOf, log = () => {}, legacyDistribution = false} = {}) {
  const found = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
  // 売上の作品（DEMO-W01）で投入済みかを見る（制作の架空データだけが先に入っていても売上は入れる）
  if (found && await db.get("SELECT 1 FROM works WHERE org_id=? AND code='DEMO-W01'", [found.id])) return {skipped: true, orgId: found.id};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf < '2026-07-01') throw new Error('基準日（--as-of）は 2026-07-01 以後の日付にしてください（販売期間は2026年6月まで）');
  const orgId = found ? found.id : await createOrganization(db);

  const app = createApp({db, mode: 'local'});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  if (login.status !== 200) throw new Error(`架空の管理者でログインできません（${login.status}）`);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, payload) => {
    const response = await app.request(`/api${path}`, {method, headers: {cookie, 'content-type': 'application/json'}, body: payload === undefined ? undefined : JSON.stringify(payload)});
    const data = await response.json();
    if (response.status >= 300 || data.ok === false) throw new Error(`${method} ${path}: ${response.status} ${data.error || JSON.stringify(data).slice(0, 600)}`);
    return data;
  };
  const post = expenseDemoWriter(db,orgId,(path,payload)=>call('POST',path,payload));
  const get = (path) => call('GET', path);
  if ((await get('/session')).user.orgId !== orgId) throw new Error('架空の管理者が DEMO-SALES で入れていません');

  // 取引先・権利者
  const partnerId = new Map();
  for (const p of PARTNERS) partnerId.set(p.key, (await post('/partners', {code: p.code, name: p.name, kind: p.kind, region: p.key === 'OSA' ? '海外' : '全国'})).id);
  for (const h of HOLDERS) partnerId.set(h.key, (await post('/partners', {code: `DEMO-RH-${h.key}`, name: h.name, kind: 'other', region: '全国'})).id);
  log(`取引先 ${partnerId.size}件`);

  // 案件・作品・商品・配賦
  const projectIds = [];
  for (const p of PROJECTS) projectIds.push((await post('/projects', {code: p.code, title: p.title, status: 'active', budget_yen: p.budget})).id);
  const workId = new Map();
  const workById = new Map();
  for (const w of WORKS) {
    const id = (await post('/works', {project_id: projectIds[w.project], code: w.code, title: w.title, format: 'film', forecast_yen: Math.max(w.theatrical, 6000000) * 2})).id;
    workId.set(w.code, id);
    workById.set(w.code, {...w, id, projectId: projectIds[w.project]});
  }
  const productId = new Map();
  for (const w of WORKS) {
    for (const kind of PRODUCT_KINDS) {
      const sku = `${w.code}-${kind.suffix}`;
      const id = (await post('/products', {sku, name: `${w.title.replace('（架空）', '')} ${kind.label}（架空）`, channel: kind.channel})).id;
      await post('/product-works', {productId: id, allocations: [{workId: workId.get(w.code), allocationBps: 10000}]});
      productId.set(sku, id);
    }
  }
  const boxId = (await post('/products', {sku: BOX.sku, name: BOX.name, channel: 'package'})).id;
  await post('/product-works', {productId: boxId, allocations: BOX.allocations.map(([code, bps]) => ({workId: workId.get(code), allocationBps: bps}))});
  productId.set(BOX.sku, boxId);
  log(`作品 ${workId.size}本・商品 ${productId.size}件`);

  // 経費
  const rnd = random(20260925);
  let expenseCount = 0;
  for (const w of WORKS) {
    const work = workById.get(w.code);
    for (const e of buildExpenses(w, rnd)) {
      const tax = Math.trunc(e.amount / 10);
      await post('/expenses', {project_id: work.projectId, work_id: work.id, incurred_on: dayOf(e.month, 15), accounting_month: e.month, category: e.category,
        description: `${e.description}（架空）`, actual_ex_tax: e.amount, tax_amount: tax, actual_inc_tax: e.amount + tax});
      expenseCount += 1;
    }
  }
  log(`経費 ${expenseCount}件`);

  // 製作委員会（調達ケース → 委員会契約 → 窓口手数料の取り分）
  const committeeContracts = [];
  for (const [code, spec] of Object.entries(COMMITTEES)) {
    const work = workById.get(code);
    const shareTotal = spec.members.reduce((n, [, bps]) => n + bps, 0);
    if (shareTotal !== 10000) throw new Error(`${code} の持分の合計が100%ではありません`);
    const investments = spec.members.map(([key, bps]) => ({partnerId: partnerId.get(key), amountYen: Math.round(spec.cost * bps / 10000)}));
    investments[0].amountYen += spec.cost - investments.reduce((n, row) => n + row.amountYen, 0);
    const intake = await post('/intakes', {workId: work.id, caseCode: `${code}-CMT`, title: `${work.title} 製作委員会`, intakeType: 'committee',
      documents: [{title: `${work.title} 製作委員会契約書`, reference: `架空の委員会契約書 ${code}`, versionLabel: '第1版'}],
      participants: spec.members.map(([key, bps, role], index) => ({partyKind: 'partner', partnerId: partnerId.get(key), role, investmentYen: investments[index].amountYen, explicitShareBps: bps}))});
    const intakeCase = (await get(`/intakes?workId=${work.id}`)).cases.find((row) => row.id === intake.caseId);
    const start = addMonths(work.release, -1);
    const firstClose = Number(start.slice(5)) <= 6 ? `${start.slice(0, 4)}-06` : `${start.slice(0, 4)}-12`;
    const windows = Object.entries(spec.windows).map(([kind, [key, platformRateBps, windowFeeBps]]) => ({
      kind, label: WINDOW_LABELS[kind], windowPartnerId: partnerId.get(key), route: 'via_manager', platformRateBps, windowFeeBps, managerFeeBps: spec.managerFeeBps,
      feeOrder: spec.managerFirst ? 'manager_first' : 'window_first',
      windowFeeBasis: spec.managerFirst ? 'after_manager' : 'platform_net',
      managerFeeBasis: spec.managerFirst ? 'platform_net' : spec.managerBasis || 'after_window',
    }));
    const contract = await post('/committee/contracts', {workId: work.id, intakeCaseId: intake.caseId, documentId: intakeCase.documents[0].id, contractCode: `${code}-C01`,
      title: `${work.title} 製作委員会収支`, managerPartnerId: partnerId.get(spec.manager), windows,
      phases: [{label: '半年ごと（6・12月締め）', startsOn: dayOf(start, 1), endsOn: dayOf(addMonths(start, 59), 'eom'), firstCloseOn: dayOf(firstClose, 'eom'), intervalMonths: 6,
        closeDay: 'eom', reportOffsetMonths: 1, reportDay: 'eom', paymentOffsetMonths: 2, paymentDay: 'eom', referenceType: 'release', referenceDate: dayOf(work.release, 1)}],
      funding: {productionCostYen: spec.cost, investments}, note: '架空の製作委員会の条件（デモ）'});
    committeeContracts.push({code, contractId: contract.contractId, versionId: contract.versionId});
    if (spec.feeShares) {
      const saved = (await get(`/committee/contracts?workId=${work.id}`)).contracts.find((row) => row.id === contract.contractId);
      const version = saved.versions.find((row) => row.id === contract.versionId);
      for (const [kind, shares] of Object.entries(spec.feeShares)) {
        const window = version.windows.find((row) => row.kind === kind);
        await post(`/committee/windows/${window.id}/fee-shares`, {shares: shares.map(([key, bps]) => ({partnerId: partnerId.get(key), shareBps: bps})),
          reason: '委員会契約書 第12条（窓口手数料の分け方・架空）'});
      }
    }
  }
  log(`製作委員会 ${committeeContracts.length}件`);

  // 売上報告（取込 → 流通の区分）
  const headers = ['report_key', 'partner_id', 'product_id', 'period_from', 'period_to', 'recognition_basis_id', 'sales_month', 'report_received_on', 'contract_start_on',
    'license_start_on', 'broadcast_on', 'basis_reason', 'description', 'quantity', 'amount_ex_tax', 'tax_amount', 'amount_inc_tax', 'sales_period_from', 'sales_period_to'];
  let reportCount = 0;
  let lineCount = 0;
  let classified = 0;
  async function importReport(workCode, report) {
    const work = workById.get(workCode);
    const rows = report.lines.map((l) => {
      const sku = l.product === 'BOX' ? BOX.sku : `${workCode}-${l.product}`;
      const tax = report.taxFree ? 0 : Math.trunc(l.amount / 10);
      const r = report.recognition;
      return [report.key, partnerId.get(report.partner), productId.get(sku), report.periodFrom, report.periodTo, r.basis, r.month || '', r.receivedOn || '', r.contractStartOn || '',
        r.licenseStartOn || '', '', r.reason, l.description, '', l.amount, tax, l.amount + tax, l.salesFrom || '', l.salesTo || ''];
    });
    const preview = await post('/imports/preview', {kind: report.kind, workId: work.id, text: toCsv(headers, rows)});
    await post('/imports/commit', {token: preview.token});
    const saved = await db.all(`SELECT s.id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
      WHERE s.org_id=? AND r.work_id=? AND r.report_key=? AND r.status='active' ORDER BY s.source_row, s.id`, [orgId, work.id, report.key]);
    if (saved.length !== report.lines.length) throw new Error(`${report.key}: 明細の件数が合いません`);
    for (const [index, l] of report.lines.entries()) {
      if (!l.classify) continue;
      // legacyDistribution は試験用: 2026-09-25 に本番へ入れた形（旧区分・精算方式は未確認）を再現する
      const target = legacyDistribution ? {code: l.classify.code, settlementMethod: 'unverified'} : demoDistributionOf(l.classify.code, {amount: l.amount, workCode});
      if (!target) throw new Error(`${report.key}: 流通「${l.classify.code}」に対応する流通マスタの流通IDがありません`);
      await post('/report-center/classifications', {saleId: saved[index].id, distributionCode: target.code, baseVersion: 0, territory: l.classify.territory,
        serviceName: l.classify.service, settlementMethod: target.settlementMethod, reason: legacyDistribution ? DEMO_CLASSIFY_REASON.legacy : DEMO_CLASSIFY_REASON.master});
      classified += 1;
    }
    reportCount += 1;
    lineCount += report.lines.length;
  }
  const salesRnd = random(24070626);
  for (const w of WORKS) for (const report of buildReports(w, salesRnd)) await importReport(w.code, report);
  log(`売上報告 ${reportCount}通・明細 ${lineCount}行（区分 ${classified}行）`);

  // 製作委員会の期間報告（保存するスナップショット）: 「夜明けの貨物線」の2024年下期・2025年上期。
  // 期間内の販売期間の報告をすべて控除前で結び、期間内の経費を費目の窓口へ割り当てる（月次収支の数字は変わらない）
  const snapshotWork = workById.get('DEMO-W01');
  const snapshotTerm = committeeContracts.find((row) => row.code === 'DEMO-W01');
  const snapshotWindows = (await get(`/committee/contracts?workId=${snapshotWork.id}`)).contracts.find((row) => row.id === snapshotTerm.contractId)
    .versions.find((row) => row.id === snapshotTerm.versionId).windows;
  const windowFor = {'P&A': 'theatrical', '宣伝費': 'package', 'パッケージ製作費': 'package', '配信マスター制作費': 'digital', '海外素材費': 'other', '事務費': 'theatrical'};
  const snapshotExpenses = await db.all('SELECT id, accounting_month, category FROM expenses WHERE org_id=? AND work_id=? ORDER BY id', [orgId, snapshotWork.id]);
  let snapshots = 0;
  for (const periodIndex of [2, 3]) {
    const sources = await get(`/committee/sources?workId=${snapshotWork.id}&termVersionId=${snapshotTerm.versionId}&periodIndex=${periodIndex}&periodDateBasis=sales_period`);
    const {start, end} = sources.period;
    const preview = await post('/committee/previews', {workId: snapshotWork.id, termVersionId: snapshotTerm.versionId, periodIndex, periodDateBasis: 'sales_period', allowStub: false,
      reportLinks: sources.candidateReports.filter((row) => row.eligible).map((row) => ({reportId: row.id, reportBasis: 'gross'})),
      expenseAllocations: snapshotExpenses.filter((row) => row.accounting_month >= start.slice(0, 7) && row.accounting_month <= end.slice(0, 7))
        .map((row) => ({expenseId: row.id, windowId: snapshotWindows.find((w) => w.kind === windowFor[row.category]).id}))});
    await post('/committee/snapshots', {token: preview.token});
    snapshots += 1;
  }
  log(`製作委員会の期間報告 ${snapshots}件`);

  // ロイヤリティ契約（条件版・サイクル）と実額の計上
  const agreements = buildAgreements();
  const agreementId = new Map();
  for (const a of agreements) {
    const work = workById.get(a.work);
    const saved = await post('/royalty/agreements', {workId: work.id, holderPartnerId: partnerId.get(a.holder), category: a.category, agreementCode: a.code, title: a.title,
      documentReference: a.documentReference, term: a.term, schedule: a.schedule});
    agreementId.set(a.code, saved.agreementId);
    for (const term of a.extraTerms) await post(`/royalty/agreements/${saved.agreementId}/terms`, term);
    for (const schedule of a.extraSchedules) await post(`/royalty/agreements/${saved.agreementId}/schedules`, schedule);
  }
  const manual = buildManualAccruals(agreements, random(5150));
  const manualIds = [];
  for (const row of manual) manualIds.push((await post('/royalty/manual-accruals', {agreementId: agreementId.get(row.agreement), accrualMonth: row.month, amountYen: row.amount,
    sourceReference: row.sourceReference, reason: row.reason})).id);
  // 1件は入力誤りを取り消して入れ直す
  const wrong = manual.findIndex((row) => row.agreement === 'DEMO-RY-W01-MUS');
  await post(`/royalty/manual-accruals/${manualIds[wrong + 1]}/reverse`, {reason: '分配明細の金額を読み違えたため取消（架空）'});
  await post('/royalty/manual-accruals', {agreementId: agreementId.get('DEMO-RY-W01-MUS'), accrualMonth: manual[wrong + 1].month, amountYen: manual[wrong + 1].amount + 4321,
    sourceReference: `${manual[wrong + 1].sourceReference}（訂正）`, reason: '分配明細の訂正版の額'});
  log(`ロイヤリティ契約 ${agreements.length}件・実額の計上 ${manual.length + 2}件`);

  // イレギュラーの台帳（1回目の一括作成の前）
  const irregular = [];
  const addIrregular = async (payload) => irregular.push((await post('/royalty/irregular-entries', payload)).id);
  await addIrregular({holderPartnerId: partnerId.get('D1'), kind: 'adjust_amount', closeMonth: '2025-12', amountYen: -3300, reason: '振込手数料を権利者の負担とする合意（架空）', sourceReference: '架空の合意メール 2025-11-20'});
  const mistaken = (await post('/royalty/irregular-entries', {holderPartnerId: partnerId.get('S3'), kind: 'adjust_amount', closeMonth: '2025-12', amountYen: 10000, reason: '取材協力費の上乗せ（架空）'})).id;
  irregular.push(mistaken);
  irregular.push((await post(`/royalty/irregular-entries/${mistaken}/reverse`, {reason: '別の契約で支払うことになったため取消（架空）'})).id);
  await addIrregular({agreementId: agreementId.get('DEMO-RY-W08-DIR'), kind: 'move_period', accrualMonth: '2025-05', closeMonth: '2025-09', reason: '売上報告の確認が遅れたため、次の四半期の報告書に入れる（架空）'});
  for (const month of ['2025-11', '2025-12', '2026-01']) {
    await addIrregular({agreementId: agreementId.get('DEMO-RY-W13-SCR'), kind: 'move_period', accrualMonth: month, closeMonth: '2026-03', reason: '別途協議の結果、2026年3月締めで報告する（架空）'});
  }
  const holdEntry = (await post('/royalty/irregular-entries', {agreementId: agreementId.get('DEMO-RY-W09-ORG'), kind: 'hold', accrualMonth: '2025-08', reason: '配信事業者の報告の数字を照会中（架空）'})).id;
  irregular.push(holdEntry);
  await addIrregular({holderPartnerId: partnerId.get('D2'), kind: 'note', reason: '権利者と電話で報告書の送り方を確認（PDFをメールで送付・架空）'});

  // 1回目の一括作成（2025年12月締めまで）
  const first = await post('/royalty/statements/generate', {asOf: SALES_DEMO.stageAsOf, confirmed: true});
  if (first.skipped.length) throw new Error(`1回目の一括作成で作れなかった期間があります: ${JSON.stringify(first.skipped.slice(0, 3))}`);
  log(`報告書（1回目・基準日 ${SALES_DEMO.stageAsOf}）${first.created.length}通`);

  // 1回目の後: 保留を解き、遅れて届いた報告を取り込む（どちらも次の報告書に「報告後の修正」として入る）
  irregular.push((await post('/royalty/irregular-entries', {agreementId: agreementId.get('DEMO-RY-W09-ORG'), kind: 'release', accrualMonth: '2025-08', reason: '照会の回答を受け取り、数字を確認した（架空）'})).id);
  for (const report of LATE_REPORTS) await importReport(report.work, report);

  // 2回目の一括作成（基準日まで）
  const second = await post('/royalty/statements/generate', {asOf, confirmed: true});
  if (second.skipped.length) throw new Error(`2回目の一括作成で作れなかった期間があります: ${JSON.stringify(second.skipped.slice(0, 3))}`);
  log(`報告書（2回目・基準日 ${asOf}）${second.created.length}通`);

  // 報告と支払の記録: 期限を過ぎたものは報告・支払済みにする。ただし次は残す
  //   ・脚本 S4 の最新の報告書は報告の記録なし（期限超過）
  //   ・音楽 M1 と原作 O3 の最新の報告書は支払の記録なし（支払期限超過）
  //   ・監督 D2 の2025年6月締めは、支払を1回取り消して入れ直す
  const statements = (await get(`/royalty/statements?asOf=${asOf}`)).statements.sort((a, b) => a.closeMonth.localeCompare(b.closeMonth) || a.holderId - b.holderId);
  const latest = (key, due) => statements.filter((s) => s.holderId === partnerId.get(key) && due(s)).at(-1)?.id;
  const noReport = new Set([latest('S4', (s) => s.reportDueOn < asOf)]);
  const unpaid = new Set(['M1', 'O3'].map((key) => latest(key, (s) => s.payableYen > 0 && s.paymentDueOn < asOf)));
  let eventCount = 0;
  for (const s of statements) {
    if (s.reportDueOn >= asOf || noReport.has(s.id)) continue;
    await post(`/royalty/statements/${s.id}/events`, {kind: 'reported', occurredOn: minusDays(s.reportDueOn, 4), note: '報告書をPDFでメール送付（架空）'});
    eventCount += 1;
    if (s.payableYen <= 0 || s.paymentDueOn >= asOf || unpaid.has(s.id)) continue;
    const paidOn = minusDays(s.paymentDueOn, 2);
    if (s.holderId === partnerId.get('D2') && s.closeMonth === '2025-06') {
      const wrongPayment = await post(`/royalty/statements/${s.id}/events`, {kind: 'paid', occurredOn: paidOn, amountYen: s.payableYen, reference: `DEMO-PAY-${s.id}-A`});
      await post(`/royalty/statements/${s.id}/events`, {kind: 'reverse', eventId: wrongPayment.id, occurredOn: paidOn, reason: '振込先の口座を誤ったため組戻し（架空）'});
      eventCount += 2;
    }
    await post(`/royalty/statements/${s.id}/events`, {kind: 'paid', occurredOn: paidOn, amountYen: s.payableYen, reference: `DEMO-PAY-${s.id}`});
    eventCount += 1;
  }
  log(`報告と支払の記録 ${eventCount}件`);

  // 基準日の後の締め月へ入れる調整（受付中の期間に出る）
  irregular.push((await post('/royalty/irregular-entries', {holderPartnerId: partnerId.get('M3'), kind: 'adjust_amount', closeMonth: '2026-12', amountYen: 50000,
    reason: '前年の報告漏れ（放送の二次利用分）を次の報告書で精算（架空）', sourceReference: '架空の確認書 2026-09'})).id);

  // MG（受取: 海外セールスの最低保証、支払: 仕入れた配信権の最低保証）
  const supplier = await post('/mg/suppliers', {code: 'SUP-DEMO-SALES-A', name: '架空ライツ（仕入先・架空）', note: '架空データ（デモ）の仕入先'});
  const mgPhase = (startsOn, endsOn, firstCloseOn) => [{startsOn, endsOn, intervalMonths: 3, firstCloseOn, reportOffsetMonths: 1, reportDay: 28, payOffsetMonths: 2, payDay: 28}];
  const incoming = await post('/mg/contracts', {direction: 'incoming', code: 'DEMO-MGI-W04-OS', title: '「砂時計の町」海外配給の最低保証（架空）', partnerId: partnerId.get('OSA'),
    contractDate: '2024-12-20', contractSourceReference: '架空の海外セールス契約書', mgAmountYen: 4000000, startsOn: '2025-01-01', endsOn: '2026-12-31', mode: 'single',
    reason: '架空条件（デモ）', sourceReference: '架空の海外セールス契約書 第3条', products: [{productId: productId.get('DEMO-W04-OS'), evaluationYen: 4000000}],
    phases: mgPhase('2025-01-01', '2026-12-31', '2025-03-31')});
  const outgoing = await post('/mg/contracts', {direction: 'outgoing', code: 'DEMO-MGO-W13-DIG', title: '「水曜日の漂流者」配信権の最低保証（架空）', supplierId: supplier.supplierId,
    contractDate: '2025-06-10', contractSourceReference: '架空の配信権許諾契約書', mgAmountYen: 2000000, startsOn: '2025-07-01', endsOn: '2027-06-30', mode: 'single',
    reason: '架空条件（デモ）', sourceReference: '架空の配信権許諾契約書 第5条', products: [{productId: productId.get('DEMO-W13-DIG'), evaluationYen: 2000000}],
    phases: mgPhase('2025-07-01', '2027-06-30', '2025-09-30')});
  const ledger = [
    [incoming.versionId, 'DEMO-W04-OS', '2025-01-01', '2025-03-31', '2025-04', 1800000, 1800000, 0, 0],
    [incoming.versionId, 'DEMO-W04-OS', '2025-04-01', '2025-06-30', '2025-07', 1500000, 1500000, 0, 0],
    [incoming.versionId, 'DEMO-W04-OS', '2025-07-01', '2025-09-30', '2025-10', 1100000, 700000, 400000, 400000],
    [outgoing.versionId, 'DEMO-W13-DIG', '2025-07-01', '2025-09-30', '2025-10', 650000, 650000, 0, 0],
    [outgoing.versionId, 'DEMO-W13-DIG', '2025-10-01', '2025-12-31', '2026-01', 520000, 520000, 0, 0],
  ];
  for (const [index, [termVersionId, sku, periodFrom, periodTo, accountingMonth, eligible, applied, overage, recognized]] of ledger.entries()) {
    await post('/mg/ledger', {termVersionId, productId: productId.get(sku), periodFrom, periodTo, accountingMonth, sourceReference: `DEMO-MG-LEDGER-${index + 1}`,
      reportedEligibleYen: eligible, appliedRecoupYen: applied, reportedOverageYen: overage, recognizedYen: recognized, status: 'reviewed', acknowledgement: true,
      confirmationReason: '架空データ（デモ）の手入力値'});
  }

  const count = async (table) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id=?`, [orgId])).n);
  const summary = {
    skipped: false, orgId, asOf, stageAsOf: SALES_DEMO.stageAsOf,
    projects: await count('projects'), works: await count('works'), committeeWorks: committeeContracts.length, products: await count('products'),
    partners: await count('partners'), holders: HOLDERS.length, reports: await count('report_imports'), saleLines: await count('sale_lines'),
    classifiedLines: classified, expenses: await count('expenses'), agreements: await count('royalty_agreements'), termVersions: await count('royalty_term_versions'),
    scheduleVersions: await count('royalty_schedule_versions'), manualAccruals: await count('royalty_manual_accruals'), irregularEntries: await count('royalty_irregular_entries'),
    statements: await count('royalty_statements'), statementEvents: await count('royalty_statement_events'), feeShares: await count('committee_term_window_fee_shares'),
    committeeSnapshots: await count('committee_report_snapshots'), mgContracts: 2, mgLedgerRows: ledger.length,
  };
  if (summary.irregularEntries !== irregular.length + 0) throw new Error('イレギュラーの記録の件数が合いません');
  return summary;
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
    const result = await seedSalesDemo(db, {asOf: option('--as-of') || SALES_DEMO.asOf, log: (message) => console.log(`  ${message}`)});
    if (result.skipped) console.log(`${SALES_DEMO.orgCode} の架空データは投入済みです（何もしませんでした）`);
    else console.log(`投入しました（${((Date.now() - started) / 1000).toFixed(1)}秒）: ${JSON.stringify(result)}`);
  } finally {
    db.close();
  }
}
