// 放送アベイルズリストの行（17列）と Excel の書式（A3 横・局に関わる4列の見出しの色）。
// 壊れたら: 一次利用に後の日付が出る・SVOD の窓が抜ける・直近の放送局が空欄になる・印刷が A4 に戻り列が読めない。
import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync, strFromU8} from 'fflate';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {splitTitleLines, matchTitles, normalizeWorkIds, availsRow, availsSheet, availsFileName, AVAILS_COLUMNS, autoPickRows, availsMatchResult, needsConfirm, MATCH_LEVELS, addToSelection, availsMatchText, AVAILS_LINE_LIMIT} from '../src/broadcast/avails-list-model.mjs';

test('作品名の照合は完全一致 → 前方一致 → 部分一致の順で、同じ段の候補が複数なら「候補が複数」', () => {
  const works = [{id: 1, code: 'W01', title: '夜明けの貨物線（架空）', production_year: 2024}, {id: 2, code: 'W02', title: '夜明けの貨物線２', production_year: 2023}, {id: 3, code: 'W03', title: '海霧のアーカイブ'}];
  const rows = matchTitles(['夜明けの貨物線（架空）', '夜明けの', 'アーカイブ', '見当たらない', 'w-tv'], works, [{work_id: 3, sku: 'W-TV', name: '放送権'}]);
  assert.deepEqual(rows.map((r) => [r.status, r.level, r.candidates.map((c) => c.id)]), [
    ['matched', 'exact', [1]], ['ambiguous', 'prefix', [2, 1]], ['matched', 'partial', [3]], ['not_found', null, []], ['matched', 'exact', [3]],
  ], '同じ段の候補は製作年の古い順');
  assert.deepEqual(splitTitleLines('a\n\n b \n').lines, ['a', 'b']);
  assert.match(splitTitleLines(Array(201).fill('x').join('\n')).error, /200行まで/);
  assert.deepEqual(normalizeWorkIds('3,1,3').workIds, [3, 1], '重なりは最初だけ・選んだ順');
  assert.match(normalizeWorkIds('1,abc').error, /正しくありません/);
});

test('1作品の行: 一次利用は劇場・DVD の最も早い日、SVOD の窓を並べ、出演・監督・時間・言語を作品情報から出す', () => {
  const row = availsRow({id: 1, title: '夜明けの貨物線（架空）'}, {
    windows: [
      {type_key: 'package_sell', type_label: 'DVD・BD発売', start_on: '2025-01-05', date_precision: 'day', status: 'confirmed'},
      {type_key: 'theatrical', type_label: '劇場公開・配給開始', start_on: '2024-07', date_precision: 'month', status: 'confirmed'},
      {type_key: 'svod_regular', start_on: '2026-03-01', end_on: '2028-02-29', date_precision: 'day', status: 'draft'},
      {type_key: 'svod_early', start_on: '2025-03-01', end_on: '2026-02-28', date_precision: 'day', status: 'confirmed'},
      {type_key: 'svod_early', start_on: null, date_precision: 'tbd', status: 'draft'},
    ],
    catalog: {production_year: 2023, synopsis_short: '短い紹介', synopsis_long: '長いあらすじ'},
    credits: [{role: 'director', name: '監督（架空）'}, {role: 'cast', name: '出演A（架空）'}, {role: 'cast', name: '出演B（架空）'}],
    runtimeSeconds: 7080, languages: ['日本語', '英語'], sku: 'W01-TV',
    recent: [{stationText: '局A', historyText: '2025年12月～2026年2月 局A様'}], proposal: '放送可：2026年10月1日〜2028年9月26日',
  });
  assert.equal(row.first_use, '2024年7月 劇場公開・配給開始');
  assert.equal(row.svod, 'SVOD先行：2025/03/01～2026/02/28\nSVOD通常：2026/03/01～2028/02/29（予定）');
  assert.deepEqual([row.cast, row.director, row.runtime, row.format], ['出演A（架空）、出演B（架空）', '監督（架空）', '118分', '言語: 日本語・英語（画質は要確認）']);
  assert.deepEqual([row.recent_stations, row.recent_history, row.availability], ['局A', '2025年12月～2026年2月 局A様', '放送可：2026年10月1日〜2028年9月26日']);
  const empty = availsRow({id: 2, title: '空'}, {});
  assert.deepEqual([empty.recent_stations, empty.recent_history, empty.availability, empty.svod, empty.format], ['放送実績なし', '放送実績なし', '要確認', '未登録', '要確認']);
});

test('Excel は17列の中立の見出しで、A3 横・1ページ幅、局に関わる4列の見出しを橙黄にし、ファイル名は先頭の作品名と件数', () => {
  assert.equal(AVAILS_COLUMNS.length, 17);
  const rows = [availsRow({id: 1, title: '作品一'}, {}), availsRow({id: 2, title: '作品二'}, {})];
  const bytes = encodeReportXlsx({sheets: [availsSheet(rows, {asOf: '2026-09-26'})]});
  const [sheet] = decodeXlsx(bytes);
  assert.equal(sheet.rows[4].length, 17);
  assert.deepEqual(sheet.rows.slice(5, 7).map((r) => r[2]), ['作品一', '作品二']);
  assert.match(sheet.rows[1][0], /基準日 2026-09-26 ／ 作品 2件（選んだ順）/);
  const files = unzipSync(bytes);
  const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.match(xml, /<pageSetup paperSize="8" orientation="landscape" fitToWidth="1"/, 'A3（paperSize 8）・横');
  const styles = strFromU8(files['xl/styles.xml']);
  const fills = [...styles.matchAll(/<fill>(.*?)<\/fill>/g)].map((m) => (/fgColor rgb="(\w+)"/.exec(m[1]) || [])[1] || null);
  const xfFill = [...styles.match(/<cellXfs[^>]*>(.*?)<\/cellXfs>/)[1].matchAll(/<xf [^>]*fillId="(\d+)"/g)].map((m) => fills[Number(m[1])]);
  const headerFill = (col) => xfFill[Number(new RegExp(`<c r="${col}5" t="inlineStr" s="(\\d+)"`).exec(xml)[1])];
  assert.deepEqual(['G', 'H', 'I', 'J'].map(headerFill), ['FFFFE699', 'FFFFE699', 'FFFFE699', 'FFFFE699']);
  assert.equal(headerFill('C'), 'FFF2F2F2');
  assert.equal(availsFileName(rows, '2026-09-26'), '放送アベイルズリスト_作品一他1件_20260926.xlsx');
  assert.equal(availsFileName(rows.slice(0, 1), '2026-09-26'), '放送アベイルズリスト_作品一_20260926.xlsx');
});

test('照合の後に自動で入れるのは完全一致の1件だけ。前方一致・部分一致の1件は段を示して「入れる」を押してもらう', () => {
  const works = [{id: 1, code: 'W01', title: '夜明けの貨物線（架空）'}, {id: 2, code: 'W02', title: '七月の標本室（架空）'}, {id: 3, code: 'W03', title: '海霧のアーカイブ'}];
  const result = availsMatchResult('貨物\n標本\n夜明け\nアーカイブ\n夜明けの貨物線 完全版\nW01', {works});
  assert.deepEqual(result.rows.map((row) => [row.input, row.status, row.level]), [
    ['貨物', 'matched', 'partial'], ['標本', 'matched', 'partial'], ['夜明け', 'matched', 'prefix'], ['アーカイブ', 'matched', 'partial'], ['夜明けの貨物線 完全版', 'not_found', null], ['W01', 'matched', 'exact'],
  ]);
  assert.deepEqual(autoPickRows(result.rows).map((w) => w.id), [1], '「W01」（完全一致）だけ。「夜明け」（前方一致）は入れない');
  assert.deepEqual(result.rows.filter(needsConfirm).map((row) => row.input), ['貨物', '標本', '夜明け', 'アーカイブ']);
  assert.deepEqual(result.counts, {matched: 5, ambiguous: 0, not_found: 1, prefix: 1, partial: 3});
  assert.equal(MATCH_LEVELS.partial, '部分一致');
});

test('1〜2文字の貼り付けが1つの作品に前方一致しても自動では入れず、正規化した上で完全一致した行（全角・空白・括弧の違い）だけを入れる', () => {
  const works = [{id: 1, code: 'W01', title: '夜明けの貨物線（架空）'}, {id: 2, code: 'W02', title: '七月の標本室（架空）'}, {id: 3, code: 'W03', title: '海霧のアーカイブ'}];
  const text = ['夜', '七月', 'w', 'Ｗ０２', ' 海霧の アーカイブ ', '「夜明けの貨物線」'].join('\n');
  const result = availsMatchResult(text, {works, products: [{work_id: 3, sku: 'W03-TV', name: '放送権'}]});
  assert.deepEqual(result.rows.map((row) => [row.input, row.status, row.level]), [
    ['夜', 'matched', 'prefix'], ['七月', 'matched', 'prefix'], ['w', 'ambiguous', 'prefix'], ['Ｗ０２', 'matched', 'exact'], ['海霧の アーカイブ', 'matched', 'exact'], ['「夜明けの貨物線」', 'matched', 'prefix'],
  ]);
  assert.deepEqual(autoPickRows(result.rows).map((w) => w.id), [2, 3], '完全一致の W02・W03 だけ');
  assert.deepEqual(result.rows.filter(needsConfirm).map((row) => row.input), ['夜', '七月', '「夜明けの貨物線」'], '1文字・2文字・（架空）の無い題名は利用者が確かめる');
  assert.deepEqual(result.counts, {matched: 5, ambiguous: 1, not_found: 0, prefix: 3, partial: 0});
  assert.equal(needsConfirm(result.rows[2]), false, '候補が複数の行は候補から選ぶ（「入れる」の確認とは別）');
});

test('照合の案内は自動でリストに入れた件数を出し、0件なら「入れました」と書かない（もう入っていた・上限で入らなかった件数は分けて書く）', () => {
  const works = [{id: 1, code: 'W01', title: '夜明けの貨物線（架空）'}, {id: 2, code: 'W02', title: '七月の標本室（架空）'}, {id: 3, code: 'W03', title: '海霧のアーカイブ'}];
  // 完全一致 2件（W01・W02）と前方一致 1件（夜）と見つからない 1件
  const first = availsMatchResult(['W01', 'W02', '夜', '存在しない作品（架空）'].join('\n'), {works});
  const picked = addToSelection([], autoPickRows(first.rows));
  assert.deepEqual([picked.added, picked.already, picked.overLimit], [2, 0, 0]);
  assert.deepEqual(picked.next, [{id: 1, code: 'W01', title: '夜明けの貨物線（架空）'}, {id: 2, code: 'W02', title: '七月の標本室（架空）'}]);
  assert.equal(availsMatchText(first, picked), '照合の結果: 一致 3件・候補が複数 0件・見つからない 1件。完全一致の 2件をリストに入れました。前方一致・部分一致の 1件は作品名を確かめて「入れる」を押してください。');
  // 完全一致が0件（前方一致の1件だけ）なら「入れました」と書かない
  const prefixOnly = availsMatchResult('夜', {works});
  const none = addToSelection(picked.next, autoPickRows(prefixOnly.rows));
  assert.deepEqual([none.added, none.already, none.overLimit, none.next.length], [0, 0, 0, 2]);
  const text = availsMatchText(prefixOnly, none);
  assert.equal(text, '照合の結果: 一致 1件・候補が複数 0件・見つからない 0件。前方一致・部分一致の 1件は作品名を確かめて「入れる」を押してください。');
  assert.doesNotMatch(text, /入れました/);
  assert.equal(availsMatchText(availsMatchResult('存在しない作品（架空）', {works}), addToSelection([], [])), '照合の結果: 一致 0件・候補が複数 0件・見つからない 1件。');
  // もう入っている作品（W01）は数に入れず分けて書く。同じ作品を2行貼っても1件
  const again = availsMatchResult(['W01', '夜明けの貨物線（架空）', 'W03'].join('\n'), {works});
  const partly = addToSelection(picked.next, autoPickRows(again.rows));
  assert.deepEqual([partly.added, partly.already, partly.overLimit], [1, 1, 0]);
  assert.deepEqual(partly.next.map((w) => w.id), [1, 2, 3]);
  assert.equal(availsMatchText(again, partly), '照合の結果: 一致 3件・候補が複数 0件・見つからない 0件。完全一致の 1件をリストに入れました。完全一致の 1件はもうリストに入っています。');
  const onlyAlready = addToSelection(partly.next, autoPickRows(availsMatchResult('W02', {works}).rows));
  assert.doesNotMatch(availsMatchText(availsMatchResult('W02', {works}), onlyAlready), /入れました/, 'もう入っていた作品だけなら「入れました」と書かない');
  // 上限（200件）に達したリストには入れず、その件数を書く
  const full = Array.from({length: AVAILS_LINE_LIMIT}, (_, i) => ({id: 1000 + i, code: `F${i}`, title: `満杯${i}（架空）`}));
  const over = addToSelection(full, autoPickRows(availsMatchResult('W03', {works}).rows));
  assert.deepEqual([over.added, over.already, over.overLimit, over.next.length], [0, 0, 1, AVAILS_LINE_LIMIT]);
  const overText = availsMatchText(availsMatchResult('W03', {works}), over);
  assert.equal(overText, `照合の結果: 一致 1件・候補が複数 0件・見つからない 0件。リストが${AVAILS_LINE_LIMIT}件に達したため、完全一致の 1件は入れていません。`);
  assert.doesNotMatch(overText, /入れました/);
});

test('ファイル名の題名は文字単位で40文字に切り、サロゲートペアを割らない（符号化できる）', () => {
  const title = `${'あ'.repeat(39)}\u{20BB7}野家の架空作品`;
  const name = availsFileName([{title}], '2026-09-26');
  assert.equal(name, `放送アベイルズリスト_${'あ'.repeat(39)}\u{20BB7}_20260926.xlsx`);
  assert.equal(name.isWellFormed(), true);
  assert.doesNotThrow(() => encodeURIComponent(name));
  assert.doesNotThrow(() => encodeURIComponent(availsFileName([{title: 'a\uD842'}], '2026-09-26')), '元から孤立したサロゲートがあっても投げない');
});
