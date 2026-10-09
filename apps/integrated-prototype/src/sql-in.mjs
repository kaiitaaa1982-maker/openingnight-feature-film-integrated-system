// Cloudflare D1 は1つの問い合わせに渡せる値（?）が100個まで。IN (...) に並べる値が多いときは分けて問い合わせ、結果をつなぐ。
// SQL の中の「(:in)」を値の数だけの (?,?,…) に置き換える。前後の値は before・after に渡す。
// 分けて読むと ORDER BY は分けた単位でしか効かないため、並び順が要るときは呼び出し側で並べ直す（sortBy を渡してもよい）。
export const IN_CHUNK = 80;

export async function allIn(db, sql, {before = [], ids = [], after = [], size = IN_CHUNK, sortBy} = {}) {
  if (!sql.includes('(:in)')) throw new Error('allIn: SQL に (:in) がありません');
  const list = [...new Set(ids)];
  if (!list.length) return [];
  const rows = [];
  for (let start = 0; start < list.length; start += size) {
    const part = list.slice(start, start + size);
    rows.push(...await db.all(sql.replace('(:in)', `(${part.map(() => '?').join(',')})`), [...before, ...part, ...after]));
  }
  return sortBy ? rows.sort(sortBy) : rows;
}
