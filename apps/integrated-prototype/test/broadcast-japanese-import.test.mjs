import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';

async function setup(t) {
  const db = await openTestDb({t});
  const app = createApp({db, mode: 'local'});
  await db.run("INSERT INTO partners(id,org_id,code,name,kind) VALUES(10,1,'PT-TV','架空テレビ','other')");
  await db.run("INSERT INTO partner_profile_versions(org_id,partner_id,version_no,roles_json,created_by) VALUES(1,10,1,'[\"broadcaster\",\"customer\"]',1)");
  const login = async (email) => (await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email})})).headers.get('set-cookie').split(';')[0];
  const admin = await login('admin@openingnight.invalid');
  const call = async (path, {method = 'GET', body} = {}) => {
    const r = await app.request(`/api/broadcast${path}`, {method, headers: {cookie: admin, ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    const type = r.headers.get('content-type') || '';
    return {status: r.status, headers: r.headers, data: type.includes('json') ? await r.json() : type.includes('spreadsheetml') ? new Uint8Array(await r.arrayBuffer()) : await r.text()};
  };
  return {db, call};
}

const sheetOf = (bytes, name) => decodeXlsx(bytes).find((sheet) => sheet.name === name);
const tableOf = (sheet) => ({headers: sheet.rows[0], rows: sheet.rows.slice(1).map((cells, index) => ({rowNo: index + 2, cells}))});

test('slot Excel uses Japanese headers with 参考_ columns and round-trips through a Japanese import', async (t) => {
  const {db, call} = await setup(t);
  try {
    const created = await call('/slots', {method: 'POST', body: {workId: 1, broadcastMonth: '2026-11', stationName: '架空テレビ', customerPartnerId: 10, periodFrom: '2026-11-01', periodTo: '2026-11-30', plannedRuns: 2, sourceReference: '架空編成表'}});
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const xlsx = await call('/export.xlsx?workId=1');
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const sheet = sheetOf(xlsx.data, '放送枠');
    const headers = sheet.rows[0];
    for (const header of ['放送枠ID', '版', '作品コード', '放送月', '放送局', '取引先コード', '期間開始', '期間終了', '予定回数', '根拠', '参考_取引先名', '参考_状態']) assert.ok(headers.includes(header), header);
    assert.ok(!headers.some((header) => /^[a-z_]+$/.test(String(header))), 'no English keys in the Excel headers');
    const row = sheet.rows[1];
    assert.equal(row[headers.indexOf('放送局')], '架空テレビ');
    assert.equal(row[headers.indexOf('取引先コード')], 'PT-TV', 'the partner is written as a code, not a numeric ID');
    assert.equal(row[headers.indexOf('参考_取引先名')], '架空テレビ');
    assert.equal(row[headers.indexOf('参考_放送局の登録')], '登録済みの放送局');
    assert.equal(row[headers.indexOf('期間開始')], '2026-11-01', 'dates come back as ISO dates from Excel');
    assert.ok(decodeXlsx(xlsx.data).some((item) => item.name === '記入ガイド'));

    // 参考_ の列を書き換えても読まない（変更なし）
    const edited = tableOf(sheet);
    edited.rows[0].cells[headers.indexOf('参考_取引先名')] = '書き換えた参考';
    const same = await call('/import/preview', {method: 'POST', body: {workId: 1, table: edited}});
    assert.equal(same.status, 200, JSON.stringify(same.data));
    assert.equal(same.data.counts.unchanged, 1, JSON.stringify(same.data.rows));
    assert.equal(same.data.headerMode, 'ja');
    assert.ok(same.data.ignoredColumns.includes('参考_取引先名'));

    // 日本語見出しで改訂と追加。全角数字・「2026/11」も吸収する
    const next = tableOf(sheet);
    next.rows[0].cells[headers.indexOf('予定回数')] = '３';
    const added = [...sheet.rows[1]];
    added[headers.indexOf('放送枠ID')] = '';
    added[headers.indexOf('版')] = '';
    added[headers.indexOf('放送月')] = '2026/12';
    added[headers.indexOf('期間開始')] = '2026/12/1';
    added[headers.indexOf('期間終了')] = '2026-12-20';
    added[headers.indexOf('放送局')] = '新しい架空局';
    next.rows.push({rowNo: 3, cells: added});
    const preview = await call('/import/preview', {method: 'POST', body: {workId: 1, table: next}});
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.counts.revise, 1);
    assert.equal(preview.data.counts.append, 1);
    const appended = preview.data.rows.find((item) => item.action === 'append');
    assert.equal(appended.broadcast_month, '2026-12');
    assert.equal(appended.period_from, '2026-12-01');
    assert.equal(appended.customer_partner_id, 10, 'the partner code is resolved to the partner');
    assert.ok(appended.warnings.some((text) => text.includes('未登録の局')), 'an unregistered station is reported, not refused');
    assert.equal((await call('/import/commit', {method: 'POST', body: {token: preview.data.token, confirmed: true}})).status, 201);
    assert.equal((await db.get('SELECT COUNT(*) n FROM broadcast_slots')).n, 2);
    assert.equal((await db.get('SELECT planned_runs FROM broadcast_slot_versions WHERE slot_id=? ORDER BY revision DESC LIMIT 1', [created.data.slotId])).planned_runs, 3);

    // 日本語見出しのCSVも出力できる
    const csv = await call('/export.csv?workId=1&headers=ja');
    assert.match(csv.data, /放送枠ID,版,作品コード,放送月,放送局/);
  } finally {
    await db.close();
  }
});

test('slot import checks every row and returns all errors with the failed rows', async (t) => {
  const {db, call} = await setup(t);
  try {
    const table = {
      headers: ['放送枠ID', '版', '作品コード', '放送月', '放送局', '取引先コード', '期間開始', '期間終了', '予定回数', '根拠', '参考_メモ'],
      rows: [
        ['', '', 'WRK-DEMO', '2026-11', '架空テレビ', '', '2026-11-01', '2026-11-30', '1', '架空編成表', '正しい行'],
        ['', '', 'WRK-DEMO', '2026-13', '', 'PT-NONE', '2026-11-01', '2026-10-31', '0', '', '4つの誤り'],
        ['', '', 'WRK-OTHER', '2026-11', '架空テレビ', '', '2026-11-05', '2026-12-01', '1', '', '別作品と期間外'],
        ['99', '1', 'WRK-DEMO', '2026-11', '架空テレビ', '', '2026-11-01', '2026-11-30', '1', '', '無い放送枠ID'],
      ],
    };
    const r = await call('/import/preview', {method: 'POST', body: {workId: 1, table}});
    assert.equal(r.status, 400);
    assert.equal(r.data.ok, false);
    assert.equal(r.data.counts.errors, 3, 'three rows fail; the checking does not stop at the first');
    assert.equal(r.data.counts.total, 4);
    const rowsWithErrors = [...new Set(r.data.details.map((detail) => detail.row))];
    assert.deepEqual(rowsWithErrors, [3, 4, 5]);
    const row3 = r.data.details.filter((detail) => detail.row === 3).map((detail) => detail.column);
    for (const column of ['放送月', '放送局', '取引先コード', '期間終了', '予定回数']) assert.ok(row3.includes(column), `row 3 reports ${column}`);
    assert.ok(r.data.details.some((detail) => detail.row === 4 && detail.column === '作品コード'));
    assert.ok(r.data.details.some((detail) => detail.row === 5 && detail.column === '放送枠ID'));
    assert.deepEqual(r.data.headers, table.headers);
    assert.equal(r.data.failedRows.length, 3);
    assert.equal(r.data.failedRows[0].cells[10], '4つの誤り', 'the failed row keeps its original cells');
    assert.ok(r.data.failedRows[0].errors.some((text) => text.startsWith('放送月:')));
    assert.equal((await db.get('SELECT COUNT(*) n FROM broadcast_slots')).n, 0, 'nothing is registered while any row has an error');

    const missing = await call('/import/preview', {method: 'POST', body: {workId: 1, table: {headers: ['作品コード', '放送局'], rows: [['WRK-DEMO', '架空テレビ']]}}});
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /見出しが足りません: 放送月/);
  } finally {
    await db.close();
  }
});

test('availability Excel uses Japanese headers and labels, keeps procurement links, and reports all row errors', async (t) => {
  const {db, call} = await setup(t);
  try {
    await db.run("INSERT INTO rights_intake_cases(id,org_id,project_id,work_id,case_code,title,intake_type,created_by) VALUES(1,1,1,1,'CASE-DEMO','架空調達','sole_owned',1)");
    await db.run("INSERT INTO rights_intake_documents(id,org_id,intake_case_id,title,reference,version_label) VALUES(1,1,1,'架空契約書','架空参照','v1')");
    await db.run("INSERT INTO sales_availability_versions(org_id,work_id,distribution_code,territory,version_no,release_on,sales_end_on,terms_text,source_reference,intake_case_id,document_id,exclusivity,status,created_by) VALUES(1,1,'B001','日本',1,'2026-10-01','2027-09-30','架空放送条件（地上波）','架空契約書',1,1,'nonexclusive','confirmed',1)");
    const xlsx = await call('/avails/export.xlsx');
    assert.equal(xlsx.status, 200);
    const sheet = sheetOf(xlsx.data, '販売条件');
    const headers = sheet.rows[0];
    const row = sheet.rows[1];
    assert.equal(row[headers.indexOf('流通コード')], 'B001');
    assert.equal(row[headers.indexOf('作品コード')], 'WRK-DEMO');
    assert.equal(row[headers.indexOf('独占')], '非独占', 'choices are written in Japanese');
    assert.equal(row[headers.indexOf('状態')], '条件確認済み');
    assert.equal(row[headers.indexOf('参考_分類')], '放送');
    assert.match(String(row[headers.indexOf('参考_調達の根拠')]), /CASE-DEMO/);

    const unchanged = await call('/avails/preview', {method: 'POST', body: {table: tableOf(sheet)}});
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.data));
    assert.equal(unchanged.data.counts.unchanged, 1, 'full-width text such as （） is not rewritten');

    const changed = tableOf(sheet);
    changed.rows[0].cells[headers.indexOf('販売条件')] = '改訂した架空条件';
    changed.rows[0].cells[headers.indexOf('独占')] = '独占';
    const preview = await call('/avails/preview', {method: 'POST', body: {table: changed}});
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.counts.revise, 1);
    assert.deepEqual(preview.data.rows[0].diff.sort(), ['exclusivity', 'terms_text']);
    assert.equal((await call('/avails/commit', {method: 'POST', body: {token: preview.data.token, confirmed: true}})).status, 201);
    const latest = await db.get('SELECT * FROM sales_availability_versions WHERE work_id=1 ORDER BY version_no DESC LIMIT 1');
    assert.equal(latest.version_no, 2);
    assert.equal(latest.exclusivity, 'exclusive');
    assert.equal(latest.intake_case_id, 1, 'the procurement case is carried to the new version');
    assert.equal(latest.document_id, 1, 'the procurement document is carried to the new version');

    const bad = {
      headers: ['作品コード', '流通コード', '地域', '元の版', '解禁日', '販売終了日', '独占', '状態', '販売条件', '根拠'],
      rows: [
        ['WRK-DEMO', 'broadcast_free', '日本', '', '', '', '', '', '', '架空メモ'],
        ['WRK-DEMO', 'B002', '国内', '', '2027-01-01', '2026-12-31', 'たぶん独占', '条件確認済み', '', ''],
        ['WRK-NONE', 'ZZZ', '', '', '', '', '', '', '', '架空'],
      ],
    };
    const failed = await call('/avails/preview', {method: 'POST', body: {table: bad}});
    assert.equal(failed.status, 400);
    assert.equal(failed.data.counts.errors, 3);
    const messages = failed.data.details.map((detail) => `${detail.row}:${detail.column}`);
    for (const expected of ['2:流通コード', '3:販売終了日', '3:独占', '3:状態', '3:根拠', '4:作品コード', '4:流通コード', '4:地域']) assert.ok(messages.includes(expected), expected);
    assert.ok(failed.data.details.some((detail) => detail.row === 2 && /旧区分/.test(detail.message)), 'a legacy distribution code cannot start a new series');

    // 地域の表記ゆれは登録済みの系列に寄せる（「国内」で別の系列を作らない）
    const aliasNew = await call('/avails/preview', {method: 'POST', body: {table: {headers: ['作品コード', '流通コード', '地域', '根拠'], rows: [['WRK-DEMO', 'B001', '国内', '架空メモ']]}}});
    assert.equal(aliasNew.status, 400, JSON.stringify(aliasNew.data));
    assert.ok(aliasNew.data.details.some((detail) => detail.column === '地域' && detail.message.includes('「日本」')), JSON.stringify(aliasNew.data.details));
    const aliasRevise = await call('/avails/preview', {method: 'POST', body: {table: {headers: ['作品コード', '流通コード', '地域', '元の版', '根拠'], rows: [['WRK-DEMO', 'B001', '国内', '2', '架空メモ']]}}});
    assert.equal(aliasRevise.status, 200, JSON.stringify(aliasRevise.data));
    assert.equal(aliasRevise.data.rows[0].territory, '日本', 'the row joins the existing 日本 series');
    assert.equal(aliasRevise.data.rows[0].action, 'revise');
    assert.ok(aliasRevise.data.rows[0].warnings.some((text) => text.includes('「日本」')));
    assert.equal(aliasRevise.data.rows[0].status, 'draft', 'a blank status is 条件未確定');
    assert.equal(aliasRevise.data.rows[0].exclusivity, 'unknown', 'a blank exclusivity is 未確認');
    const spelled = await call('/avails/preview', {method: 'POST', body: {table: {headers: ['作品コード', '流通コード', '地域', '根拠'], rows: [['WRK-DEMO', 'B002', 'Japan', '架空メモ']]}}});
    assert.equal(spelled.status, 200, JSON.stringify(spelled.data));
    assert.equal(spelled.data.rows[0].territory, '日本', 'a new series is stored with the standard spelling');
    assert.equal(spelled.data.rows[0].action, 'append');
  } finally {
    await db.close();
  }
});

test('versioning a condition from the broadcast API keeps the procurement links of the previous version', async (t) => {
  const {db, call} = await setup(t);
  try {
    await db.run("INSERT INTO rights_intake_cases(id,org_id,project_id,work_id,case_code,title,intake_type,created_by) VALUES(1,1,1,1,'CASE-DEMO','架空調達','sole_owned',1)");
    await db.run("INSERT INTO rights_intake_documents(id,org_id,intake_case_id,title,reference,version_label) VALUES(1,1,1,'架空契約書','架空参照','v1')");
    await db.run("INSERT INTO sales_availability_versions(org_id,work_id,distribution_code,territory,version_no,terms_text,source_reference,intake_case_id,document_id,exclusivity,status,created_by) VALUES(1,1,'B001','日本',1,'','架空契約書',1,1,'unknown','draft',1)");
    const r = await call('/conditions', {method: 'POST', body: {workId: 1, distributionCode: 'B001', territory: '日本', baseVersion: 1, status: 'draft', exclusivity: 'exclusive', terms: '架空', sourceReference: '架空契約書'}});
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const latest = await db.get('SELECT intake_case_id, document_id FROM sales_availability_versions WHERE version_no=2');
    assert.deepEqual({...latest}, {intake_case_id: 1, document_id: 1});
  } finally {
    await db.close();
  }
});
