// 作品・取引先などの候補検索（EntityPicker が使う純関数）。
// 正規化: 全角半角（NFKC。半角カナも全角に寄せる）・大文字小文字・空白・ひらがなとカタカナの違いを吸収する。
// 順位: 完全一致 → 前方一致 → 部分一致。同じ順位の中ではコード → 名称 → 読み・別名の順、その中は渡された並び順。
// 項目の形: {id, code, label, hint, keywords}（keywords は読み・別名。文字列か文字列の配列、省略可）。

export const MAX_CANDIDATES = 20;

// カタカナ（ァ〜ヶ）をひらがなに寄せる。ヽヾ（カタカナの繰り返し記号）も対応するひらがなへ。
function katakanaToHiragana(text) {
  return text.replace(/[ァ-ヶヽヾ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

export function normalizeForMatch(text) {
  if (text === null || text === undefined) return '';
  return katakanaToHiragana(String(text).normalize('NFKC').toLowerCase()).replace(/[\s​]+/g, '');
}

function keywordList(item) {
  const raw = item?.keywords;
  if (raw === null || raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(normalizeForMatch).filter(Boolean);
}

// 項目ごとの正規化済みの文字列。field の順（code → label → keywords）が同じ順位の中の優先度。
function fieldsOf(item) {
  return [
    {rank: 0, text: normalizeForMatch(item?.code)},
    {rank: 1, text: normalizeForMatch(item?.label)},
    ...keywordList(item).map((text) => ({rank: 2, text})),
  ].filter((field) => field.text);
}

// 空白で区切った語すべてが、いずれかの欄に含まれるか（部分一致の判定）。
function containsAllTokens(fields, tokens, hint) {
  const haystack = [...fields.map((field) => field.text), hint].join('\u0001');
  return tokens.every((token) => haystack.includes(token));
}

// 候補（最大 limit 件）。空の問い合わせでは先頭から limit 件を返す。
// 戻り値の各要素は元の項目に match: 'exact'|'prefix'|'partial'|'all' を足したもの。
export function matchEntities(items, query, {limit = MAX_CANDIDATES} = {}) {
  const list = Array.isArray(items) ? items : [];
  const q = normalizeForMatch(query);
  if (!q) return list.slice(0, limit).map((item) => ({...item, match: 'all'}));
  const tokens = String(query ?? '').normalize('NFKC').split(/[\s　]+/).map(normalizeForMatch).filter(Boolean);
  const scored = [];
  list.forEach((item, index) => {
    const fields = fieldsOf(item);
    let best = null;
    for (const field of fields) {
      let score = null;
      if (field.text === q) score = field.rank;
      else if (field.text.startsWith(q)) score = 10 + field.rank;
      else if (field.text.includes(q)) score = 20 + field.rank;
      if (score !== null && (best === null || score < best)) best = score;
    }
    if (best === null) {
      const hint = normalizeForMatch(item?.hint);
      if (tokens.length > 1 ? containsAllTokens(fields, tokens, hint) : hint.includes(q)) best = 30;
    }
    if (best !== null) scored.push({item, index, score: best});
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.slice(0, limit).map(({item, score}) => ({...item, match: score < 10 ? 'exact' : score < 20 ? 'prefix' : 'partial'}));
}

// 完全一致がちょうど1件のときだけその項目を返す（自動確定用）。同名が複数あれば確定しない。
export function exactMatch(items, query) {
  const q = normalizeForMatch(query);
  if (!q) return null;
  const hits = (Array.isArray(items) ? items : []).filter((item) => fieldsOf(item).some((field) => field.text === q));
  if (hits.length !== 1) {
    // 同じ名称が複数あってもコードが一致するものが1件なら、それを確定する
    const byCode = hits.filter((item) => normalizeForMatch(item?.code) === q);
    return byCode.length === 1 ? byCode[0] : null;
  }
  return hits[0];
}

export function findEntity(items, id) {
  if (id === null || id === undefined || id === '') return null;
  return (Array.isArray(items) ? items : []).find((item) => String(item.id) === String(id)) || null;
}

// 「名称（コード）」。コードが無いときは名称だけ。
export function entityText(item) {
  if (!item) return '';
  const label = item.label ?? '';
  const code = item.code ?? '';
  if (label && code && label !== code) return `${label}（${code}）`;
  return String(label || code || '');
}

// 入力欄の下に常に出す確定状態の文。
export function confirmationText(item, {emptyText = '未確定'} = {}) {
  return item ? `確定：${entityText(item)}` : emptyText;
}

// 作品・取引先・商品などの一覧を候補の形にそろえる。
export function toEntityItems(list, {hint} = {}) {
  return (Array.isArray(list) ? list : []).filter((row) => row && row.id !== undefined && row.id !== null).map((row) => ({
    id: row.id,
    code: row.code ?? row.sku ?? '',
    label: row.label ?? row.title ?? row.name ?? '',
    hint: typeof hint === 'function' ? hint(row) : row.hint ?? '',
    keywords: row.keywords ?? row.kana ?? row.reading ?? undefined,
  }));
}
