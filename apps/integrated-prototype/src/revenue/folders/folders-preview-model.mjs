// フォルダ画面の見本（U4 の木とマス、U5 の1通）。DB も受け口も呼ばない。
// 年度は loadSalesReportYear、1通は loadReview。U2b の GET ができたら、この2つの中身だけを差し替える。
// 灰色のフォルダ名は、台帳（フォルダ台帳.csv）がこのリポジトリに無い。仕様に名前がある F07・F08 以外は source: 'unverified'。
import {DEFAULT_FISCAL_START_MONTH, addMonths, currentYm, fiscalYearOf, fiscalYearRange, monthsBetween} from '../../ui/condition-model.mjs';

export const PREVIEW_SOURCE = 'folders-preview';
export const LEDGER_COUNT = 54;
export const OPEN_CODE = 'F07';
export const CLOSED_MESSAGE = '今回は開けません';
export const DUPLICATE_LABEL = '受済';
export const DUPLICATE_TITLE = '同じ原本は受け取り済みです';
export const SORT_LABEL = '計上月';
export const SORT_TITLE = '並び: 計上月（基準は契約ごと: 販売月／報告月／契約月）';
export const READ_LABEL = '読';
export const REVIEW_LABEL = '要';

// マスの1字。色は画面側の tone。タイトルはホバー（説明）。
export const CELL_MARKS = Object.freeze({
  registered: Object.freeze({code: 'registered', mark: '済', tone: 'ok', title: '登録済み'}),
  missing: Object.freeze({code: 'missing', mark: '未', tone: 'muted', title: '未受領・期限前'}),
  overdue: Object.freeze({code: 'overdue', mark: '超', tone: 'bad', title: '未受領・期限超過'}),
  reading: Object.freeze({code: 'reading', mark: '読', tone: 'accent', title: '読取中'}),
  review: Object.freeze({code: 'review', mark: '要', tone: 'warn', title: '要確認'}),
  partial: Object.freeze({code: 'partial', mark: '途', tone: 'warn', title: '取込途中'}),
  superseded: Object.freeze({code: 'superseded', mark: '替', tone: 'muted', title: '置き換え済み'}),
  voided: Object.freeze({code: 'voided', mark: '消', tone: 'muted', title: '取消'}),
});

const NAMED_FOLDERS = Object.freeze({
  F07: Object.freeze({name: '販売管理', openable: true, source: 'spec'}),
  F08: Object.freeze({name: 'ロイヤリティ報告', openable: false, source: 'spec'}),
});

// 判定の1行。語は仕様の表だけ。札（tags）は小さな補足。count が空の判定は記号とラベルだけ。
const JUDGMENTS = Object.freeze({
  review: Object.freeze({kind: 'human', symbol: '!', label: '要確認', count: '2', tags: Object.freeze(['検査 10/12'])}),
  auto: Object.freeze({kind: 'auto', symbol: '✓', label: '確定', count: '12/12', tags: Object.freeze(['正答 100%', '実績 34'])}),
  human: Object.freeze({kind: 'human', symbol: '!', label: '要確認', count: '2', tags: Object.freeze(['検査 10/12', '合計差', '作品不明'])}),
  record: Object.freeze({kind: 'record', symbol: '!', label: '実績', count: '8/30', tags: Object.freeze(['検査 12/12'])}),
  shape: Object.freeze({kind: 'shape', symbol: '✕', label: '形違い', count: '2', tags: Object.freeze(['売上金額', '作品名'])}),
  read: Object.freeze({kind: 'read', symbol: '人', label: '要読', count: '', tags: Object.freeze(['PDF'])}),
});

export const REVIEW_KINDS = Object.freeze(['auto', 'human', 'record', 'shape', 'read']);

// 年度の何番目の月か → マス。2社で 済・未・超・読・要・途・替・消 が全部出る。
const ROW_PATTERNS = Object.freeze([
  Object.freeze({
    id: 'preview-stream',
    partner: '架空配信',
    kind: '配信',
    kindCode: 'digital',
    basis: '販売月',
    slug: 'haishin',
    // 0=期首。要の月だけ計上月を翌月にして併記が分かるようにする
    cells: Object.freeze({0: 'registered', 1: 'review', 2: 'partial', 3: 'superseded', 4: 'voided', 5: 'reading', 7: 'review'}),
    partial: Object.freeze({2: Object.freeze({done: 2, total: 6})}),
    shiftRecognition: Object.freeze([1]),
    files: Object.freeze(['preview-auto', 'preview-human', 'preview-record']),
  }),
  Object.freeze({
    id: 'preview-package',
    partner: '架空販売',
    kind: 'ビデオグラム',
    kindCode: 'package',
    basis: '報告月',
    slug: 'hanbai',
    cells: Object.freeze({0: 'overdue', 1: 'registered', 2: 'registered', 3: 'review', 4: 'registered', 6: 'review'}),
    partial: Object.freeze({}),
    shiftRecognition: Object.freeze([]),
    files: Object.freeze(['preview-shape', 'preview-read', 'preview-billed']),
  }),
]);

export function ledgerFolders() {
  return Array.from({length: LEDGER_COUNT}, (_, index) => {
    const code = `F${String(index + 1).padStart(2, '0')}`;
    const named = NAMED_FOLDERS[code];
    if (named) return Object.freeze({code, ...named});
    return Object.freeze({code, name: code, openable: false, source: 'unverified'});
  });
}

export function salesReportFolder() {
  return Object.freeze({code: 'sales-reports', name: '売上報告書', parent: OPEN_CODE, source: 'spec'});
}

function monthLabel(month) {
  return `${Number(String(month).slice(5))}月`;
}

function cellOf(month, code, {partial, recognitionMonth}) {
  const mark = CELL_MARKS[code] || CELL_MARKS.missing;
  const ratio = partial ? `${partial.done}/${partial.total}` : null;
  const text = ratio ? `${mark.mark} ${ratio}` : mark.mark;
  return Object.freeze({
    month,
    label: monthLabel(month),
    code: mark.code,
    mark: text,
    tone: mark.tone,
    title: `${mark.title} 対象${month} 計上${recognitionMonth}`,
    recognitionMonth,
    partial: ratio,
  });
}

function fileFromReview(review) {
  if (!review) return null;
  return Object.freeze({
    id: review.id,
    name: review.fileName,
    month: review.month,
    partnerId: review.partnerId,
    judgment: review.judgment,
    sampling: Boolean(review.sampled),
  });
}

export function previewSalesReportYear({today = new Date(), fiscalYear = null, fiscalStartMonth = DEFAULT_FISCAL_START_MONTH} = {}) {
  const start = Number(fiscalStartMonth) || DEFAULT_FISCAL_START_MONTH;
  const ym = today instanceof Date ? currentYm(today) : String(today).slice(0, 7);
  const year = Number(fiscalYear) || fiscalYearOf(ym, start);
  const range = fiscalYearRange(year, start);
  const months = monthsBetween(range.from, range.to);
  const rows = ROW_PATTERNS.map((pattern) => {
    const cells = months.map((month, index) => {
      const code = pattern.cells[index] || 'missing';
      const recognitionMonth = pattern.shiftRecognition.includes(index) ? addMonths(month, 1) : month;
      return cellOf(month, code, {partial: pattern.partial[index] || null, recognitionMonth});
    });
    const files = pattern.files.map((id) => fileFromReview(reviewById(id))).filter(Boolean);
    return Object.freeze({
      id: pattern.id,
      partner: pattern.partner,
      kind: pattern.kind,
      kindCode: pattern.kindCode,
      basis: pattern.basis,
      cells: Object.freeze(cells),
      files: Object.freeze(files),
    });
  });
  const seenNames = rows.flatMap((row) => row.files.map((file) => file.name));
  return Object.freeze({
    source: PREVIEW_SOURCE,
    fiscalYear: year,
    fiscalStartMonth: start,
    from: range.from,
    to: range.to,
    months: Object.freeze(months),
    rows: Object.freeze(rows),
    folders: Object.freeze(ledgerFolders()),
    salesReport: salesReportFolder(),
    seenNames: Object.freeze(seenNames),
    selection: null,
    pending: null,
  });
}

// 画面が呼ぶ口。U2b ではここを受け口の GET に替える。
export function loadSalesReportYear(input) {
  return previewSalesReportYear(input);
}

function rowOf(board, rowId) {
  return board.rows.find((row) => row.id === rowId) || null;
}

function replaceRow(board, rowId, nextRow) {
  return {...board, rows: board.rows.map((row) => row.id === rowId ? nextRow : row)};
}

function openMonth(row, month) {
  if (!month) return null;
  const cell = row.cells.find((item) => item.month === month);
  if (!cell || (cell.code !== 'missing' && cell.code !== 'overdue')) return null;
  return cell.month;
}

function targetMonth(board, row, month) {
  return openMonth(row, month)
    || openMonth(row, board.selection?.rowId === row.id ? board.selection.month : null)
    || row.cells.find((cell) => cell.code === 'missing' || cell.code === 'overdue')?.month
    || null;
}

export function selectCell(board, {rowId, month}) {
  return {...board, selection: {rowId, month}};
}

// 置く。同じファイル名は見本の中だけで「受済」にし、マスも原本の数も変えない。違う名前は読取中。
export function beginDrop(board, {rowId, fileName, month = null}) {
  const name = String(fileName || '').trim();
  const row = rowOf(board, rowId);
  if (!name || !row) return {board, effect: null};
  if (board.seenNames.includes(name)) {
    return {board: {...board, selection: {rowId, month: month || board.selection?.month || null}}, effect: {code: 'duplicate', label: DUPLICATE_LABEL, title: DUPLICATE_TITLE, rowId}};
  }
  const target = targetMonth(board, row, month);
  if (!target) return {board, effect: null};
  const cells = row.cells.map((cell) => cell.month === target ? cellOf(target, 'reading', {recognitionMonth: cell.recognitionMonth}) : cell);
  const next = replaceRow(board, rowId, {...row, cells});
  return {
    board: {...next, seenNames: [...board.seenNames, name], selection: {rowId, month: target}, pending: {rowId, fileName: name, month: target}},
    effect: {code: 'reading', label: READ_LABEL, title: CELL_MARKS.reading.title, rowId, month: target},
  };
}

// 読取中のあと。見本は要確認で止める（自動で確定はしない）。
export function finishDrop(board) {
  if (!board.pending) return board;
  const {rowId, fileName, month} = board.pending;
  const row = rowOf(board, rowId);
  if (!row) return {...board, pending: null};
  const cells = row.cells.map((cell) => cell.month === month ? cellOf(month, 'review', {recognitionMonth: cell.recognitionMonth}) : cell);
  const file = Object.freeze({id: `preview-drop-${fileName}`, name: fileName, month, partnerId: rowId, judgment: JUDGMENTS.review});
  const next = replaceRow(board, rowId, {...row, cells, files: [file, ...row.files]});
  return {...next, pending: null};
}

// 代表モードでは URL で開いても中身を出さない（#134 の指摘）。メニューから外すだけでは本文が残る。
export function previewHidden(viewMode) {
  return viewMode === 'representative';
}

export function judgmentText(judgment) {
  if (!judgment) return '';
  return [judgment.symbol, judgment.label, judgment.count].filter((part) => part != null && part !== '').join(' ');
}

function figure(label, left, right, {leftName = '原本', rightName = '予定', unit = 'yen', extra = null, extraName = null} = {}) {
  if (left == null || right == null) {
    return Object.freeze({label, left: null, right: null, leftName, rightName, unit, extra, extraName, tone: 'muted', mark: '未', diff: null});
  }
  const diff = right + (extra ?? 0) - left;
  const tone = diff === 0 ? 'ok' : 'bad';
  return Object.freeze({label, left, right, leftName, rightName, unit, extra, extraName, tone, mark: tone === 'ok' ? '合' : '差', diff});
}

function spot(id, line, left, {status = 'read', label = '', fields = [], title = ''} = {}) {
  return Object.freeze({
    id, line, left: Object.freeze([...left]), status, label, title,
    fields: Object.freeze(fields.map((field) => Object.freeze({...field}))),
  });
}

function step(label, at, who, result, hash = '') {
  return Object.freeze({label, at, who, result, hash, note: ''});
}

const LINKED_HEADERS = Object.freeze(['行', '商品名', '数量', '金額', '明細', '計上月', '税抜', '税額', '税込', '作品', '題名', 'SKU', '取引先', '基準']);

function review(input) {
  return Object.freeze({
    ...input,
    judgment: input.judgment,
    figures: Object.freeze(input.figures),
    works: Object.freeze(input.works || []),
    exceptions: Object.freeze(input.exceptions),
    rows: Object.freeze(input.rows),
    history: Object.freeze(input.history),
    linkedHeaders: LINKED_HEADERS,
    linkedRows: Object.freeze(input.linkedRows || []),
  });
}

// 架空の5通。金額は整数円。税込＝税抜＋税額。判定の語は仕様の表。
const REVIEWS = Object.freeze([
  review({
    id: 'preview-auto',
    kind: 'auto',
    partnerId: 'preview-stream',
    partner: '架空配信',
    kindLabel: '配信',
    basis: '販売月',
    fileName: 'kakuu-haishin-2026-05.xlsx',
    month: '2026-05',
    recognitionMonth: '2026-05',
    period: '2026-05-01〜2026-05-31',
    received: '2026-10-02',
    judgment: JUDGMENTS.auto,
    registered: true,
    sampled: true,
    voidable: true,
    page: null,
    figures: Object.freeze([
      figure('税抜', 360000, 360000),
      figure('税額', 36000, 36000),
      figure('税込', 396000, 396000),
      figure('件数', 4, 4, {unit: 'int', extra: 0, extraName: '除外'}),
      figure('申告', 360000, 360000, {leftName: '申告', rightName: '原本'}),
    ]),
    works: Object.freeze([
      Object.freeze({title: '架空の風', code: 'KAKUU-KAZE', rows: 3, ex: 240000, month: '2026-05', tone: 'ok', mark: '合'}),
      Object.freeze({title: '架空の海', code: 'KAKUU-UMI', rows: 1, ex: 120000, month: '2026-05', tone: 'ok', mark: '合'}),
    ]),
    exceptions: Object.freeze([]),
    rows: Object.freeze([
      spot('a2', '2', ['架空視聴', '20', '120,000', '架空の風']),
      spot('a3', '3', ['架空視聴', '10', '80,000', '架空の風']),
      spot('a4', '4', ['架空視聴', '5', '40,000', '架空の風']),
      spot('a5', '5', ['架空視聴', '8', '120,000', '架空の海']),
    ]),
    history: Object.freeze([
      step('受け取り', '2026-10-02 09:12', '管理者', 'kakuu-haishin-2026-05.xlsx', 'h-05a1'),
      step('読み取り', '2026-10-02 09:13', '抽出', '版4'),
      step('検査', '2026-10-02 09:14', '型1', '12/12'),
      step('判定', '2026-10-02 09:14', '型1', '✓ 確定 12/12'),
      step('登録', '2026-10-02 09:15', '管理者', '自動'),
    ]),
    linkedRows: Object.freeze([
      Object.freeze(['2', '架空視聴', '20', '120000', '見本-1', '2026-05', '120000', '12000', '132000', 'KAKUU-KAZE', '架空の風', 'SKU-KAKUU', '架空配信', '販売月']),
      Object.freeze(['3', '架空視聴', '10', '80000', '見本-2', '2026-05', '80000', '8000', '88000', 'KAKUU-KAZE', '架空の風', 'SKU-KAKUU', '架空配信', '販売月']),
      Object.freeze(['4', '架空視聴', '5', '40000', '見本-3', '2026-05', '40000', '4000', '44000', 'KAKUU-KAZE', '架空の風', 'SKU-KAKUU', '架空配信', '販売月']),
      Object.freeze(['5', '架空視聴', '8', '120000', '見本-4', '2026-05', '120000', '12000', '132000', 'KAKUU-UMI', '架空の海', 'SKU-UMI', '架空配信', '販売月']),
    ]),
  }),
  review({
    id: 'preview-human',
    kind: 'human',
    partnerId: 'preview-stream',
    partner: '架空配信',
    kindLabel: '配信',
    basis: '販売月',
    fileName: 'kakuu-haishin-2026-06.xlsx',
    month: '2026-06',
    recognitionMonth: '2026-07',
    period: '2026-06-01〜2026-06-30',
    received: '2026-10-04',
    judgment: JUDGMENTS.human,
    registered: false,
    sampled: false,
    voidable: false,
    page: null,
    figures: Object.freeze([
      figure('税抜', 480000, 460000),
      figure('税額', 48000, 46000),
      figure('税込', 528000, 506000),
      figure('件数', 6, 5, {unit: 'int', extra: 1, extraName: '除外'}),
      figure('申告', 480000, 480000, {leftName: '申告', rightName: '原本'}),
    ]),
    works: Object.freeze([
      Object.freeze({title: '架空の風', code: 'KAKUU-KAZE', rows: 5, ex: 460000, month: '2026-07', tone: 'ok', mark: '合'}),
      Object.freeze({title: '作品不明', code: '', rows: 1, ex: 20000, month: '2026-07', tone: 'bad', mark: '不明'}),
    ]),
    exceptions: Object.freeze([
      spot('total', '合計', ['', '', '480,000', ''], {
        status: 'missing', label: '合計差', title: '税抜の列の和と登録予定',
        fields: [{name: '原本', value: '480,000'}, {name: '予定', value: '460,000'}, {name: '差', value: '-20,000'}],
      }),
      spot('work', '7', ['架空の行', '1', '20,000', ''], {
        status: 'missing', label: '作品不明', title: '作品に照合できない',
        fields: [{name: '作品', value: '未'}, {name: '税抜', value: '20,000'}],
      }),
    ]),
    rows: Object.freeze([
      spot('h2', '2', ['架空視聴', '40', '100,000', '架空の風']),
      spot('h3', '3', ['架空視聴', '30', '100,000', '架空の風']),
      spot('h4', '4', ['架空視聴', '20', '100,000', '架空の風']),
      spot('h5', '5', ['架空視聴', '12', '80,000', '架空の風']),
      spot('h6', '6', ['架空視聴', '8', '80,000', '架空の風']),
      spot('work', '7', ['架空の行', '1', '20,000', ''], {status: 'missing', label: '作品不明', fields: [{name: '作品', value: '未'}]}),
      spot('total', '合計', ['', '', '480,000', ''], {status: 'missing', label: '合計差', fields: [{name: '差', value: '-20,000'}]}),
    ]),
    history: Object.freeze([
      step('受け取り', '2026-10-04 10:20', '管理者', 'kakuu-haishin-2026-06.xlsx', 'h-06b2'),
      step('読み取り', '2026-10-04 10:21', '抽出', '版4'),
      step('検査', '2026-10-04 10:22', '型1', '10/12'),
      step('判定', '2026-10-04 10:22', '型1', '! 要確認 2'),
    ]),
    linkedRows: Object.freeze([]),
  }),
  review({
    id: 'preview-record',
    kind: 'record',
    partnerId: 'preview-stream',
    partner: '架空配信',
    kindLabel: '配信',
    basis: '販売月',
    fileName: 'kakuu-haishin-2026-12.xlsx',
    month: '2026-12',
    recognitionMonth: '2026-12',
    period: '2026-12-01〜2026-12-31',
    received: '2026-10-18',
    judgment: JUDGMENTS.record,
    registered: false,
    sampled: false,
    voidable: false,
    page: null,
    figures: Object.freeze([
      figure('税抜', 210000, 210000),
      figure('税額', 21000, 21000),
      figure('税込', 231000, 231000),
      figure('件数', 3, 3, {unit: 'int', extra: 0, extraName: '除外'}),
      figure('申告', 210000, 210000, {leftName: '申告', rightName: '原本'}),
    ]),
    works: Object.freeze([
      Object.freeze({title: '架空の風', code: 'KAKUU-KAZE', rows: 3, ex: 210000, month: '2026-12', tone: 'ok', mark: '合'}),
    ]),
    exceptions: Object.freeze([
      spot('received', '条件', ['受領日', '2026-10-18'], {
        status: 'inferred', label: '受領日', title: '原本に欄が無い',
        fields: [{name: '値', value: '2026-10-18'}],
      }),
    ]),
    rows: Object.freeze([
      spot('r2', '2', ['架空視聴', '10', '70,000', '架空の風']),
      spot('r3', '3', ['架空視聴', '10', '70,000', '架空の風']),
      spot('r4', '4', ['架空視聴', '10', '70,000', '架空の風']),
      spot('received', '条件', ['受領日', '2026-10-18'], {status: 'inferred', label: '受領日', fields: [{name: '値', value: '2026-10-18'}]}),
    ]),
    history: Object.freeze([
      step('受け取り', '2026-10-18 16:01', '管理者', 'kakuu-haishin-2026-12.xlsx', 'h-12c3'),
      step('読み取り', '2026-10-18 16:02', '抽出', '版4'),
      step('検査', '2026-10-18 16:03', '型1', '12/12'),
      step('判定', '2026-10-18 16:03', '型1', '! 実績 8/30'),
    ]),
    linkedRows: Object.freeze([
      Object.freeze(['2', '架空視聴', '10', '70000', '見本-5', '2026-12', '70000', '7000', '77000', 'KAKUU-KAZE', '架空の風', 'SKU-KAKUU', '架空配信', '販売月']),
      Object.freeze(['3', '架空視聴', '10', '70000', '見本-6', '2026-12', '70000', '7000', '77000', 'KAKUU-KAZE', '架空の風', 'SKU-KAKUU', '架空配信', '販売月']),
      Object.freeze(['4', '架空視聴', '10', '70000', '見本-7', '2026-12', '70000', '7000', '77000', 'KAKUU-KAZE', '架空の風', 'SKU-KAKUU', '架空配信', '販売月']),
    ]),
  }),
  review({
    id: 'preview-shape',
    kind: 'shape',
    partnerId: 'preview-package',
    partner: '架空販売',
    kindLabel: 'ビデオグラム',
    basis: '報告月',
    fileName: 'kakuu-hanbai-2026-08.xlsx',
    month: '2026-08',
    recognitionMonth: '2026-08',
    period: '2026-08-01〜2026-08-31',
    received: '2026-10-06',
    judgment: JUDGMENTS.shape,
    registered: false,
    sampled: false,
    voidable: false,
    page: null,
    figures: Object.freeze([
      figure('税抜', null, null),
      figure('税額', null, null),
      figure('税込', null, null),
      figure('件数', null, null, {unit: 'int'}),
    ]),
    works: Object.freeze([]),
    exceptions: Object.freeze([
      spot('head-ex', '見出し', ['売上金額'], {
        status: 'missing', label: '売上金額', title: '型の列名と一致しない',
        fields: [{name: '見出し', value: '売上金額'}, {name: '型', value: '税抜金額'}],
      }),
      spot('head-work', '見出し', ['作品名'], {
        status: 'missing', label: '作品名', title: '型の列名と一致しない',
        fields: [{name: '見出し', value: '作品名'}, {name: '型', value: '作品コード'}],
      }),
    ]),
    rows: Object.freeze([
      spot('head-ex', '見出し', ['売上金額'], {status: 'missing', label: '売上金額', fields: [{name: '型', value: '税抜金額'}]}),
      spot('head-work', '見出し', ['作品名'], {status: 'missing', label: '作品名', fields: [{name: '型', value: '作品コード'}]}),
    ]),
    history: Object.freeze([
      step('受け取り', '2026-10-06 11:02', '管理者', 'kakuu-hanbai-2026-08.xlsx', 'h-08d4'),
      step('読み取り', '2026-10-06 11:03', '抽出', '見出し不一致'),
      step('判定', '2026-10-06 11:03', '型', '✕ 形違い 2'),
    ]),
    linkedRows: Object.freeze([]),
  }),
  review({
    id: 'preview-read',
    kind: 'read',
    partnerId: 'preview-package',
    partner: '架空販売',
    kindLabel: 'ビデオグラム',
    basis: '報告月',
    fileName: 'kakuu-hanbai-2026-11.pdf',
    month: '2026-11',
    recognitionMonth: '2026-11',
    period: '',
    received: '2026-10-08',
    judgment: JUDGMENTS.read,
    registered: false,
    sampled: false,
    voidable: false,
    page: Object.freeze({page: 1}),
    figures: Object.freeze([
      figure('税抜', null, null),
      figure('税額', null, null),
      figure('税込', null, null),
      figure('件数', null, null, {unit: 'int'}),
    ]),
    works: Object.freeze([]),
    exceptions: Object.freeze([]),
    rows: Object.freeze([]),
    history: Object.freeze([
      step('受け取り', '2026-10-08 13:40', '管理者', 'kakuu-hanbai-2026-11.pdf', 'h-11e5'),
      step('読み取り', '2026-10-08 13:41', '抽出', '画像'),
      step('判定', '2026-10-08 13:41', '抽出', '人 要読'),
    ]),
    linkedRows: Object.freeze([]),
  }),
]);

// 請求済みの架空の1通。取消の書き込みは呼ばず、画面で理由を出すためだけ。
const BILLED = review({
  id: 'preview-billed',
  kind: 'billed',
  partnerId: 'preview-package',
  partner: '架空販売',
  kindLabel: 'ビデオグラム',
  basis: '報告月',
  fileName: 'kakuu-hanbai-2026-06.xlsx',
  month: '2026-06',
  recognitionMonth: '2026-06',
  period: '2026-06-01〜2026-06-30',
  received: '2026-10-03',
  judgment: Object.freeze({kind: 'auto', symbol: '✓', label: '確定', count: '12/12', tags: Object.freeze(['請求済'])}),
  registered: true,
  sampled: false,
  voidable: false,
  billed: true,
  page: null,
  figures: Object.freeze([
    figure('税抜', 80000, 80000),
    figure('税額', 8000, 8000),
    figure('税込', 88000, 88000),
    figure('件数', 2, 2, {unit: 'int', extra: 0, extraName: '除外'}),
  ]),
  works: Object.freeze([
    Object.freeze({title: '架空の箱', code: 'KAKUU-HAKO', rows: 2, ex: 80000, month: '2026-06', tone: 'ok', mark: '合'}),
  ]),
  exceptions: Object.freeze([]),
  rows: Object.freeze([
    spot('b2', '2', ['架空の箱', '4', '50,000']),
    spot('b3', '3', ['架空の箱', '2', '30,000']),
  ]),
  history: Object.freeze([
    step('受け取り', '2026-10-03 08:05', '管理者', 'kakuu-hanbai-2026-06.xlsx', 'h-06f6'),
    step('読み取り', '2026-10-03 08:06', '抽出', '版2'),
    step('検査', '2026-10-03 08:07', '型2', '12/12'),
    step('判定', '2026-10-03 08:07', '型2', '✓ 確定 12/12'),
    step('登録', '2026-10-03 08:08', '管理者', '自動'),
  ]),
  linkedRows: Object.freeze([
    Object.freeze(['2', '架空の箱', '4', '50000', '見本-8', '2026-06', '50000', '5000', '55000', 'KAKUU-HAKO', '架空の箱', 'SKU-HAKO', '架空販売', '報告月']),
    Object.freeze(['3', '架空の箱', '2', '30000', '見本-9', '2026-06', '30000', '3000', '33000', 'KAKUU-HAKO', '架空の箱', 'SKU-HAKO', '架空販売', '報告月']),
  ]),
});

export function reviewById(id) {
  if (id === BILLED.id) return BILLED;
  return REVIEWS.find((item) => item.id === id) || null;
}

export function loadReview(id) {
  return reviewById(id);
}

export function reviews() {
  return REVIEWS;
}

// 読めない値が1つでもあれば登録できない。形が違う・人が読む・登録済みも押せない。
export function registerState(item) {
  if (!item) return Object.freeze({enabled: false, label: '登録', reason: '未確認'});
  if (item.registered) return Object.freeze({enabled: false, label: '登録済み', reason: '登録済み'});
  if (item.exceptions.some((spotItem) => spotItem.status === 'missing')) return Object.freeze({enabled: false, label: '登録', reason: '読めない'});
  if (item.kind === 'shape') return Object.freeze({enabled: false, label: '登録', reason: '形違い'});
  if (item.kind === 'read') return Object.freeze({enabled: false, label: '登録', reason: '要読'});
  return Object.freeze({enabled: true, label: '登録', reason: ''});
}

export function numbersOk(item) {
  return Boolean(item?.figures?.length) && item.figures.every((row) => row.tone === 'ok');
}

export function linkedTotals(item) {
  const headers = item?.linkedHeaders || [];
  const rows = item?.linkedRows || [];
  const ex = headers.indexOf('税抜');
  const line = headers.indexOf('行');
  const sum = rows.reduce((total, row) => total + Number(row[ex] || 0), 0);
  return Object.freeze({
    count: rows.length,
    ex: sum,
    lines: Object.freeze(rows.map((row) => String(row[line] ?? ''))),
  });
}

// 落とした表の行数と税抜の和が、画面の原本の数字と一致するか。
export function linkedMatches(item) {
  if (!item) return false;
  const totals = linkedTotals(item);
  const ex = item.figures?.find((row) => row.label === '税抜');
  const count = item.figures?.find((row) => row.label === '件数');
  if (!ex || !count || ex.left == null || count.left == null) return false;
  return totals.count === count.left && totals.ex === ex.left && totals.lines.every((line) => line !== '');
}

// 落とせるのは、登録済みで、全作品の財務権限がある人だけ。見本の財務は管理者。
export function exportState(item, {finance = true, registered = null} = {}) {
  const isRegistered = registered == null ? Boolean(item?.registered) : Boolean(registered);
  if (!finance) return Object.freeze({enabled: false, reason: '財務', title: '全作品の財務権限が要る'});
  if (!isRegistered) return Object.freeze({enabled: false, reason: '未登録', title: '登録した通だけ'});
  if (!linkedMatches(item)) return Object.freeze({enabled: false, reason: 'なし', title: '落とす行が無い'});
  return Object.freeze({enabled: true, reason: '', title: ''});
}

export function voidBlock(item) {
  if (!item?.billed) return null;
  return Object.freeze({lead: '請求済みのため取り消せません', rest: '差額の報告で直します（未実装）'});
}

export function canCommitVoid({reason = '', fix = ''} = {}) {
  return Boolean(String(reason).trim()) && (fix === 'type' || fix === 'source');
}

export function samplingLabel(code) {
  if (code === 'match') return '合っていた';
  if (code === 'type') return '直した 型の誤り';
  if (code === 'source') return '直した 原本の誤り';
  if (code === 'fixed') return '直した';
  return '';
}
