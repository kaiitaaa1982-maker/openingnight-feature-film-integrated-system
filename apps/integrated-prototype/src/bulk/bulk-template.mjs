// 一括登録のExcel（テンプレート・現在の登録内容・失敗行）のシート定義。encodeReportXlsx にそのまま渡せる形で返す。
// 「入力」シートは1行目が見出し（必須は橙、任意は灰）、選択肢のある列は日本語の選択リスト。
// 「記入例」「記入ガイド」は登録されない説明用、「_meta」は非表示で種類と版を持つ（別の種類のファイルの取り違えを防ぐ）。
import {labelOf, optionsOf} from '../ui/labels.mjs';

const TYPE_TO_COLUMN = {code: 'code', text: 'text', yen: 'yen', int: 'int', date: 'date', month: 'text', select: 'text', lookup: 'code', percent: 'text'};
const TYPE_LABEL = {code: 'コード（文字）', text: '文字', yen: '金額（円・整数）', int: '整数', date: '日付（2026-09-01）', month: '年月（2026-09）', select: '選択', lookup: '登録済みのコード', percent: '割合（%）'};

export function inputColumns(spec) {
  return spec.columns.map((column) => ({key: column.key, label: column.header, type: TYPE_TO_COLUMN[column.type] || 'text', width: column.type === 'text' ? 24 : undefined}));
}

function displayRow(spec, row) {
  const out = {};
  for (const column of spec.columns) {
    const value = row?.[column.key];
    out[column.key] = column.type === 'select' && value ? labelOf(column.domain, value) : value ?? '';
  }
  return out;
}

function metaSheet(spec, kind, generatedAt) {
  return {
    name: '_meta', hidden: true, titleBand: false, freezeCols: 0,
    columns: [{key: 'k', label: 'key', type: 'text'}, {key: 'v', label: 'value', type: 'text'}],
    rows: [{k: 'entity', v: spec.entity}, {k: 'version', v: spec.version}, {k: 'kind', v: kind}, {k: 'generated_at', v: generatedAt}],
  };
}

function inputSheet(spec, rows) {
  return {
    name: '入力', titleBand: false, freezeCols: 1,
    columns: inputColumns(spec),
    rows: rows.map((row) => displayRow(spec, row)),
    headerKinds: Object.fromEntries(spec.columns.map((column) => [column.key, column.required ? 'required' : 'optional'])),
    validations: spec.columns.filter((column) => column.type === 'select').map((column) => ({key: column.key, list: optionsOf(column.domain).map((option) => option.label)})),
  };
}

function guideSheet(spec) {
  return {
    name: '記入ガイド', title: `${spec.label}の一括登録 記入ガイド`,
    conditions: [['登録されるシート', '「入力」だけ'], ['空欄', '任意の列は空欄のままで登録できます（推測で埋めません）'], ['件数の目安', '1〜3件なら画面の「＋新規登録」が早いです']],
    columns: [{key: 'header', label: '列', type: 'text'}, {key: 'required', label: '必須', type: 'text'}, {key: 'type', label: '形式', type: 'text'},
      {key: 'hint', label: '説明', type: 'text', wrap: true, width: 50}, {key: 'example', label: '例', type: 'text'}, {key: 'options', label: '選択肢', type: 'text', wrap: true, width: 40}],
    rows: spec.columns.map((column) => ({
      header: column.header, required: column.required ? '必須' : '任意', type: TYPE_LABEL[column.type] || '文字', hint: column.hint || '',
      example: column.type === 'select' && column.example ? column.example : column.example || '',
      options: column.type === 'select' ? optionsOf(column.domain).map((option) => option.label).join('・') : '',
    })),
    notes: [
      spec.update === 'approval' ? `既存の${spec.label}の修正は、この一括登録では反映しません（「マスタの表編集」で承認して反映します）。新しい${spec.label}の追加に使ってください。`
        : spec.update === 'direct' ? `出力したファイルの${spec.key === 'id' ? 'ID' : 'キー'}を残した行は、その行の修正として登録します。`
          : `既存の${spec.label}は修正できません。新しい${spec.label}の追加に使ってください。`,
      '1行でもエラーがあれば、ファイル全体を登録しません。エラーの行は「失敗行をExcelで出力」で理由つきで受け取れます。',
      '「参考_」で始まる列は読み込まれません（メモ用）。数式のセルは読み込めません。値に変換してから保存してください。',
    ],
    freezeCols: 1,
  };
}

function exampleSheet(spec) {
  const example = Object.fromEntries(spec.columns.map((column) => [column.key, column.example ?? '']));
  return {
    name: '記入例', title: `${spec.label}の記入例（このシートは登録されません）`,
    columns: inputColumns(spec), rows: [example], notes: ['この例の値はすべて架空です。'], freezeCols: 1,
  };
}

export function templateSheets(spec, generatedAt = new Date().toISOString()) {
  return [inputSheet(spec, []), exampleSheet(spec), guideSheet(spec), metaSheet(spec, 'template', generatedAt)];
}

export function currentSheets(spec, rows, generatedAt = new Date().toISOString()) {
  const input = inputSheet(spec, rows);
  const notes = rows.filter((row) => row.note).map((row) => `${row[spec.key]}: ${row.note}`);
  if (notes.length) input.notes = notes;
  return [input, guideSheet(spec), metaSheet(spec, 'current', generatedAt)];
}

// 失敗行: 元の見出しと値のまま、先頭に「行番号」、末尾に「エラー理由」
export function failedRowSheets(upload, previewRows) {
  const errors = new Map(previewRows.filter((row) => row.errors?.length).map((row) => [row.rowNo, row.errors.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join(' ／ ')]));
  const columns = [{key: '__row', label: '元の行番号', type: 'int'}, ...upload.headers.map((header, index) => ({key: `c${index}`, label: header || `列${index + 1}`, type: 'text'})), {key: '__error', label: 'エラー理由', type: 'text', wrap: true, width: 60}];
  const rows = upload.rows.filter((row) => errors.has(row.rowNo)).map((row) => ({
    __row: row.rowNo, __error: errors.get(row.rowNo),
    ...Object.fromEntries(upload.headers.map((_, index) => [`c${index}`, row.values[index] ?? ''])),
  }));
  return [{name: '失敗行', title: `${upload.fileName} の登録できない行`, conditions: [['件数', `${rows.length}行`]], columns, rows, freezeCols: 1,
    notes: ['「エラー理由」を見て元のファイルを直し、もう一度読み込んでください。']}];
}
