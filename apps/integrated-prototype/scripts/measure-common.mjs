// 取込から予実までの時間の計測の共通の部品。手元の計測（scripts/measure-d1-baseline.mjs。段0の香盤表 #5）と、
// 動いているアプリへ HTTP で向ける計測（scripts/measure-staging.mjs。段2の実測 S5）が同じ部品を使い、区切り①〜⑦の意味と
// API の順（画面と同じ）を変えない。
//   ① 報告のファイルを受け取った（アップロードの要求を出した時刻）
//   ② 取り出しが終わった（受け取りの応答。抽出と原本の保存が済み、画面に表を出せる時刻）
//   ③ 登録の要求を受けた（最初の作品の登録の要求を出した時刻）。②〜③は見出し・分割・作品ごとの確認と重なりの確認の API だけで、人の確認は0
//   ④ 記録が終わった（最後の作品の登録の応答）
//   ⑤ ロイヤリティの下書きが画面に出た（GET /api/royalty/periods の応答。速報はまだ無い（FR-REV-INTAKE-036）ので参考値）
//   ⑥ 売上管理の書類がそろった（会社売上管理表・報告受領台帳・請求書の下書き・入金予定（売掛）の API がすべて応答した。
//      会社売上管理表と報告受領台帳はまだ無いので、年間売上と原本の詳細で代える。請求書の下書きは作品ごとの請求の候補）
//   ⑦ 予実の画面に登録が反映された（GET /api/progress/matrix の応答）。売上の予実（FCST）は未実装なので、
//      帳票センターの月次の受領進捗（src/progress）で代える。FCST の画面ができたらその API に差し替えて測り直す
// 予実は④の直後にも読み、登録の応答の時点で反映されているか（即時の判定。はい・いいえ）を残す。⑤〜⑦の時刻はこの読み取りを含む。
// 書類と予実が新しい登録を載せているか（反映）は、計測の後に API で読み直して判定する（照らし合わせは計測の時間に入れない）。
// DB を直接読まない（remote の D1・PostgreSQL でも同じ物差しで取れるようにする）。node:sqlite とアプリ本体を読み込まない。
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {strFromU8, strToU8, unzipSync, zipSync} from 'fflate';
import {decodeXlsx, encodeXlsx} from '../src/xlsx.mjs';
import {buildDefinition, defaultFields, guessPeriod} from '../src/import/wizard-model.mjs';
import {buildFixtureXlsx} from './fixture-xlsx.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = resolve(appRoot, 'public/demo-fixtures');

// 架空データの組織（scripts/seed-sales-demo.mjs の SALES_DEMO.orgCode と同じ。test/measure-staging.test.mjs が照合する）
export const DEMO_ORG_CODE = 'DEMO-SALES';

export const MILESTONES = Object.freeze([
  {key: 'm1', no: '①', label: '報告のファイルを受け取った（アップロードの要求）'},
  {key: 'm2', no: '②', label: '取り出しが終わった（受け取りの応答）'},
  {key: 'm3', no: '③', label: '登録の要求を受けた（最初の作品の登録の要求）'},
  {key: 'm4', no: '④', label: '記録が終わった（最後の作品の登録の応答）'},
  {key: 'm5', no: '⑤', label: 'ロイヤリティの下書きが画面に出た（参考値）'},
  {key: 'm6', no: '⑥', label: '売上管理の書類がそろった'},
  {key: 'm7', no: '⑦', label: '予実の画面に登録が反映された'},
]);
export const SEGMENTS = Object.freeze([
  {from: 'm1', to: 'm2', label: '受け取り（抽出・原本の保存）'},
  {from: 'm2', to: 'm3', label: '確認の段の API（見出し・分割・作品ごとの確認と重なりの確認。人の確認は0）'},
  {from: 'm3', to: 'm4', label: '登録（作品ごとの登録の要求と応答）'},
  {from: 'm4', to: 'm5', label: 'ロイヤリティの下書き（予実の即時の読み取りを含む）'},
  {from: 'm5', to: 'm6', label: '売上管理の書類'},
  {from: 'm6', to: 'm7', label: '予実の画面'},
]);
export const REFLECTED_LABELS = Object.freeze({
  royaltyDraft: 'ロイヤリティの下書き', companySales: '会社売上管理表（年間売上）', receiptLedger: '報告受領台帳（原本の詳細）',
  invoiceDraft: '請求書の下書き（請求の候補）', receivableBalance: '入金予定（売掛残高推移）', forecast: '予実（⑦）',
});

const pad = (n) => String(n).padStart(2, '0');
export function addMonths(ym, n) {
  const index = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
export const lastDayOf = (ym) => `${ym}-${pad(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate())}`;
export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 原本の zip を、部品の並びと圧縮（fflate の level 6）を変えず、時刻を固定して作り直す（scripts/fixture-xlsx.mjs と同じ道具）。
// 同じ中身なら同じバイトになり、再開のときに同じ原本（生バイトの SHA-256）として見つけられる
const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');
function rezip(files) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, {mtime: FIXED_MTIME}]])), {level: 6}));
}
const charRefs = (text) => [...text].map((ch) => `&#${ch.codePointAt(0)};`).join('');
const DETAILS_PART = 'xl/worksheets/sheet1.xml';

// 架空の原本 (a) の対象月を書き換える。OOXML の部品の文字列だけを置き換える（対象月の列の「2026/07」と3行目の「対象期間: 2026-07」）。
// 読み取り→書き出しで作り直すと、検証期待値のシート・書式・数式が落ちるため。想定の文字列が見つからなければ止める（原本が変わった）
export function retargetFixtureMonth(bytes, fromMonth, toMonth) {
  if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth)) throw new Error('対象月は「2026-07」の形です');
  const files = unzipSync(bytes);
  if (!files[DETAILS_PART]) throw new Error(`原本に ${DETAILS_PART} がありません`);
  const xml = strFromU8(files[DETAILS_PART]);
  const cellFrom = `<t>${fromMonth.replace('-', '/')}</t>`;
  const periodFrom = `${charRefs('対象期間')}: ${fromMonth} `;
  const cells = xml.split(cellFrom).length - 1;
  const periods = xml.split(periodFrom).length - 1;
  if (cells < 1 || periods !== 1) throw new Error(`原本の対象月を書き換えられません（対象月の列 ${cells}・対象期間 ${periods}）。fixtures/xlsx-source/demo-sales-streaming が変わっていないか確かめてください`);
  files[DETAILS_PART] = strToU8(xml.replaceAll(cellFrom, `<t>${toMonth.replace('-', '/')}</t>`).replaceAll(periodFrom, `${charRefs('対象期間')}: ${toMonth} `));
  return rezip(files);
}

// 架空の原本 (a) の定義。fixture-manifest.json の demo-sales-streaming（取引先・報告の種類・見出しの行・商品コードの列・対象月）。
// 原本のバイトは git で追跡する部品（fixtures/xlsx-source/demo-sales-streaming/）から手元で組み立てる（scripts/fixture-xlsx.mjs。
// public/demo-fixtures の XLSX と同じバイト）。その XLSX は git に入らず npm test の前処理が作るので、core の main のフォルダには無い。
// 代表は main のフォルダから ps1 を流すので、生成物を読まず、書き出しもしない。manifestDir は試験用（fixture-manifest.json だけを置いたフォルダ）。
// month を渡すと、その対象月に書き換えた原本を返す（行数・作品・金額は変えない）
export function streamingFixture({month = null, manifestDir = publicDir} = {}) {
  const manifest = JSON.parse(readFileSync(join(manifestDir, 'fixture-manifest.json'), 'utf8'));
  const entry = manifest.fixtures.find((row) => row.id === 'demo-sales-streaming');
  if (!entry) throw new Error('fixture-manifest.json に demo-sales-streaming がありません');
  // scripts/prepare-test-assets.mjs は <slug>-sample.xlsx の名前で書き出す。名前が合わなければ、組み立てる部品が違う
  if (entry.files.xlsx !== `${entry.id}-sample.xlsx`) throw new Error(`fixture-manifest.json の ${entry.id} の XLSX の名前が部品のフォルダと合いません`);
  const base = {label: `架空の原本 ${entry.files.xlsx}`, fileName: entry.files.xlsx, bytes: Buffer.from(buildFixtureXlsx(entry.id)), sheet: entry.sheet, headerRow: entry.headerRow,
    partnerCode: entry.partner.code, kind: entry.kind, productColumn: entry.binding.productColumn, month: entry.period};
  if (!month || month === entry.period) return base;
  return {...base, label: `架空の原本 ${entry.files.xlsx}（対象月を ${month} に書き換え）`, fileName: entry.files.xlsx.replace(/\.xlsx$/, `-${month}.xlsx`),
    bytes: retargetFixtureMonth(base.bytes, entry.period, month), month};
}

const PARTNER_LABELS = Object.freeze({'DEMO-PF-B': '架空配信B・都度課金（架空）', 'DEMO-PF-C': '架空配信C・広告型（架空）'});

// 合成の1通 (b)。見出しと列は (a) と同じ形（配信の都度課金・正味＝総額−PF手数料）。作品は DEMO-SALES の DEMO-W01〜（配信の商品 DEMO-Wnn-DIG）。
// 取引先は登録のときに選ぶ（partnerCode）。zip の時刻を固定するので、同じ引数なら同じバイトになる
export function buildSyntheticWorkbook({rows = 2000, works = 20, month = '2026-07', partnerCode = 'DEMO-PF-B'} = {}) {
  if (!Number.isInteger(works) || works < 1 || works > 20) throw new Error('作品の数は1〜20です（DEMO-SALES の作品は20本）');
  if (!Number.isInteger(rows) || rows < works) throw new Error('行数は作品の数以上にしてください');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('対象月は「2026-07」の形です');
  const headers = ['作品CD', '商品ｺｰﾄﾞ', '配信区分', '対象月', '視聴/契約数', '単価(税抜)', '総額', 'PF手数料', '正味売上', '備考'];
  const partnerLabel = PARTNER_LABELS[partnerCode] || `${partnerCode}（架空）`;
  const sheetRows = [['配信プラットフォーム風 売上報告（合成・計測用・架空）'], ['非公式・架空データ・実在企業発行書式ではありません。性能の計測専用。'],
    [`対象期間: ${month} / 取引先: ${partnerLabel}/ ${works}作品 / ${rows}行`], headers];
  const per = Math.floor(rows / works);
  for (let w = 1; w <= works; w += 1) {
    const code = `DEMO-W${String(w).padStart(2, '0')}`;
    const count = per + (w <= rows % works ? 1 : 0);
    for (let k = 0; k < count; k += 1) {
      const est = k % 2 === 1;
      const quantity = 10 + ((w * 37 + k * 13) % 900);
      const price = est ? [2000, 2500][k % 4 === 1 ? 0 : 1] : [400, 440, 500][k % 3];
      const gross = quantity * price;
      const fee = gross * 3 / 10;
      sheetRows.push([code, `${code}-DIG`, est ? 'EST' : 'TVOD', month.replace('-', '/'), quantity, price, gross, fee, gross - fee, '正常']);
    }
  }
  return {label: `合成の1通（${works}作品×約${per}行）`, fileName: `synthetic-streaming-${rows}rows-${partnerCode}-${month}.xlsx`,
    bytes: rezip(unzipSync(encodeXlsx([{name: 'Details', rows: sheetRows}]))),
    sheet: 'Details', headerRow: 4, partnerCode, kind: 'digital', productColumn: '商品ｺｰﾄﾞ', month};
}

// 原本の作品コード（見出しの「作品CD」の列）。重なりの確認に使う
export function workbookWorkCodes(workbook) {
  const sheet = decodeXlsx(workbook.bytes, {formulas: 'sheet'}).find((row) => row.name === workbook.sheet);
  const headers = (sheet?.rows[workbook.headerRow - 1] || []).map((cell) => String(cell ?? ''));
  const column = headers.indexOf('作品CD');
  if (column < 0) throw new Error(`${workbook.fileName} に「作品CD」の列がありません`);
  return [...new Set(sheet.rows.slice(workbook.headerRow).map((row) => String(row[column] ?? '').trim()).filter(Boolean))];
}

// okFalse: 試しの分割は、照合できない行があると ok:false で返す（その行を除いてから分割を保存する）。
// redact: 誤りの文から伏せる値を消す（remote の計測。トークン・メールを例外の文に出さない）
export function must(result, status, label, {okFalse = false, redact = (text) => text} = {}) {
  if (result.status !== status || (!okFalse && result.data?.ok === false)) {
    throw new Error(redact(`${label}: ${result.status} ${JSON.stringify(result.data ?? null).slice(0, 600)}`));
  }
  return result.data;
}

const literal = (value) => ({mode: 'literal', value, source: '', operands: ['', '']});

// 取引先のいつもの形式の列対応（初めての形式の対応づけは計測に入れない。裁定4）を、原本の見出しから先に作る
export async function prepareMapping(call, workbook, partner, reportKey, basisDate, {redact} = {}) {
  const sheet = decodeXlsx(workbook.bytes, {formulas: 'sheet'}).find((row) => row.name === workbook.sheet);
  const text = (cells) => cells.map((cell) => (cell == null ? '' : String(cell)));
  const headers = text(sheet.rows[workbook.headerRow - 1]);
  const sample = [text(sheet.rows[workbook.headerRow])];
  const {fields} = defaultFields({headers, sampleRows: sample, productIds: [], period: guessPeriod(headers, sample), resolvedProduct: true});
  Object.assign(fields, {report_key: literal(reportKey), recognition_basis_id: literal('2'), basis_date: literal(basisDate),
    basis_reason: literal('月次報告を受け取った月で計上（性能の計測・架空）'),
    tax_amount: {mode: 'zero', value: '', source: '', operands: ['', '']}, amount_inc_tax: {mode: 'same_ex', value: '', source: '', operands: ['', '']}});
  const built = buildDefinition(fields, {headers, partnerId: partner.id, autoKey: reportKey, resolvedProduct: true});
  if (built.errors.length) throw new Error(`列対応を作れません: ${JSON.stringify(built.errors)}`);
  let profile = must(await call('GET', `/sales-import/context?partnerId=${partner.id}&kind=${workbook.kind}`), 200, '取込の文脈', {redact}).profile;
  if (!profile) profile = {id: must(await call('POST', '/mapping-profiles', {partnerId: partner.id, kind: workbook.kind, name: `${partner.name}｜${workbook.kind}`}), 201, '列対応', {redact}).profileId};
  return must(await call('POST', `/mapping-profiles/${profile.id}/versions`, built.definition), 201, '列対応の版', {redact}).mappingVersionId;
}

const royaltyFingerprint = (data) => JSON.stringify((data.periods || []).map((p) => [p.holderId, p.closeMonth, p.status, p.royaltyYen ?? null, p.draft?.lineCount ?? null, p.draft?.totals?.holdSalesYen ?? null]));
const partnerSales = (data, partnerId) => (data.rows || []).find((row) => Number(row.partnerId) === Number(partnerId))?.sales?.[0] ?? 0;
export const ruleCell = (data, ruleId) => (data.rows || []).find((row) => Number(row.id) === Number(ruleId))?.cells?.[0] ?? null;

// 区切りの時計。① で起点を決め、ほかは ① からの経過 ms（起点の前は null）
export function createClock() {
  let origin = null;
  return {start() { origin = performance.now(); }, now() { return origin == null ? null : performance.now() - origin; }};
}

// 1回の計測（手元と remote の共通の本体）。call(method, path, payload) は /api からの path で API を呼び {status, data} を返す。
// partner は {id, name}、ruleId は予実（受領進捗）で反映を見る届くはずの報告。counter は DB の呼び出しを数える口
// （手元だけ。{reset, snapshot, seen}。remote は null で、DB の呼び出し回数・1文の値の数・batch の文の数を null にする）。
// progress を渡すと、途中で止まったときのために、取れた区切り（marks。① からの ms）と ① の時刻（startedAt）をその場で書き込む
// （remote の計測が、登録は全部済んだのに⑤〜⑦や照らし合わせで止まった回の区切りを残すため）
export async function measureRun({call, workbook, partner, ruleId, reportKey, asOf = '2026-09-30', counter = null, clock = createClock(), redact, progress = null}) {
  const accountingMonth = addMonths(workbook.month, 1);
  const need = (result, status, label, options = {}) => must(result, status, label, {...options, redact});
  // ---------- 準備（計測に入れない） ----------
  const versionId = await prepareMapping(call, workbook, partner, reportKey, `${accountingMonth}-15`, {redact});
  const matrixPath = `/progress/matrix?from=${workbook.month}&to=${workbook.month}&today=${asOf}`;
  const royaltyBefore = need(await call('GET', `/royalty/periods?asOf=${asOf}`), 200, 'ロイヤリティ（前）');
  const annualBefore = need(await call('GET', `/reports/annual-sales?from=${accountingMonth}&to=${accountingMonth}`), 200, '年間売上（前）');
  const balanceBefore = need(await call('GET', `/reports/partner-balance?from=${accountingMonth}&to=${accountingMonth}`), 200, '売掛残高（前）');
  const matrixBefore = need(await call('GET', matrixPath), 200, '予実（前）');
  const before = {royalty: royaltyFingerprint(royaltyBefore), annual: Number(annualBefore.totals.total), balance: partnerSales(balanceBefore, partner.id), cell: ruleCell(matrixBefore, ruleId)};
  // 回の前の件数（D1 でも PostgreSQL でも同じ API で取れる数。後の回ほど組織の売上が積み上がるので、回ごとに残す）
  const counts = {activeReports: annualBefore.dataAsOf?.activeReports == null ? null : Number(annualBefore.dataAsOf.activeReports),
    progressReports: Object.keys(matrixBefore.reportKeys || {}).length, annualMonthTotal: before.annual};
  const base64 = workbook.bytes.toString('base64');

  // ---------- 計測 ----------
  counter?.reset();
  const dbMarks = [];
  const marks = {};
  if (progress) progress.marks = marks;
  const steps = new Map();
  let startedAt = null;
  // ① は起点（0）。ほかは ① からの経過。① の壁時計の時刻も残す（接続の見本・Query Insights と突き合わせる）
  const mark = (key) => {
    if (key === 'm1') {
      clock.start();
      startedAt = new Date().toISOString();
      if (progress) progress.startedAt = startedAt;
    }
    marks[key] = key === 'm1' ? 0 : clock.now();
    if (counter) dbMarks.push({key, ...counter.snapshot()});
  };
  // API を1回呼び、API ごとの時間と DB の呼び出しの回数（数えられるときだけ）を足し込む
  const step = async (label, method, path, payload, status = 200, options = {}) => {
    const counted = counter?.snapshot();
    const start = clock.now();
    const data = need(await call(method, path, payload), status, label, options);
    const done = counter?.snapshot();
    const entry = steps.get(label) || {label, count: 0, ms: 0, calls: counter ? 0 : null, statements: counter ? 0 : null};
    steps.set(label, {label, count: entry.count + 1, ms: entry.ms + clock.now() - start,
      calls: counter ? entry.calls + done.calls - counted.calls : null, statements: counter ? entry.statements + done.statements - counted.statements : null});
    return data;
  };
  mark('m1');
  const fileId = (await step('原本の受け取り', 'POST', '/sales-import/files', {name: workbook.fileName, base64, binding: null}, 201)).fileId;
  mark('m2');
  await step('見出しの行', 'POST', `/sales-import/files/${fileId}/selection`, {sheetName: workbook.sheet, headerRow: workbook.headerRow, excludedRows: []}, 201);
  const binding = {mode: 'by_product', productColumn: workbook.productColumn};
  const dry = await step('試しの分割', 'POST', `/sales-import/files/${fileId}/partitions`, {dryRun: true, binding, kind: workbook.kind, mappingVersionId: versionId}, 200, {okFalse: true});
  const excluded = (dry.unmatched || []).map((row) => ({sourceRow: row.sourceRow, reason: '照合できない行（架空の原本の要修正行。性能の計測）'}));
  if (excluded.length) await step('除いて選び直し', 'POST', `/sales-import/files/${fileId}/selection`, {sheetName: workbook.sheet, headerRow: workbook.headerRow, excludedRows: excluded}, 201);
  await step('割り当て', 'POST', `/sales-import/files/${fileId}/bindings`, binding, 201);
  const split = await step('分割', 'POST', `/sales-import/files/${fileId}/partitions`, {kind: workbook.kind, mappingVersionId: versionId});
  if (split.saved !== true) throw new Error(`分割を保存できません: ${JSON.stringify(split).slice(0, 400)}`);
  const previews = [];
  let firstPreviewAt = null;
  for (const partition of split.partitions) {
    const preview = await step('作品ごとの確認', 'POST', '/mapped-imports/preview', {workId: partition.workId, mappingVersionId: versionId, text: partition.csv, sourcePartitionId: partition.id});
    if (preview.ok !== true) throw new Error(`確認で止まりました: ${JSON.stringify(preview.errors).slice(0, 400)}`);
    // 確認の token（15分・1回限り）の最初の発行。最初の確認から最後の登録までの時間を残す
    if (firstPreviewAt == null) firstPreviewAt = clock.now();
    // 画面は作品ごとの確認のたびに重なる報告を読む（src/import/SalesImportWizard.jsx の reviewPartition）
    const overlaps = await step('重なりの確認', 'GET', `/sales-import/overlaps?token=${encodeURIComponent(preview.token)}`);
    if (overlaps.overlaps.length) throw new Error(`重なる報告があります（計測の前提と違う）: ${JSON.stringify(overlaps.overlaps).slice(0, 400)}`);
    previews.push({workId: partition.workId, token: preview.token});
  }
  mark('m3');
  const reports = [];
  // 登録の本文は画面と同じ形（src/import/SalesImportWizard.jsx の commitOne）。検算は無し、重なる報告が無いので判断も無し
  for (const preview of previews) {
    const commit = {token: preview.token, checks: [], decision: null, kind: workbook.kind, partnerId: Number(partner.id)};
    reports.push({workId: preview.workId, reportId: (await step('登録', 'POST', '/sales-import/commit', commit)).reportId});
  }
  mark('m4');
  const immediateMatrix = await step('予実（④の直後）', 'GET', matrixPath);
  const immediateAt = clock.now();
  const royalty = await step('ロイヤリティの下書き', 'GET', `/royalty/periods?asOf=${asOf}`);
  mark('m5');
  const annual = await step('会社売上管理表（年間売上）', 'GET', `/reports/annual-sales?from=${accountingMonth}&to=${accountingMonth}`);
  const ledger = await step('報告受領台帳（原本の詳細）', 'GET', `/sales-import/files/${fileId}`);
  const billing = [];
  for (const {workId} of reports) billing.push({workId, data: await step('請求書の下書き（作品ごとの請求の候補）', 'GET', `/billing?workId=${workId}&asOf=${asOf}`)});
  const balance = await step('入金予定（取引先別の売掛残高推移）', 'GET', `/reports/partner-balance?from=${accountingMonth}&to=${accountingMonth}`);
  await step('入金予定（売掛金の一覧）', 'GET', `/billing/receivables?asOf=${asOf}`);
  mark('m6');
  const matrix = await step('予実', 'GET', matrixPath);
  mark('m7');
  // D1 の上限との比較は計測の区間（①〜⑦）だけで見る（照らし合わせの読み取りを入れない）
  const limits = counter ? {maxParams: counter.seen.maxParams, maxBatch: counter.seen.maxBatch} : {maxParams: null, maxBatch: null};

  // ---------- 照らし合わせ（計測の後。登録の結果を API で読み直す） ----------
  const reportIds = reports.map((row) => row.reportId);
  const details = [];
  for (const id of reportIds) details.push(need(await call('GET', `/sales-import/reports/${id}`), 200, '登録の照合').report);
  const lines = details.reduce((sum, row) => ({n: sum.n + Number(row.lineCount), ex: sum.ex + Number(row.totals.amountExTax), inc: sum.inc + Number(row.totals.amountIncTax)}), {n: 0, ex: 0, inc: 0});
  const months = [...new Set(details.map((row) => row.accountingMonth))].sort();
  const problems = [];
  if (months.length !== 1 || months[0] !== accountingMonth) problems.push(`計上月が想定（${accountingMonth}）と違います: ${months.join('・') || 'なし'}`);
  const reflectedIn = (cell) => Boolean(cell) && reportIds.every((id) => cell.reportIds.includes(id));
  const segments = {};
  if (counter) {
    for (let index = 1; index < dbMarks.length; index += 1) {
      segments[`${dbMarks[index - 1].key}-${dbMarks[index].key}`] = {calls: dbMarks[index].calls - dbMarks[index - 1].calls, statements: dbMarks[index].statements - dbMarks[index - 1].statements};
    }
  } else {
    for (const {from, to} of SEGMENTS) segments[`${from}-${to}`] = {calls: null, statements: null};
  }
  return {
    label: workbook.label, fileName: workbook.fileName, byteLength: workbook.bytes.length, month: workbook.month, accountingMonth, reportKey,
    startedAt, marks, extractedAt: null, immediateAt, firstPreviewAt, tokenSpanMs: firstPreviewAt == null ? null : marks.m4 - firstPreviewAt, humanReviewMs: 0,
    before: counts,
    registered: {works: reports.length, reports: reportIds.length, rows: lines.n, excludedRows: excluded.length},
    reportIds, reportKeys: [...new Set(details.map((row) => row.reportKey))],
    forecastImmediate: reflectedIn(ruleCell(immediateMatrix, ruleId)) && !reflectedIn(before.cell),
    reflected: {
      royaltyDraft: royaltyFingerprint(royalty) !== before.royalty,
      companySales: Number(annual.totals.total) - before.annual === lines.ex,
      receiptLedger: ledger.progress?.complete === true,
      invoiceDraft: billing.every(({workId, data}) => data.candidates.some((row) => row.id === reports.find((r) => r.workId === workId).reportId)),
      receivableBalance: partnerSales(balance, partner.id) - before.balance === lines.inc,
      forecast: reflectedIn(ruleCell(matrix, ruleId)),
    },
    steps: [...steps.values()],
    db: {segments, ...limits},
    problems,
  };
}

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(runs) {
  const marks = Object.fromEntries(MILESTONES.map(({key}) => [key, median(runs.map((run) => run.marks[key]))]));
  const segments = Object.fromEntries(SEGMENTS.map(({from, to}) => [`${from}-${to}`, median(runs.map((run) => run.marks[to] - run.marks[from]))]));
  const steps = runs[0].steps.map(({label}) => ({label, ms: median(runs.map((run) => run.steps.find((row) => row.label === label)?.ms))}));
  return {marks, segments, steps, extraction: median(runs.map((run) => run.extractedAt)), forecastImmediate: runs.map((run) => run.forecastImmediate)};
}

export const ms = (value) => (value == null ? '—' : Math.round(value).toLocaleString('ja-JP'));
// 数えられない値（remote の DB の呼び出し回数など）は「—」
const count = (value) => (value == null ? '—' : Number(value).toLocaleString('ja-JP'));
export const yesNo = (value) => (value ? 'はい' : 'いいえ');
const maxOrNull = (values) => (values.some((value) => value == null) ? null : Math.max(...values));

export function formatMarkdown(results) {
  const out = [];
  for (const {runs} of results) {
    const first = runs[0];
    const summary = summarize(runs);
    const no = (key) => MILESTONES.find((m) => m.key === key).no;
    out.push(`### ${first.label}（${first.fileName}、${first.byteLength.toLocaleString('ja-JP')} バイト）`, '',
      `登録: ${first.registered.works}作品・${first.registered.rows.toLocaleString('ja-JP')}行（除いた行 ${first.registered.excludedRows}）`, '',
      `| 区切り | 中央値（①からの ms） | ${runs.map((_, index) => `${index + 1}回目`).join(' | ')} |`, `|---|--:|${runs.map(() => '--:').join('|')}|`);
    for (const {key, label} of MILESTONES) out.push(`| ${no(key)} ${label} | ${ms(summary.marks[key])} | ${runs.map((run) => ms(run.marks[key])).join(' | ')} |`);
    out.push('', '| 区間 | 中央値（ms） | DB の呼び出し（1回目。かっこは文の数） |', '|---|--:|--:|');
    for (const {from, to, label} of SEGMENTS) {
      const seg = first.db.segments[`${from}-${to}`] || {calls: null, statements: null};
      out.push(`| ${no(from)}→${no(to)} ${label} | ${ms(summary.segments[`${from}-${to}`])} | ${count(seg.calls)}（${count(seg.statements)}） |`);
    }
    out.push('', '| API | 呼んだ回数 | 中央値（ms。回数分の合計） | DB の呼び出し（1回目。かっこは文の数） |', '|---|--:|--:|--:|');
    for (const row of first.steps) {
      out.push(`| ${row.label} | ${row.count} | ${ms(summary.steps.find((step) => step.label === row.label).ms)} | ${count(row.calls)}（${count(row.statements)}） |`);
    }
    const maxParams = maxOrNull(runs.map((run) => run.db.maxParams));
    const maxBatch = maxOrNull(runs.map((run) => run.db.maxBatch));
    out.push('', `- うち抽出（Python）が終わるまで: 中央値 ${ms(summary.extraction)} ms（①から）`,
      `- 予実の即時の判定（④の直後に読んで反映されているか。売上の予実 FCST は未実装なので受領進捗で代える）:${summary.forecastImmediate.map(yesNo).join('・')}`,
      `- 反映（全回）: ${Object.keys(REFLECTED_LABELS).map((key) => `${REFLECTED_LABELS[key]} ${runs.map((run) => yesNo(run.reflected[key])).join('・')}`).join('、')}`,
      `- D1 の上限との比較（全回の最大）: 1文の値 ${maxParams == null ? '—' : maxParams}個（上限100）、1回の batch ${maxBatch == null ? '—' : maxBatch}文（上限480）`, '');
  }
  return out.join('\n');
}
