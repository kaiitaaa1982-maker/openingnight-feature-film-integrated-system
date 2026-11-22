// 表の見本（mode local だけ）の架空データと、シートの組み立て。値はすべて架空（作品・場所・支払先・金額）。
// 会社ルートの plans/_mocks/2026-11-20-genba-inbox/ の「未解決」「経費」と同じ列を、共通の表（EditSheet）の列で並べる。
import {summarize} from '../edit-sheet-model.mjs';

export const SAMPLE_YEAR = 2026;
export const CLOSED_MESSAGE = '今回は開けません';

// ── 未解決（撮れなかったシーンの移し先） ──
export const SHOOT_DAYS = Object.freeze({1: '2026-11-17', 2: '2026-11-18', 3: '2026-11-19', 4: '2026-11-21', 5: '2026-11-22', 6: '2026-11-24'});
// 移し先は撮影日に ID で結ぶ（候補から選ぶ）。欠番も1つの行き先
export const MOVE_TO = Object.freeze([
  {value: 'D4', label: '4日目 11/21', day: 4}, {value: 'D5', label: '5日目 11/22', day: 5}, {value: 'D6', label: '6日目 11/24', day: 6}, {value: 'DROP', label: '欠番'},
]);
export const REASONS = Object.freeze(['雨', '時間切', '機材', '体調', 'ほか']);
const SCENES = Object.freeze([
  [1, '海辺の道', 'D', 1], [2, '海辺の道', 'D', 1], [3, '灯台', 'D', 1], [4, '灯台', 'D', 1], [5, '坂道', 'D', 1], [6, '坂道', 'N', 1],
  [7, '公民館', 'D', 2], [8, '公園', 'D', 2], [9, '公園', 'D', 2], [10, '喫茶店', 'D', 2], [11, '喫茶店', 'N', 2],
  [12, '駅前ロータリー', 'D', 3], [13, '駅のホーム', 'D', 3], [14, '商店街', 'D', 3],
  [15, '港の倉庫', 'D', 4], [16, '港の倉庫', 'N', 4], [17, '漁協の事務所', 'D', 4], [18, '防波堤', 'N', 4],
  [19, '診療所', 'D', 2], [20, '診療所', 'D', 5], [21, '学校の屋上', 'D', 5], [22, '学校の廊下', 'D', 5],
  [23, '汽車の車内', 'D', 6], [24, '汽車の車内', 'N', 6], [25, '川べり', 'D', 5], [26, '駅のホーム', 'N', 6],
  [27, '川べり', 'N', 3], [31, 'アパート 室内', 'N', 3], [32, 'アパート 廊下', 'N', 3],
]);
const sceneOf = (s) => SCENES.find((scene) => scene[0] === s) || [s, '', '', null];

export function leftoverRows() {
  return [
    {id: 'L1', s: 5, from: 1, result: '撮れず', why: '雨', to: '', memo: ''},
    {id: 'L2', s: 14, from: 3, result: '一部', why: '時間切', to: '', memo: ''},
    {id: 'L3', s: 27, from: 3, result: '撮れず', why: '雨', to: '', memo: ''},
    {id: 'L4', s: 8, from: 2, result: '一部', why: '機材', to: 'D4', memo: '引きだけ残り'},
    {id: 'L5', s: 19, from: 2, result: '撮れず', why: '体調', to: 'DROP', memo: ''},
  ];
}

const LEFTOVER_COLUMNS = [
  {key: 's', label: 'S#', type: 'int', width: 84, readOnly: true},
  {key: 'place', label: '場所', width: 150, value: (row) => sceneOf(row.s)[1]},
  {key: 'dn', label: 'D/N', width: 90, value: (row) => sceneOf(row.s)[2]},
  {key: 'from', label: '元の日', type: 'date', year: SAMPLE_YEAR, width: 96, value: (row) => SHOOT_DAYS[row.from] || ''},
  {key: 'result', label: '結果', width: 96, value: (row) => (row.to ? '決まり' : row.result), badge: (row) => (row.to ? 'weak' : 'stop')},
  {key: 'why', label: '理由', type: 'choice', width: 110, options: REASONS},
  {key: 'to', label: '移し先', type: 'lookup', width: 150, options: MOVE_TO},
  {key: 'memo', label: 'メモ', width: 220},
];

export function sceneStates(leftovers) {
  return SCENES.map(([s, place, dn, day]) => {
    const left = leftovers.find((row) => row.s === s);
    let state;
    let shootDay = day;
    if (left && !left.to) {
      state = '未解決';
      shootDay = left.from;
    } else if (left?.to === 'DROP') {
      state = '欠番';
      shootDay = null;
    } else if (left) {
      state = '予定';
      shootDay = MOVE_TO.find((option) => option.value === left.to)?.day ?? null;
    } else state = day <= 3 ? '撮れた' : '予定';
    return {id: `S${s}`, s, place, dn, state, date: shootDay ? SHOOT_DAYS[shootDay] : ''};
  });
}

const STATE_TONE = {撮れた: 'weak', 予定: 'plain', 欠番: 'weak', 未解決: 'stop'};
export function sceneCounts(scenes) {
  const counts = {撮れた: 0, 予定: 0, 欠番: 0, 未解決: 0};
  for (const scene of scenes) counts[scene.state] += 1;
  return counts;
}

export function leftoverSheets(leftovers) {
  const scenes = sceneStates(leftovers);
  return [
    {id: 'leftover', label: '未解決', editable: true, columns: LEFTOVER_COLUMNS, rows: leftovers},
    {id: 'scenes', label: '全シーン', editable: false, rows: scenes, counts: sceneCounts(scenes), columns: [
      {key: 's', label: 'S#', type: 'int', width: 84},
      {key: 'place', label: '場所', width: 170},
      {key: 'dn', label: 'D/N', width: 90},
      {key: 'state', label: '状態', width: 110, badge: (row) => STATE_TONE[row.state]},
      {key: 'date', label: '撮影日', type: 'date', year: SAMPLE_YEAR, width: 120},
    ]},
  ];
}

// ── 経費（明細と、日別・支払先別・費目別の集計） ──
export const PAYEES = Object.freeze([
  {value: 'P01', label: 'まるや弁当'}, {value: 'P02', label: 'コインP 東町'}, {value: 'P03', label: 'スーパーかもめ'},
  {value: 'P04', label: 'みなと交通'}, {value: 'P05', label: '文具のたちばな'},
]);
export const CATEGORIES = Object.freeze([
  {value: 'C01', label: '弁当'}, {value: 'C02', label: '駐車'}, {value: 'C03', label: '消え物'}, {value: 'C04', label: '交通'}, {value: 'C05', label: '備品'},
]);
export const CHECKS = Object.freeze([{value: 'no', label: '未確認'}, {value: 'yes', label: '確認済'}]);

export function expenseRows() {
  const raw = [
    ['2026-11-17', 'P01', 'C01', '昼夜 32食', 28800, 'yes'], ['2026-11-17', 'P02', 'C02', '撮影車 2台', 1800, 'yes'],
    ['2026-11-17', 'P05', 'C05', '養生テープ ほか', 3520, 'yes'], ['2026-11-17', 'P04', 'C04', '駅から灯台', 3960, 'yes'],
    ['2026-11-18', 'P01', 'C01', '昼夜 34食', 30600, 'yes'], ['2026-11-18', 'P03', 'C03', '果物 食卓用', 2284, 'yes'],
    ['2026-11-18', 'P02', 'C02', '撮影車 2台', 2100, 'yes'], ['2026-11-19', 'P02', 'C02', '撮影車 2台', 2400, 'no'],
    ['2026-11-19', 'P03', 'C03', 'パン 牛乳', 1836, 'no'], ['2026-11-19', 'P01', 'C01', '昼 18食', 16200, 'no'],
    ['2026-11-19', 'P04', 'C04', '駅から川べり', 4180, 'no'], ['2026-11-19', 'P01', 'C01', '夜 18食', 16200, 'no'],
  ];
  return raw.map(([d, payee, category, memo, amount, ok], i) => ({id: `E${i + 1}`, d, payee, category, memo, amount, receipt: '有', ok}));
}

export const newExpenseRow = (id) => ({id, d: '', payee: '', category: '', memo: '', amount: null, receipt: '', ok: 'no'});

const DAY_NUMBER = Object.fromEntries(Object.entries(SHOOT_DAYS).map(([day, date]) => [date, Number(day)]));
const optionLabel = (options, value) => options.find((option) => option.value === value)?.label ?? value;

function summaryColumns(first) {
  return [
    first,
    {key: 'count', label: '件数', type: 'int', width: 90, total: 'sum'},
    {key: 'amount', label: '金額', type: 'yen', width: 130},
    {key: 'share', label: '構成比', type: 'rate', width: 100},
    {key: 'unchecked', label: '未確認', type: 'int', width: 110, total: 'sum'},
  ];
}

const measures = {amount: (row) => row.amount ?? 0, unchecked: (row) => (row.ok === 'yes' ? 0 : 1)};
const summary = (rows, keyOf) => summarize(rows, keyOf, {measures, share: 'amount'}).map((group) => ({...group, id: `g:${group.key}`}));

export function expenseSheets(rows, {payees = PAYEES, onCreatePayee} = {}) {
  const unchecked = (row) => row.ok !== 'yes';
  return [
    {id: 'detail', label: '明細', editable: true, rows, columns: [
      {key: 'd', label: '日付', type: 'date', year: SAMPLE_YEAR, width: 96},
      {key: 'payee', label: '支払先', type: 'lookup', width: 190, options: payees, onCreate: onCreatePayee},
      {key: 'category', label: '費目', type: 'lookup', width: 120, options: CATEGORIES},
      {key: 'memo', label: '内容', width: 170},
      {key: 'amount', label: '金額', type: 'yen', width: 120},
      {key: 'receipt', label: '証憑', width: 100, readOnly: true},
      {key: 'ok', label: '札', type: 'choice', width: 100, options: CHECKS, badge: (row) => (unchecked(row) ? 'plain' : 'weak')},
    ]},
    {id: 'by-day', label: '日別', editable: false, rows: summary(rows, (row) => row.d), columns: summaryColumns(
      {key: 'key', label: '日', type: 'date', year: SAMPLE_YEAR, width: 150,
        text: (row) => (row.key ? `${DAY_NUMBER[row.key] ? `${DAY_NUMBER[row.key]}日目 ` : ''}${Number(row.key.slice(5, 7))}/${row.key.slice(8)}` : '')},
    )},
    {id: 'by-payee', label: '支払先別', editable: false, rows: summary(rows, (row) => row.payee), columns: summaryColumns(
      {key: 'key', label: '支払先', width: 190, text: (row) => optionLabel(payees, row.key)},
    )},
    {id: 'by-category', label: '費目別', editable: false, rows: summary(rows, (row) => row.category), columns: summaryColumns(
      {key: 'key', label: '費目', width: 150, text: (row) => optionLabel(CATEGORIES, row.key)},
    )},
  ];
}
