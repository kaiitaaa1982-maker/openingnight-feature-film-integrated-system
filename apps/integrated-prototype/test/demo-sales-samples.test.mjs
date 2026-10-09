// 架空データ（デモ）DEMO-SALES 用のサンプル Excel 2点（配信・ビデオグラム）の試験。
// ・配布するブックは fixtures/xlsx-source/demo-sales-*/ の部品から組み立てたもので、代表に渡したブックと部品が同じ（数値・行・列・シート）
// ・manifest の期待値を、ブックの Details の行から計算し直して照合する（総額×手数料・出荷−返品×単価）
// ・seed-sales-demo で作った DEMO-SALES に、画面と同じ API の順（原本の受取 → 見出し行4 → 商品コードの列で分割（要修正の行は理由を書いて除く）
//   → 作品ごとに登録）で入れ、登録した売上が期待値（行・作品・作品ごとの額・数量）と一致すること。表の読み取りは手元の Python（ON_PYTHON）の実物
// ・D1 の上限（1文の値100個・1回の batch 480文）に掛からないこと
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {unzipSync} from 'fflate';
import {openTestDb} from './test-db.mjs';
import {createApp} from '../src/app.mjs';
import {extractDocument} from '../src/local-extractor.mjs';
import {decodeXlsx} from '../src/xlsx.mjs';
import {buildDefinition, defaultFields, guessPeriod} from '../src/import/wizard-model.mjs';
import {parseCsvCells} from '../src/import/source-partition.mjs';
import {seedSalesDemo, SALES_DEMO} from '../scripts/seed-sales-demo.mjs';

const python = process.env.ON_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const publicDir = new URL('../public/demo-fixtures/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('fixture-manifest.json', publicDir), 'utf8'));
const entry = (id) => manifest.fixtures.find((row) => row.id === id);
const STREAMING = entry('demo-sales-streaming'), VIDEOGRAM = entry('demo-sales-videogram');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------- ブックの行から独立に出す値 ----------
async function detailsOf(fixture) {
  const bytes = await readFile(new URL(fixture.files.xlsx, publicDir));
  const sheets = decodeXlsx(bytes, {formulas: 'sheet'});
  const details = sheets.find((sheet) => sheet.name === fixture.sheet);
  const header = details.rows[fixture.headerRow - 1];
  const rows = details.rows.slice(fixture.headerRow).map((cells, index) => ({sourceRow: fixture.headerRow + 1 + index, cells}));
  return {bytes, sheets, header, rows};
}
const num = (value) => Number(value);
function streamingFacts(rows) {
  // 総額＝件数×単価、正味＝総額−PF手数料（報告の手数料）。報告の正味売上と合う行が正常
  return rows.map(({sourceRow, cells}) => {
    const gross = num(cells[4]) * num(cells[5]), net = gross - num(cells[7]);
    return {sourceRow, work: cells[0], sku: cells[1] ?? '', gross, fee: num(cells[7]), net, reported: num(cells[8]), ok: Boolean(cells[1]) && net === num(cells[8])};
  });
}
function videogramFacts(rows) {
  // 正味数量＝出荷−返品、正味額＝正味数量×精算単価。返品が出荷を超える行・正味額が合わない行は要修正
  return rows.map(({sourceRow, cells}) => {
    const units = num(cells[4]) - num(cells[5]), net = units * num(cells[7]);
    return {sourceRow, work: cells[0], sku: cells[1] ?? '', units, net, reported: num(cells[8]), ok: units >= 0 && units === num(cells[6]) && net === num(cells[8])};
  });
}
const byWork = (facts, key) => facts.reduce((map, row) => map.set(row.work, (map.get(row.work) || 0) + row[key]), new Map());

test('DEMO-SALES 用サンプル2点: 配布するブックは渡したブックと同じ部品で、manifest の期待値が Details の行から計算し直した値と一致する', async () => {
  for (const fixture of [STREAMING, VIDEOGRAM]) {
    const {bytes, sheets, header, rows} = await detailsOf(fixture);
    assert.deepEqual(sheets.map((sheet) => sheet.name), ['Details', '検証期待値'], fixture.id);
    // 部品は fixtures/xlsx-source の parts.json と同じ（作り直していない）
    const parts = JSON.parse(await readFile(new URL(`../fixtures/xlsx-source/${fixture.id}/parts.json`, import.meta.url), 'utf8'));
    const unzipped = unzipSync(new Uint8Array(bytes));
    assert.deepEqual(Object.keys(unzipped).sort(), Object.keys(parts).sort(), fixture.id);
    for (const [name, hash] of Object.entries(parts)) assert.equal(sha(unzipped[name]), hash, `${fixture.id}/${name}`);
    assert.equal(header.length, 10);
    assert.ok(header.includes(fixture.binding.productColumn), `見出しに ${fixture.binding.productColumn}`);
    assert.equal(rows.length, fixture.validRows + 1, '正常の行と要修正の行1行');
    assert.equal(rows.at(-1).sourceRow, fixture.badSourceRow);
    assert.match(String(rows.at(-1).cells[9]), /要修正/);
    assert.ok(rows.slice(0, -1).every((row) => row.cells[9] === '正常'));
  }
  const s = streamingFacts((await detailsOf(STREAMING)).rows);
  const valid = s.filter((row) => row.ok);
  assert.deepEqual(s.filter((row) => !row.ok).map((row) => [row.sourceRow, row.sku]), [[14, '']], '14行目は商品コード欠落');
  assert.equal(valid.length, STREAMING.validRows);
  assert.equal(new Set(valid.map((row) => row.work)).size, STREAMING.works);
  assert.equal(valid.reduce((n, row) => n + row.gross, 0), STREAMING.expected.gross);
  assert.equal(valid.reduce((n, row) => n + row.fee, 0), STREAMING.expected.fee);
  assert.equal(valid.reduce((n, row) => n + row.net, 0), STREAMING.expected.net);
  assert.equal(STREAMING.expected.net, 2287040);
  assert.deepEqual(Object.fromEntries(byWork(valid, 'net')), STREAMING.expected.netByWork);

  const v = videogramFacts((await detailsOf(VIDEOGRAM)).rows);
  const good = v.filter((row) => row.ok);
  const bad = v.filter((row) => !row.ok);
  assert.deepEqual(bad.map((row) => row.sourceRow), [12]);
  assert.ok(bad[0].units < 0, '12行目は返品超過');
  assert.equal(good.length, VIDEOGRAM.validRows);
  assert.equal(new Set(good.map((row) => row.work)).size, VIDEOGRAM.works);
  assert.equal(good.reduce((n, row) => n + row.units, 0), VIDEOGRAM.expected.netUnits);
  assert.equal(good.reduce((n, row) => n + row.net, 0), VIDEOGRAM.expected.net);
  assert.deepEqual([VIDEOGRAM.expected.netUnits, VIDEOGRAM.expected.net], [1449, 640580]);
  assert.deepEqual(Object.fromEntries(byWork(good, 'net')), VIDEOGRAM.expected.netByWork);
});

// ---------- 取込（画面と同じ API の順） ----------
function limitChecking(inner) {
  const seen = {maxParams: 0, maxBatch: 0};
  const check = (params = []) => {
    seen.maxParams = Math.max(seen.maxParams, params.length);
    if (params.length > 100) throw new Error(`D1 の上限（100値）を超えました: ${params.length}`);
  };
  return Object.assign(Object.create(inner), {
    seen,
    all: (sql, params = []) => { check(params); return inner.all(sql, params); },
    get: (sql, params = []) => { check(params); return inner.get(sql, params); },
    run: (sql, params = []) => { check(params); return inner.run(sql, params); },
    batch: (statements) => {
      seen.maxBatch = Math.max(seen.maxBatch, statements.length);
      if (statements.length > 480) throw new Error(`D1 の上限（480文）を超えました: ${statements.length}`);
      statements.forEach((statement) => check(statement.params));
      return inner.batch(statements);
    },
  });
}

let db, wrapped, app, cookie, org;
before(async (t) => {
  db = await openTestDb({t});
  await seedSalesDemo(db);
  wrapped = limitChecking(db);
  app = createApp({db: wrapped, mode: 'local', extractDocument: (args) => extractDocument({...args, pythonPath: python})});
  const login = await app.request('/api/local/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: SALES_DEMO.adminEmail})});
  cookie = login.headers.get('set-cookie').split(';')[0];
  org = await db.get('SELECT id FROM organizations WHERE code=?', [SALES_DEMO.orgCode]);
});
after(() => db?.close());

async function call(path, body) {
  const response = await app.request(`/api${path}`, {method: body ? 'POST' : 'GET', headers: {cookie, 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  return {status: response.status, data: await response.json()};
}
const must = (res, status, label) => {
  assert.equal(res.status, status, `${label}: ${JSON.stringify(res.data).slice(0, 600)}`);
  return res.data;
};

async function importSample(fixture) {
  const partner = await db.get('SELECT id, name FROM partners WHERE org_id=? AND code=?', [org.id, fixture.partner.code]);
  assert.ok(partner, `取引先 ${fixture.partner.code} が DEMO-SALES にある`);
  assert.equal(partner.name, fixture.partner.name);
  const base64 = (await readFile(new URL(fixture.files.xlsx, publicDir))).toString('base64');
  // 1. 原本の受取
  const fileId = must(await call('/sales-import/files', {name: fixture.files.xlsx, base64, binding: null}), 201, '原本の受取').fileId;
  // 2. 見出し行4（まず除外なし。列対応の候補を作る）
  const first = must(await call(`/sales-import/files/${fileId}/selection`, {sheetName: fixture.sheet, headerRow: fixture.headerRow, excludedRows: []}), 201, '見出し行');
  const cells = parseCsvCells(first.canonicalCsv);
  const headers = first.headers || cells[0];
  const sample = cells.slice(1, 2);
  const {fields} = defaultFields({headers, sampleRows: sample, productIds: [], period: guessPeriod(headers, sample), resolvedProduct: true});
  const reportKey = `${fixture.partner.code}-${fixture.period}-TEST`;
  const literal = (value) => ({mode: 'literal', value, source: '', operands: ['', '']});
  Object.assign(fields, {report_key: literal(reportKey), recognition_basis_id: literal('2'), basis_date: literal('2026-08-15'), basis_reason: literal('月次報告を受け取った月で計上（架空のサンプル）'),
    tax_amount: {mode: 'zero', value: '', source: '', operands: ['', '']}, amount_inc_tax: {mode: 'same_ex', value: '', source: '', operands: ['', '']}});
  const built = buildDefinition(fields, {headers, partnerId: partner.id, autoKey: reportKey, resolvedProduct: true});
  assert.deepEqual(built.errors, []);
  assert.equal(built.definition.mappings.find((rule) => rule.target === 'amount_ex_tax')?.source, fixture.amountColumn, '税抜の額は正味の列');
  let profile = must(await call(`/sales-import/context?partnerId=${partner.id}&kind=${fixture.kind}`), 200, '取込の文脈').profile;
  if (!profile) profile = {id: must(await call('/mapping-profiles', {partnerId: partner.id, kind: fixture.kind, name: `${partner.name}｜${fixture.kind}`}), 201, '列対応').profileId};
  const versionId = must(await call(`/mapping-profiles/${profile.id}/versions`, built.definition), 201, '列対応の版').mappingVersionId;
  // 3. 商品コードの列で分ける（試し）。要修正の行を除く前の照合の結果
  const dry = must(await call(`/sales-import/files/${fileId}/partitions`, {dryRun: true, binding: {mode: fixture.binding.mode, productColumn: fixture.binding.productColumn}, kind: fixture.kind, mappingVersionId: versionId}), 200, '試しの分割');
  // 要修正の行を理由つきで除いて選び直し、割り当てを決めて分割を保存する
  must(await call(`/sales-import/files/${fileId}/selection`, {sheetName: fixture.sheet, headerRow: fixture.headerRow, excludedRows: [{sourceRow: fixture.badSourceRow, reason: `サンプルの要修正行（${fixture.badReason}）。取引先に確認中`}]}), 201, '除外して選び直し');
  must(await call(`/sales-import/files/${fileId}/bindings`, {mode: fixture.binding.mode, productColumn: fixture.binding.productColumn}), 201, '割り当て');
  const split = must(await call(`/sales-import/files/${fileId}/partitions`, {kind: fixture.kind, mappingVersionId: versionId}), 200, '分割');
  assert.equal(split.saved, true, JSON.stringify(split).slice(0, 400));
  // 4. 作品ごとに登録
  for (const partition of split.partitions) {
    const preview = must(await call('/mapped-imports/preview', {workId: partition.workId, mappingVersionId: versionId, text: partition.csv, sourcePartitionId: partition.id}), 200, 'プレビュー');
    assert.equal(preview.ok, true, JSON.stringify(preview.errors).slice(0, 400));
    must(await call('/sales-import/commit', {token: preview.token}), 200, '登録');
  }
  const lines = await db.all(`SELECT w.code, SUM(s.amount_ex_tax) amount, SUM(s.quantity) qty, COUNT(*) n FROM sale_lines s
      JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id JOIN works w ON w.org_id=s.org_id AND w.id=s.work_id
    WHERE s.org_id=? AND r.report_key=? AND r.status='active' GROUP BY w.code ORDER BY w.code`, [org.id, reportKey]);
  const partners = await db.all(`SELECT DISTINCT s.partner_id FROM sale_lines s JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id WHERE s.org_id=? AND r.report_key=?`, [org.id, reportKey]);
  const selection = await db.get('SELECT excluded_json FROM sales_source_selections WHERE org_id=? AND file_id=? ORDER BY version_no DESC LIMIT 1', [org.id, fileId]);
  return {fileId, dry, split, lines, partners, selection, reportKey};
}

test('FR-REV-INTAKE-020 DEMO-SALES に配信のサンプルを画面と同じ順で取り込むと、正常9行・6作品・正味2,287,040円が作品ごとに登録される', async () => {
  const result = await importSample(STREAMING);
  // 除く前の照合では、14行目が「商品コードが空欄」で分けられない
  assert.ok(result.dry.unmatched.some((row) => row.sourceRow === 14), JSON.stringify(result.dry.unmatched));
  assert.equal(result.split.partitions.length, STREAMING.works);
  const expected = byWork(streamingFacts((await detailsOf(STREAMING)).rows).filter((row) => row.ok), 'net');
  assert.deepEqual(result.lines.map((row) => [row.code, Number(row.amount)]), [...expected].sort());
  assert.equal(result.lines.reduce((n, row) => n + Number(row.n), 0), STREAMING.validRows);
  assert.equal(result.lines.reduce((n, row) => n + Number(row.amount), 0), STREAMING.expected.net);
  assert.equal(result.partners.length, 1, '取引先は1つ（架空配信B）');
  assert.match(result.selection.excluded_json, /14/, '除いた行と理由が選択の版に残る');
  assert.match(result.selection.excluded_json, /商品コード欠落/);
  assert.ok(wrapped.seen.maxParams <= 100 && wrapped.seen.maxBatch <= 480, JSON.stringify(wrapped.seen));
});

test('FR-REV-INTAKE-020 DEMO-SALES にビデオグラムのサンプルを取り込むと、正常7行・5作品・正味数量1,449・正味額640,580円が登録される', async () => {
  const result = await importSample(VIDEOGRAM);
  assert.equal(result.split.partitions.length, VIDEOGRAM.works);
  const facts = videogramFacts((await detailsOf(VIDEOGRAM)).rows).filter((row) => row.ok);
  assert.deepEqual(result.lines.map((row) => [row.code, Number(row.amount)]), [...byWork(facts, 'net')].sort());
  assert.deepEqual(result.lines.map((row) => [row.code, Number(row.qty)]), [...byWork(facts, 'units')].sort(), '数量は正味数量');
  assert.equal(result.lines.reduce((n, row) => n + Number(row.n), 0), VIDEOGRAM.validRows);
  assert.equal(result.lines.reduce((n, row) => n + Number(row.qty), 0), VIDEOGRAM.expected.netUnits);
  assert.equal(result.lines.reduce((n, row) => n + Number(row.amount), 0), VIDEOGRAM.expected.net);
  assert.ok(wrapped.seen.maxParams <= 100 && wrapped.seen.maxBatch <= 480, JSON.stringify(wrapped.seen));
});
