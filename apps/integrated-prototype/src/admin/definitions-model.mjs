// 設計・定義の画面で使う純関数。定義の本文（semantic-definitions.mjs）は変えずに、画面の主表示を業務の言葉にする。
// 技術の言葉（dbt・DuckDB・MCP・DWH・表名など）は「技術情報」の折りたたみへ回す。
import {tableTitle} from './er-model.mjs';

// 本文に技術の言葉が多い定義は、同じ意味を業務の言葉で言い直す（元の文は技術情報に残す）。
export const PLAIN_RULES = Object.freeze({
  workbench_verified_sales: '登録済みの架空データを同じ時点で読み取り、売上明細を作品への配賦に従って作品・流通・計上月ごとに集計します。帳票と全件を照合してから分析版を切り替えます。過去の帳票は当時の入力と定義のまま残し、計算の定義を比べた結果を業務の確定値へ自動では反映しません。',
});

// 画面の主表示に出すとき、技術の言葉に業務の言い方を添える。
const TERMS = [
  [/分析用MCP/g, 'AI向けの分析の接続口（MCP）'],
  [/(?<![（(])MCP(?![）)])/g, 'AI向けの接続口（MCP）'],
  [/DWH/g, '分析用の保管庫'],
  [/DuckDB/g, '分析用のデータベース'],
  [/dbt ?/g, '集計の手順 '],
];

export function plainTerms(text) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of TERMS) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, ' ').trim();
}

// "sale_lines / product_works" → [{name:'sale_lines', title:'売上明細'}, …]
export function sourceTables(source) {
  return String(source ?? '').split('/').map((name) => name.trim()).filter(Boolean).map((name) => ({name, title: tableTitle(name)}));
}

export function definitionView(definition) {
  const plain = Object.hasOwn(PLAIN_RULES, definition?.id) ? PLAIN_RULES[definition.id] : null;
  const sources = sourceTables(definition?.source);
  return {
    id: definition?.id,
    name: definition?.name || '名称未確認',
    grain: definition?.grain || '未確認',
    rule: plain || plainTerms(definition?.rule),
    month: definition?.month || '未確認',
    sources,
    sourceText: sources.length ? sources.map((source) => source.title).join('、') : '未確認',
    technical: [
      ['実装の状況', definition?.status],
      ['元の表（DB名）', sources.map((source) => source.name).join(' / ')],
      plain ? ['元の定義文', definition?.rule] : null,
    ].filter((entry) => entry && entry[1]),
  };
}

// 業務のまとまり同士のつながり。見えているまとまりの間だけを返す。
export function relationRows(relations, objects) {
  const byId = new Map((objects || []).map((object) => [object.id, object]));
  return (relations || [])
    .filter((relation) => byId.has(relation.from) && byId.has(relation.to))
    .map((relation, index) => ({key: `${relation.from}-${relation.to}-${index}`, from: byId.get(relation.from).label, to: byId.get(relation.to).label, label: relation.label}));
}
