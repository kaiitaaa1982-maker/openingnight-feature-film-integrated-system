import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {encodeReportXlsx} from '../src/xlsx-report.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {
  distributionGroups, distributionText, stationStatus, partnerItems, slotActions, waitingDays, approvalSummary,
  reasonError, conflictText, transitionMessage,
} from '../src/broadcast/broadcast-model.mjs';
import {
  mapHeaders, readImportTable, parseMonthCell, parseDateCell, parseIntCell, parseChoiceCell, failedRowSheets, distributionLabel,
  SLOT_SHEET, AVAIL_SHEET, summarizeRows, validateSlotRow, tableFromSheets, territoryVariant,
} from '../src/broadcast/broadcast-sheet.mjs';
import {slotChangeDetails, slotFormErrors, slotPayload, blankSlotForm, slotFormFromRow, conditionChangeDetails, conditionDraftFromRow, changeNoticeDetails, currentMonthJst} from '../src/broadcast-draft.mjs';

async function masterTypes(t) {
  const db = await openTestDb({t});
  try {
    return await db.all(`SELECT t.code,t.family,t.label,m.distribution_name,m.transaction_method,m.sales_type,CASE WHEN m.code IS NULL THEN 1 ELSE 0 END AS legacy
      FROM distribution_types t LEFT JOIN distribution_master m ON m.code=t.code ORDER BY CASE WHEN m.code IS NULL THEN 1 ELSE 0 END,t.sort_order`);
  } finally {
    await db.close();
  }
}

test('distribution choices come only from the master, grouped by 分類, with distinguishable labels', async (t) => {
  const types = await masterTypes(t);
  const groups = distributionGroups(types);
  const options = groups.flatMap((group) => group.options);
  assert.ok(options.length >= 30);
  assert.ok(!options.some((option) => ['theatrical', 'est', 'tvod', 'broadcast_free', 'other'].includes(option.value)), 'legacy codes are not offered');
  const master = types.filter((type) => !type.legacy);
  assert.equal(new Set(master.map((type) => `${type.distribution_name}|${distributionLabel(type)}`)).size, master.length, 'every choice is distinguishable even without the code');
  assert.ok(groups.some((group) => group.group === '放送' && group.options.some((option) => option.value === 'B001')));
  assert.equal(distributionLabel(types.find((type) => type.code === 'H001')), '劇場_RS');
  assert.equal(distributionLabel(types.find((type) => type.code === 'R001')), 'レンタル_RSS（LF）');
  assert.equal(distributionLabel(types.find((type) => type.code === 'D003')), 'EST（RS）');
  assert.match(distributionText({distribution_code: 'broadcast_free'}, types), /^旧区分：/);
  assert.equal(distributionText({distribution_code: 'B001'}, types), '放送・放送_FLAT');
  assert.equal(distributionText({distribution_code: 'NOPE'}, types), '未登録の流通（NOPE）');
});

test('stations are partners with the broadcaster role; other names are shown as 未登録の局', () => {
  const partners = [
    {id: 1, code: 'PT-CINEMA', name: '架空シネマ', kind: 'cinema', roles: ['customer']},
    {id: 10, code: 'PT-TV', name: '架空テレビ', kind: 'other', roles: ['broadcaster', 'customer']},
  ];
  assert.equal(stationStatus('架空テレビ', partners).registered, true);
  assert.equal(stationStatus(' 架空 テレビ ', partners).registered, true, 'spaces and width are absorbed');
  assert.equal(stationStatus('PT-TV', partners).partner.id, 10, 'the code also matches');
  assert.deepEqual(stationStatus('架空シネマ', partners), {registered: false, label: '未登録の局', partner: null}, 'a partner without the broadcaster role is not a station');
  assert.equal(stationStatus('', partners).label, '未入力');
  const items = partnerItems(partners, {preferRole: 'broadcaster'});
  assert.equal(items[0].id, 10, 'stations come first');
  assert.match(items[0].hint, /放送局・得意先/);
});

test('slot actions follow the approval flow and the role', () => {
  const kinds = (row, options) => slotActions(row, options).map((action) => action.kind);
  assert.deepEqual(kinds({status: 'pending_first'}, {canEdit: true, isAdmin: false}), ['cancel'], 'an editor cannot approve or send back');
  assert.deepEqual(kinds({status: 'pending_first'}, {canEdit: true, isAdmin: true}), ['approve', 'reject', 'cancel']);
  assert.deepEqual(kinds({status: 'draft'}, {canEdit: true}), ['submit', 'cancel']);
  assert.deepEqual(kinds({status: 'confirmed'}, {canEdit: true, isAdmin: true}), ['cancel']);
  assert.deepEqual(kinds({status: 'cancelled'}, {canEdit: true, isAdmin: true}), []);
  assert.deepEqual(kinds({status: 'draft'}, {canEdit: false, isAdmin: true}), [], 'no edit permission, no actions');
  const [approve, reject, cancel] = slotActions({status: 'pending_final'}, {canEdit: true, isAdmin: true});
  assert.equal(approve.label, '確定を承認');
  assert.equal(reject.needsReason, true);
  assert.equal(cancel.irreversible, true, '中止 cannot be undone, so the screen asks twice');
  assert.deepEqual(kinds({status: 'pending_final'}, {canEdit: true, isAdmin: true, include: ['approve', 'reject']}), ['approve', 'reject']);
  assert.equal(reasonError('  ', {kind: 'reject'}), '差し戻す理由を入れてください（申請した人に表示されます）');
  assert.equal(reasonError('期間を直してください'), null);
  assert.equal(conflictText('red'), '競合：確定済みの別局と同じ月');
  assert.equal(transitionMessage({workTitle: '架空作品', broadcastMonth: '2026-11', stationName: '架空テレビ'}, 'tentative', 3), '架空作品・2026年11月・架空テレビを「仮押さえ」にしました（第3版）');
});

test('waiting days count Japan calendar days from the SQLite UTC timestamp', () => {
  const now = new Date('2026-09-24T01:00:00Z'); // 日本時間 9/24 10:00
  assert.equal(waitingDays('2026-09-23 14:59:00', now), 1, 'UTC 14:59 is 23:59 JST on 9/23');
  assert.equal(waitingDays('2026-09-23 15:00:00', now), 0, 'UTC 15:00 is already 9/24 JST');
  assert.equal(waitingDays('2026-09-20T00:00:00Z', now), 4);
  assert.equal(waitingDays(null, now), null);
  const summary = approvalSummary([
    {status: 'pending_first', requestedAt: '2026-09-20 00:00:00', workId: 1, conflict: 'yellow'},
    {status: 'pending_final', requestedAt: '2026-09-23 00:00:00', workId: 2, conflict: null},
    {status: 'draft', requestedAt: '2026-09-01 00:00:00', workId: 1},
  ], now);
  assert.deepEqual(summary, {first: 1, final: 1, pending: 2, conflicts: 1, oldestDays: 4, works: 2});
});

test('the window status uses the same vocabulary as the sales conditions (labels.mjs)', async () => {
  const {broadcastStatus} = await import('../src/broadcast-window-model.mjs');
  assert.equal(broadcastStatus({status: 'draft', release_on: '2026-01-01', sales_end_on: '2026-02-01'}), '条件未確定');
  assert.equal(broadcastStatus({status: 'confirmed', release_on: '2026-01-01', sales_end_on: '2026-02-01'}), '条件確認済み');
  assert.equal(broadcastStatus({status: 'withdrawn'}), '取り下げ');
});

test('without the shared territory resolver, a territory variant is still pointed out', () => {
  assert.equal(territoryVariant('国内', ['日本']), '日本');
  assert.equal(territoryVariant('Japan', ['日本', '北米']), '日本');
  assert.equal(territoryVariant('日本', ['日本']), null);
  assert.equal(territoryVariant('北米', ['日本']), null);
});

test('cell parsers absorb the usual Excel and Japanese spellings', () => {
  assert.equal(parseMonthCell('2026年11月').value, '2026-11');
  assert.equal(parseMonthCell('2026/1').value, '2026-01');
  assert.equal(parseMonthCell('2026-11-01').value, '2026-11', 'Excel turns 2026-11 into a date');
  assert.equal(parseMonthCell('2026-13').ok, false);
  assert.equal(parseMonthCell('').value, null);
  assert.equal(parseDateCell('2026/2/3').value, '2026-02-03');
  assert.equal(parseDateCell('２０２６年１１月１日').value, '2026-11-01');
  assert.equal(parseDateCell('2026-02-30').ok, false);
  assert.equal(parseIntCell('１,２００').value, 1200);
  assert.equal(parseIntCell('3回').value, 3);
  assert.equal(parseIntCell('0', {min: 1}).ok, false);
  assert.equal(parseChoiceCell('availabilityStatus', '条件確認済み').value, 'confirmed');
  assert.equal(parseChoiceCell('availabilityStatus', 'withdrawn').value, 'withdrawn');
  assert.equal(parseChoiceCell('availabilityStatus', '取下げ').value, 'withdrawn');
  assert.equal(parseChoiceCell('exclusivity', '', 'unknown').value, 'unknown');
  assert.equal(parseChoiceCell('exclusivity', 'たぶん').ok, false);
});

test('headers: Japanese and English keys map to the same meaning, 参考_ is skipped, unknown columns are reported', () => {
  const ja = mapHeaders(['放送枠ID', '版', '作品コード', '放送月', '放送局', '参考_取引先名', 'メモ'], SLOT_SHEET);
  assert.equal(ja.mode, 'ja');
  assert.deepEqual(ja.references, ['参考_取引先名']);
  assert.deepEqual(ja.unknown, ['メモ']);
  assert.equal(ja.headerOf.station_name, '放送局');
  const en = mapHeaders(['slot_id', 'revision', 'work_id', 'broadcast_month', 'station_name'], SLOT_SHEET);
  assert.equal(en.mode, 'en');
  assert.equal(en.headerOf.slot_id, 'slot_id');
  assert.equal(mapHeaders(['放送局名'], SLOT_SHEET).headerOf.station_name, '放送局名', 'a common synonym is accepted');
  assert.throws(() => readImportTable({table: {headers: ['放送局', '放送局'], rows: [['a', 'b']]}}, SLOT_SHEET), /同じ名前の列/);
  assert.throws(() => readImportTable({table: {headers: ['作品コード', '放送月', '放送局', '期間開始', '期間終了'], rows: Array.from({length: 201}, () => ['W', '2026-11', 'a', '2026-11-01', '2026-11-02'])}}, SLOT_SHEET), /200行まで/);
  const table = readImportTable({table: {headers: ['作品コード', '放送月', '放送局', '期間開始', '期間終了'], rows: [['W', '2026-11', 'a', '2026-11-01', '2026-11-02'], [null, '', '', '', ''], ['W', '2026-12', 'b', '2026-12-01', '2026-12-02']]}}, SLOT_SHEET);
  assert.deepEqual(table.rows.map((row) => row.rowNo), [2, 4], 'blank rows are skipped but the Excel row numbers are kept');
  const avail = readImportTable({csv: '作品コード,流通コード,地域,根拠\r\nW,B001,日本,架空\r\n'}, AVAIL_SHEET);
  assert.equal(avail.rows[0].values.distribution_code, 'B001');
});

test('the failed-row Excel keeps the original cells with the reasons, and re-reading it ignores the 参考_ columns', () => {
  const table = readImportTable({table: {headers: ['作品コード', '放送月', '放送局', '期間開始', '期間終了', '根拠'], rows: [['W', '2026-13', '', '2026-11-01', '2026-11-02', 'x'], ['W', '2026-11', '局', '2026-11-01', '2026-11-02', 'y']]}}, SLOT_SHEET);
  const ctx = {work: {id: 1, code: 'W'}, partners: [], stations: [], agreements: [], slots: new Map(), seen: new Map()};
  const results = table.rows.map((row) => validateSlotRow(row, table.mapping, ctx));
  const summary = summarizeRows(results, table);
  assert.equal(summary.ok, false);
  assert.equal(summary.counts.errors, 1);
  assert.equal(summary.failedRows[0].rowNo, 2);
  const sheets = failedRowSheets(SLOT_SHEET, {fileName: '放送枠.xlsx', headers: summary.headers, failedRows: summary.failedRows});
  const decoded = decodeXlsx(encodeReportXlsx({sheets}));
  const failed = decoded.find((sheet) => sheet.name === '失敗行');
  assert.deepEqual(failed.rows[0], ['参考_元の行番号', '作品コード', '放送月', '放送局', '期間開始', '期間終了', '根拠', '参考_エラー理由']);
  assert.equal(failed.rows[1][0], 2);
  assert.equal(failed.rows[1][2], '2026-13');
  assert.match(failed.rows[1][7], /放送月: /);
  const picked = tableFromSheets(decoded, SLOT_SHEET.name);
  assert.equal(picked.sheetName, '失敗行', 'without a 放送枠 sheet the first data sheet is read, not the guide');
  assert.equal(picked.table.rows[0].rowNo, 2);
  assert.throws(() => tableFromSheets([{name: '記入ガイド', rows: [['a']]}], '放送枠'), /シートが見つかりません/);
  const reread = readImportTable({table: {headers: failed.rows[0], rows: failed.rows.slice(1)}}, SLOT_SHEET);
  assert.deepEqual(reread.mapping.references, ['参考_元の行番号', '参考_エラー理由']);
  assert.equal(reread.rows[0].values.broadcast_month, '2026-13');
});

test('slot drafts: payload, field errors and the change list shown after saving', () => {
  assert.match(currentMonthJst(new Date('2026-09-30T16:00:00Z')), /^2026-10$/, 'the month is the Japan month');
  const blank = blankSlotForm(1, '2026-11');
  const errors = slotFormErrors({...blank, periodFrom: '2026-12-01', periodTo: '2026-11-02', plannedRuns: '０'});
  assert.equal(errors.stationName, '放送局を選ぶか、一覧にない局名を入れてください');
  assert.equal(errors.periodFrom, '放送月（2026-11）の中の日付にしてください');
  assert.equal(errors.plannedRuns, '1〜9999の整数で入れてください');
  assert.deepEqual(slotFormErrors({...blank, stationName: '局', periodFrom: '2026-11-01', periodTo: '2026-11-30', plannedRuns: '２'}), {});
  assert.equal(slotPayload({...blank, plannedRuns: '２回'}).plannedRuns, '2');
  const original = {work_id: 1, revision: 2, broadcast_month: '2026-11', station_name: '架空テレビ', customer_partner_id: 10, agency_partner_id: null, agreement_id: null, period_from: '2026-11-01', period_to: '2026-11-30', planned_on: null, planned_runs: 2, source_reference: '架空編成表'};
  const form = {...slotFormFromRow(original), stationName: '別の架空局', customerPartnerId: '', plannedRuns: '3'};
  const changes = slotChangeDetails(form, original, {partners: [{id: 10, name: '架空テレビ'}]});
  assert.deepEqual(changes.map((change) => [change.label, change.before, change.after]), [
    ['放送局', '架空テレビ', '別の架空局'], ['取引先', '架空テレビ', '未紐付け'], ['予定回数', '2回', '3回'],
  ]);
  assert.deepEqual(slotChangeDetails(slotFormFromRow(original), original), [], 'no change, no list');
  assert.deepEqual(changeNoticeDetails(changes)[0], {column: '放送局', message: '架空テレビ → 別の架空局'});
  const draft = conditionDraftFromRow(1, {distribution_code: 'B001', territory: '日本', version_no: 1, release_on: '2026-10-01', sales_end_on: null, terms_text: '', source_reference: 'x', exclusivity: 'unknown', status: 'draft', intake_case_id: 1, document_id: null});
  const conditionChanges = conditionChangeDetails({...draft, exclusivity: 'exclusive', status: 'confirmed'});
  assert.deepEqual(conditionChanges.map((change) => [change.label, change.before, change.after]), [['独占', '未確認', '独占'], ['状態', '条件未確定', '条件確認済み']]);
});
