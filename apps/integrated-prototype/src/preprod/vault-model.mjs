// プリプロの保管庫（会社ルートの plans/2026-10-22-folder-preprod.md の「保管庫」と PP4）。純関数。画面と受け口の両方で使う。
// 落としたファイルの名前と元のフォルダの名前から種類を提案する（決まった規則だけ。AI は使わない。問い10 A）。人は違うものだけ直す。

export const VAULT_CATEGORIES = Object.freeze([
  Object.freeze({id: 'script', label: '台本・改訂', kind: 'script'}),
  Object.freeze({id: 'schedule', label: '香盤・予定表', kind: 'schedule'}),
  Object.freeze({id: 'daily', label: '日々スケ', kind: 'schedule'}),
  Object.freeze({id: 'costume', label: '衣装香盤', kind: 'other'}),
  Object.freeze({id: 'location', label: 'ロケ地・地図', kind: 'other'}),
  Object.freeze({id: 'cast', label: 'キャスト・スタッフ', kind: 'other'}),
  Object.freeze({id: 'still', label: 'スチール・参考', kind: 'image'}),
  Object.freeze({id: 'design', label: 'デザイン・宣伝', kind: 'planning_deck'}),
  Object.freeze({id: 'contract', label: '契約（F16 へ）', kind: 'contract'}),
  Object.freeze({id: 'other', label: 'その他', kind: 'other'}),
]);
export const VAULT_CATEGORY_IDS = Object.freeze(VAULT_CATEGORIES.map((c) => c.id));

// 先に当たった規則を使う。元のフォルダの名前とファイル名の両方を見る
const RULES = [
  ['contract', /契約/],
  ['daily', /日々スケ|日日スケ|日々|コールシート/],
  ['costume', /衣装/],
  ['schedule', /香盤|予定表|スケジュール/],
  ['script', /台本|脚本|決定稿|準備稿|初稿|改稿|号外|改訂|シナリオ/],
  ['location', /地図|ロケ|マップ/],
  ['cast', /キャスト|スタッフ|テロップ|クレジット/],
  ['still', /スチール|参考|イメージ/],
  ['design', /デザイン|ラフ|ポスター|チラシ/],
];
const IMAGE = /\.(jpe?g|png|gif|webp|heic|tiff?)$/i;

export function suggestCategory(path) {
  const text = String(path || '');
  for (const [id, rx] of RULES) if (rx.test(text)) return id;
  if (/\.pptx?$/i.test(text)) return 'design';
  if (IMAGE.test(text)) return 'still';
  return 'other';
}

// 原本の種類（source_documents.kind）。画像の置き場は image にする
export function sourceKindFor(category, fileName) {
  if (IMAGE.test(String(fileName || '')) && category !== 'contract') return 'image';
  return VAULT_CATEGORIES.find((c) => c.id === category)?.kind || 'other';
}

// 原本×作品ごとの最新の置き場（追加だけの表から、いまの置き場を導く）
export function currentPlacements(rows) {
  const map = new Map();
  for (const row of rows) { const prev = map.get(row.document_id); if (!prev || row.id > prev.id) map.set(row.document_id, row); }
  return [...map.values()];
}

// 種類ごとの件数（保管庫の左の一覧）
export function countByCategory(placements) {
  const out = Object.fromEntries(VAULT_CATEGORY_IDS.map((id) => [id, 0]));
  for (const p of placements) out[p.category] = (out[p.category] || 0) + 1;
  return out;
}
