// D1 の上限（本番の DB 部品・画面・入力の検査で同じ値を使う。Worker でも動くよう node:* を使わない）
// 1行の文字の値（R2 へ逃がさない列）は128KBまで。これを超えると本番の部品（R2BackedD1Database）は「D1行内サイズ上限」で止める
export const D1_INLINE_VALUE_BYTES = 128 * 1024;
