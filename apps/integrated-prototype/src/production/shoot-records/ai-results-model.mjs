// 撮影の結果を AI が入れるときの判定（会社ルートの plans/2026-11-20-genba-inbox.md の手順7。決まりは brain の D-047 の3・4・7。
// 要件 docs/requirements/production/schedule-commit.md の FR-PROD-SCHED-103〜）。DB を読まない純関数だけを置く。
// - 「撮れた」にする条件は、独立した2回の読みの一致。2回のモデルの名前が同じ束は、独立した読みでないので束ごと断る
// - 一致した行だけ結果を入れ、割れた行（違う・どちらかが読めず）は入れずに人に聞く（要確認）
// - 読みの結果 → 撮影の結果: shot → shot、partial → partial、not_shot → 移し先の無い postponed（未解決に「移先未定」で残る）

export const READINGS = Object.freeze(['shot', 'partial', 'not_shot', 'unreadable']);
// 札（1〜4字。見た目の決まり docs/design/integrated-system-visual.md §1）
export const READING_LABELS = Object.freeze({shot: '撮れた', partial: '一部', not_shot: '撮れず', unreadable: '読めず'});
export const READING_TO_RESULT = Object.freeze({shot: 'shot', partial: 'partial', not_shot: 'postponed'});
// 1回に送れるシーンの数（D1 の1回の batch の文の数に収まる大きさ。src/d1-limits.mjs）
export const MAX_AI_SCENES = 200;
export const MAX_MODEL_LENGTH = 100;
export const READ_KEY_PATTERN = /^[A-Za-z0-9\-_.:]{1,100}$/;
// 呼び出しの経路の印（identity.via。FR-CORE-DATA-066）のうち、サービストークン（AI）の呼び出し
export const SERVICE_TOKEN_VIA = 'service_token';
// AI が1回の読みで入れてはいけない結果（いまの結果の受け口でサービストークンの呼び出しを断る）
const TWO_READS_ONLY = new Set(['shot', 'partial']);
export const TWO_READS_REQUIRED = 'AI は撮れた・一部を2回の読みの受け口から入れます';

// いまの結果の受け口（POST …/days/:dayId/results）で、サービストークンの呼び出しが撮れた・一部を入れようとしたときの断りの文。通すなら null。
// 順延・欠番は通す（代表が会話で指示したものを Claude が入れる）。人のログイン（access）と印の無い呼び出しは今までどおり
export const serviceTokenResultError = (result, via) => (via === SERVICE_TOKEN_VIA && TWO_READS_ONLY.has(result) ? TWO_READS_REQUIRED : null);

// モデルの名前が同じか（前後の空白と大文字・小文字の違いは同じとみる。DB のトリガーと同じ見方）
export const sameModel = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// 正の整数の番号（数か数字だけの文字）。ほかは null
const positiveId = (value) => ((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null);

function normalizeRead(raw, field, errors, scene) {
  if (!isObject(raw)) {
    errors.push({scene, field, message: field === 'second' ? '2回目の読みがありません（1回の読みでは入れません）' : '1回目の読みがありません'});
    return null;
  }
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model || model.length > MAX_MODEL_LENGTH) errors.push({scene, field: `${field}.model`, message: `読んだモデルの名前を1〜${MAX_MODEL_LENGTH}字で入れてください`});
  if (!READINGS.includes(raw.reading)) errors.push({scene, field: `${field}.reading`, message: '読んだ結果は shot・partial・not_shot・unreadable のどれかです'});
  return {model, reading: raw.reading};
}

// 受け口の本文: {readKey?, sourceDocumentId?, scenes: [{sceneId, first: {model, reading}, second: {model, reading}}]}（scenes は1〜200）。
// 誤りがあれば ok は偽で、誤り（scene は scenes の位置）を返す。受け口は誤りが1つでもあれば何も書かない
export function normalizeAiResultsInput(raw) {
  const src = isObject(raw) ? raw : {};
  const errors = [];
  let readKey = null;
  if (src.readKey !== undefined && src.readKey !== null) {
    if (typeof src.readKey !== 'string' || !READ_KEY_PATTERN.test(src.readKey)) errors.push({scene: null, field: 'readKey', message: '束の鍵は英数字と - _ . : の1〜100字です'});
    else readKey = src.readKey;
  }
  let sourceDocumentId = null;
  if (src.sourceDocumentId !== undefined && src.sourceDocumentId !== null) {
    sourceDocumentId = positiveId(src.sourceDocumentId);
    if (sourceDocumentId === null) errors.push({scene: null, field: 'sourceDocumentId', message: '香盤の原本の番号を確かめてください'});
  }
  if (!Array.isArray(src.scenes) || src.scenes.length < 1 || src.scenes.length > MAX_AI_SCENES) {
    errors.push({scene: null, field: 'scenes', message: `シーンは1〜${MAX_AI_SCENES}件の配列で送ってください`});
    return {ok: false, value: null, errors};
  }
  const scenes = [];
  const seen = new Map();
  for (const [index, item] of src.scenes.entries()) {
    const entry = isObject(item) ? item : {};
    const sceneId = positiveId(entry.sceneId);
    if (sceneId === null) errors.push({scene: index, field: 'sceneId', message: 'シーンの番号を確かめてください'});
    else if (seen.has(sceneId)) errors.push({scene: index, field: 'sceneId', message: `シーンが ${seen.get(sceneId)} 件目と重なっています`});
    else seen.set(sceneId, index);
    const first = normalizeRead(entry.first, 'first', errors, index);
    const second = normalizeRead(entry.second, 'second', errors, index);
    if (first && second && first.model && second.model && sameModel(first.model, second.model)) {
      errors.push({scene: index, field: 'second.model', message: '2回の読みのモデルが同じです（独立した読みでないので、この束は入れません）'});
    }
    scenes.push({sceneId, first, second});
  }
  return errors.length ? {ok: false, value: null, errors} : {ok: true, value: {readKey, sourceDocumentId, scenes}, errors: []};
}

// 2回の読みの突き合わせ。一致は、2回とも同じ結果で読めず でないとき。モデルが同じなら投げる（呼ぶ前に normalizeAiResultsInput が断る）
export function compareReads(first, second) {
  if (sameModel(first.model, second.model)) throw new Error('2回の読みのモデルが同じです');
  const agreed = first.reading === second.reading && first.reading !== 'unreadable';
  return {agreed, reading: agreed ? first.reading : null, result: agreed ? READING_TO_RESULT[first.reading] : null};
}

// シーンごとに突き合わせ、入れる行（agreed: sceneId・読み・撮影の結果）と割れた行（split: sceneId・2回の読み）に分ける
export function planAiResults(scenes) {
  const agreed = [], split = [];
  for (const scene of scenes) {
    const compared = compareReads(scene.first, scene.second);
    if (compared.agreed) agreed.push({sceneId: scene.sceneId, reading: compared.reading, result: compared.result});
    else split.push({sceneId: scene.sceneId, first: scene.first, second: scene.second});
  }
  return {agreed, split};
}

// 要確認（割れた読み）の導き方。reads は読みの記録の行（id・work_id・shooting_day_id・scene_id・read_key・read_no・model・reading・prior_result_seq・
// source_document_id・created_at と、撮影日の shoot_date・シーンの scene_no・location）、results は同じ撮影日×シーンの結果の行（shooting_day_id・
// scene_id・seq と、結びの鍵 ai_read_key。結びの無い行が人の結果）。
// 撮影日×シーンごとに、いちばん新しい読みの束（番号の最も大きい読みの行の鍵）が割れていて、その束を入れたあとに人の結果の行が無いものを返す
export function derivePendingReads({reads, results}) {
  const key = (dayId, sceneId) => `${Number(dayId)}:${Number(sceneId)}`;
  const newest = new Map();
  for (const row of reads) {
    const at = key(row.shooting_day_id, row.scene_id), seen = newest.get(at);
    if (!seen || Number(row.id) > Number(seen.id)) newest.set(at, row);
  }
  const humanAfter = new Map();
  for (const row of results) {
    if (row.ai_read_key != null) continue;
    const at = key(row.shooting_day_id, row.scene_id);
    humanAfter.set(at, Math.max(humanAfter.get(at) ?? 0, Number(row.seq)));
  }
  const rows = [];
  for (const [at, latest] of newest) {
    const bundle = reads.filter((row) => key(row.shooting_day_id, row.scene_id) === at && row.read_key === latest.read_key);
    const first = bundle.find((row) => Number(row.read_no) === 1), second = bundle.find((row) => Number(row.read_no) === 2);
    if (first && second && first.reading === second.reading && first.reading !== 'unreadable') continue;
    const prior = Math.min(...bundle.map((row) => Number(row.prior_result_seq)));
    if ((humanAfter.get(at) ?? 0) > prior) continue;
    const read = (row) => (row ? {model: row.model, reading: row.reading, label: READING_LABELS[row.reading]} : null);
    rows.push({workId: Number(latest.work_id), dayId: Number(latest.shooting_day_id), shootDate: latest.shoot_date, sceneId: Number(latest.scene_id),
      sceneNo: latest.scene_no, location: latest.location ?? null, readKey: latest.read_key,
      sourceDocumentId: latest.source_document_id == null ? null : Number(latest.source_document_id), readAt: latest.created_at, first: read(first), second: read(second)});
  }
  return rows.sort((a, b) => String(a.shootDate).localeCompare(String(b.shootDate)) || a.dayId - b.dayId
    || String(a.sceneNo).localeCompare(String(b.sceneNo), 'ja', {numeric: true}) || a.sceneId - b.sceneId);
}
