// 台本の構造化画面の計算と判定（DB・時刻を読まない）。
// 読み取り（python/extract_document.py の workflow-extractor-4 以降）は、シーンごとに出どころ（source: 頁と柱の枠）と、
// 項目ごとの状態（fields: read＝そのまま読めた・inferred＝補った・missing＝読めない）と理由を返す。
// 補った値と読めない値は、人が確かめる（checked）か直すまで承認できない（FR-PROD-STRUCT-006）。
// 前の読み取り（fields の無い版）で読んだ原本は、印も枠も無いものとして扱う。

export const FIELD_KEYS = ['sceneNo', 'location', 'dayNight', 'cast', 'pageEighths'];
export const FIELD_LABELS = Object.freeze({sceneNo: 'シーン番号', location: '場所', dayNight: '昼夜', cast: '出演者', pageEighths: '頁（1/8）'});
export const STATUS_LABELS = Object.freeze({read: '読めた', inferred: '補った・要確認', missing: '読めない・要入力'});
export const DAY_NIGHT_LABELS = Object.freeze({D: '昼', N: '夜', DN: '夕・薄暮'});
// 印を付ける項目: 状態が「読めた」でないもの。知らない状態（読み取りの版の違い・壊れた JSON）も、確かめずに通さないよう印を付ける
const isMarked = (field) => Boolean(field) && typeof field === 'object' && field.status !== 'read';
// 印の種類。読めない（missing）のほかは、補った（inferred）として数えて出す
export const markKind = (status) => (status === 'missing' ? 'missing' : 'inferred');

const list = (value) => (Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean) : []);
const comparable = (key, value) => {
  if (key === 'cast') return list(value).join('、');
  if (value == null) return '';
  return key === 'dayNight' ? String(value).trim().toUpperCase() : String(value).trim();
};

// 2つの値が同じか（出演者は並びまで同じ、昼夜は大文字小文字を問わない、空と null は同じ）
export function sameValue(key, a, b) {
  return comparable(key, a) === comparable(key, b);
}

// カードが指す読み取りのシーン（人が足したシーンは null）
export function extractedScene(card, extraction) {
  const index = card?.extractionIndex;
  return Number.isSafeInteger(index) && index >= 0 ? extraction?.scenes?.[index] ?? null : null;
}

// 読み取りの1シーンのうち、印の付く項目（補った・読めない）
export function markedFields(extracted) {
  const fields = extracted?.fields || {};
  return FIELD_KEYS.filter((key) => isMarked(fields[key]));
}

// 読み取りの結果をカード（画面と保存の1シーン）にする。値は候補で、checked は空から始める
export function cardsFromExtraction(extraction) {
  return (extraction?.scenes || []).map((scene, index) => ({
    sceneNo: scene.sceneNo ?? '',
    location: scene.location ?? '',
    dayNight: scene.dayNight ?? null,
    cast: list(scene.cast),
    synopsis: scene.synopsis ?? '',
    estimatedMinutes: scene.estimatedMinutes ?? null,
    pageEighths: scene.pageEighths ?? null,
    reviewNotes: Array.isArray(scene.reviewNotes) ? scene.reviewNotes : [],
    extractionIndex: index,
    checked: [],
  }));
}

// 保存した確認済みの版（reviews[].scenes）をカードに戻す。印の注意（reviewNotes）は読み取りから引く。
// 読み取りとの結び付き（extractionIndex）の無い版（この画面より前の版）は、シーン番号が読み取りの1シーンとだけ一致するときに結び付ける
export function cardsFromReview(reviewScenes, extraction) {
  const bySceneNo = new Map();
  (extraction?.scenes || []).forEach((scene, index) => {
    const key = String(scene?.sceneNo ?? '');
    bySceneNo.set(key, bySceneNo.has(key) ? null : index);
  });
  return (reviewScenes || []).map((scene) => {
    const linked = Number.isSafeInteger(scene.extractionIndex) && scene.extractionIndex >= 0 ? scene.extractionIndex : null;
    const extractionIndex = linked ?? (scene.extractionIndex === undefined ? bySceneNo.get(String(scene.sceneNo ?? '')) ?? null : null);
    const card = {...scene, cast: list(scene.cast), checked: list(scene.checked).filter((key) => FIELD_KEYS.includes(key)), extractionIndex};
    delete card.sourceIndex;
    const extracted = extractedScene(card, extraction);
    return {...card, reviewNotes: Array.isArray(extracted?.reviewNotes) ? extracted.reviewNotes : []};
  });
}

// 項目の印の状態: none（印なし）・open（まだ確かめていない）・checked（確かめた）・edited（人が直した）
export function markState(card, key, extraction) {
  const extracted = extractedScene(card, extraction);
  if (!extracted || !isMarked(extracted.fields?.[key])) return 'none';
  if (!sameValue(key, card[key], extracted[key])) return 'edited';
  return list(card.checked).includes(key) ? 'checked' : 'open';
}

// まだ確かめていない印。承認の前に0件にする
export function openMarks(cards, extraction) {
  const out = [];
  (cards || []).forEach((card, cardIndex) => {
    const extracted = extractedScene(card, extraction);
    for (const key of markedFields(extracted)) {
      if (markState(card, key, extraction) !== 'open') continue;
      const field = extracted.fields[key];
      out.push({cardIndex, sceneNo: card.sceneNo, key, status: markKind(field.status), reason: field.reason || null});
    }
  });
  return out;
}

// 承認できるか（シーンが1件以上あり、確かめていない印が0件）
export function approvalState(cards, extraction) {
  const open = openMarks(cards, extraction);
  return {open, canApprove: (cards || []).length > 0 && open.length === 0};
}

// 印の数（読み取りが付けた印の内訳と、まだ確かめていない数）
export function markCounts(cards, extraction) {
  const counts = {inferred: 0, missing: 0, open: 0, resolved: 0};
  (cards || []).forEach((card) => {
    const extracted = extractedScene(card, extraction);
    for (const key of markedFields(extracted)) {
      counts[markKind(extracted.fields[key].status)] += 1;
      if (markState(card, key, extraction) === 'open') counts.open += 1;
      else counts.resolved += 1;
    }
  });
  return counts;
}

// 確かめた印を付ける・外す（状態の表示とは別の操作にする）
export function setChecked(card, key, on) {
  const checked = new Set(list(card.checked));
  if (on) checked.add(key);
  else checked.delete(key);
  return {...card, checked: FIELD_KEYS.filter((name) => checked.has(name))};
}

// 項目を直す。直したら、その項目の「確かめた」は外す（直した値そのものが人の確かめになる）
export function editCard(card, key, value) {
  return setChecked({...card, [key]: value}, key, false);
}

// 保存する版（PUT /api/workflow/scripts/:id/review の scenes）。読み取りとの結び付きと確かめた項目を残す（FR-PROD-STRUCT-008）
export function reviewPayload(cards) {
  return (cards || []).map((card) => ({
    sceneNo: card.sceneNo,
    location: card.location,
    dayNight: card.dayNight || null,
    cast: list(card.cast),
    synopsis: card.synopsis ?? '',
    estimatedMinutes: card.estimatedMinutes === '' ? null : card.estimatedMinutes ?? null,
    pageEighths: card.pageEighths === '' ? null : card.pageEighths ?? null,
    extractionIndex: Number.isSafeInteger(card.extractionIndex) ? card.extractionIndex : null,
    checked: list(card.checked).filter((key) => FIELD_KEYS.includes(key)),
  }));
}

// 受け口が保存の前に数える、確かめていない印（シーン番号と項目）。読み取りと結び付かないシーンは数えない
export function uncheckedMarks(extraction, scenes) {
  return openMarks(scenes, extraction).map(({sceneNo, key}) => ({sceneNo, field: key}));
}

const validBox = (box) => Boolean(box) && ['left', 'top', 'width', 'height'].every((key) => Number.isFinite(box[key]) && box[key] >= 0 && box[key] <= 1);

// 頁（1から数える）に描く柱の枠。tone は open（確かめていない印がある）・done（印をすべて確かめた）・read（印なし）
export function pageBoxes(cards, extraction, page) {
  const out = [];
  (cards || []).forEach((card, cardIndex) => {
    const extracted = extractedScene(card, extraction);
    const source = extracted?.source;
    if (!source || source.page !== page || !validBox(source.box)) return;
    const states = markedFields(extracted).map((key) => markState(card, key, extraction));
    const tone = states.includes('open') ? 'open' : states.length ? 'done' : 'read';
    out.push({cardIndex, sceneNo: card.sceneNo, box: source.box, tone});
  });
  return out;
}

// カードが原本のどの頁にあるか（無ければ null）
export function cardPage(card, extraction) {
  const page = extractedScene(card, extraction)?.source?.page;
  return Number.isSafeInteger(page) && page > 0 ? page : null;
}

// 頁ごとのシーンの数と、確かめていない印の数（頁の一覧に出す）
export function pageSummary(cards, extraction, pageCount) {
  const pages = Array.from({length: Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 0}, (_, index) => ({page: index + 1, scenes: 0, open: 0}));
  (cards || []).forEach((card) => {
    const page = cardPage(card, extraction);
    if (!page || page > pages.length) return;
    pages[page - 1].scenes += 1;
    pages[page - 1].open += markedFields(extractedScene(card, extraction)).filter((key) => markState(card, key, extraction) === 'open').length;
  });
  return pages;
}

// 読み取りが当てた変換の決まり（scriptMeta.rulesApplied）。数の無いものと形の崩れたものは出さない
export function appliedRules(extraction) {
  const rules = extraction?.scriptMeta?.rulesApplied;
  return Array.isArray(rules) ? rules.filter((rule) => rule && typeof rule.label === 'string' && Number.isSafeInteger(rule.count) && rule.count > 0) : [];
}

// この読み取りが出どころを持っているか（前の読み取りで読んだ原本は false）
export function hasProvenance(extraction) {
  return (extraction?.scenes || []).some((scene) => scene && typeof scene.fields === 'object' && scene.fields !== null);
}
