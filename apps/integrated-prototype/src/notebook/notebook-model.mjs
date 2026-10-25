// 現場の連絡帳の型（定型の連絡）とデザイン。純関数（会社ルートの plans/2026-10-22-folder-preprod.md「現場の連絡帳」。調整役の X-23）。
// 型はコードに持つ（第一版）。欄の値は制作の表（GET /api/production）から入れられるものを入れ、人が直す。

export const NOTEBOOK_TEMPLATES = Object.freeze([
  Object.freeze({id: 'daily', label: '日々スケのお知らせ', needsAck: true, fields: ['撮影日', '集合', '撮影するシーン', 'ロケ地と控室', '持ち物・注意'],
    phrases: ['雨天の場合は予備日に順延します', '車での来場は控えてください', '夜の撮影があります。防寒をお願いします']}),
  Object.freeze({id: 'change', label: '香盤の変更', needsAck: true, fields: ['変わったこと', '影響のある部署', 'ひとこと'],
    phrases: ['変更により準備が必要な部署は返信してください', '前の版の香盤は破棄してください']}),
  Object.freeze({id: 'fitting', label: '衣装合わせの案内', needsAck: false, fields: ['役', 'ルック', '日時', '場所'],
    phrases: ['靴も合わせます', '髪型の確認も同時に行います']}),
  Object.freeze({id: 'location', label: 'ロケ地の案内', needsAck: false, fields: ['ロケ地', '住所', '控室・駐車場', '注意'],
    phrases: ['近隣に配慮し、大声を控えてください', '喫煙は指定の場所でお願いします']}),
  Object.freeze({id: 'call', label: '入り時間のお知らせ', needsAck: true, fields: ['撮影日', '出演者と入り', 'ひとこと'],
    phrases: ['入りが変わった場合は制作部へ連絡してください']}),
  Object.freeze({id: 'free', label: '自由な連絡', needsAck: false, fields: [], phrases: []}),
]);
export const NOTEBOOK_DESIGNS = Object.freeze({simple: 'シンプル', table: '表つき', print: '印刷用 A4'});
export const DEFAULT_SPACES = Object.freeze(['全体', '演出部', '制作部', '撮影部・照明部', '録音部', '美術部', '衣装・メイク']);

export const templateOf = (id) => NOTEBOOK_TEMPLATES.find((t) => t.id === id) || NOTEBOOK_TEMPLATES[NOTEBOOK_TEMPLATES.length - 1];
const md = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '');
const hm = (t) => (t ? t.slice(11, 16) : '');
// 班の名前は「A班」で入っていることも「A」で入っていることもある
export const unitLabel = (unit) => (/班$/.test(String(unit || '')) ? unit : `${unit}班`);

// 制作の表から欄の値を入れる。choice は {dayId} か {locationKey}。入れた欄は system: true（画面で「システムから」と示す）
export function fillFields(templateId, production, choice = {}) {
  const t = templateOf(templateId);
  const blank = t.fields.map((label) => ({label, value: '', system: false}));
  const days = production?.days || [];
  const scenes = new Map((production?.scenes || []).map((s) => [s.id, s]));
  const locs = new Map((production?.locations || []).map((l) => [l.key, l]));
  const chars = new Map((production?.characters || []).map((c) => [c.key, c]));
  const set = (label, value) => { const f = blank.find((x) => x.label === label); if (f && value) { f.value = value; f.system = true; } };
  if (templateId === 'daily' || templateId === 'call') {
    const day = days.find((d) => d.id === Number(choice.dayId));
    if (day) {
      set('撮影日', `${md(day.shoot_date)} ${unitLabel(day.unit)} ${day.label || ''}`.trim());
      const items = (day.assignments || []).slice().sort((a, b) => a.sequence_order - b.sequence_order);
      set('撮影するシーン', items.map((a) => `S#${scenes.get(a.scene_id)?.scene_no}`).join('・'));
      const first = items.find((a) => a.planned_start);
      if (first) set('集合', hm(first.planned_start));
      const loc = [...new Set(items.map((a) => scenes.get(a.scene_id)?.location_key).filter(Boolean))].map((k) => locs.get(k)).filter(Boolean);
      set('ロケ地と控室', loc.map((l) => `${l.name}${l.green_room ? `（控室: ${l.green_room}）` : ''}`).join('・'));
      const calls = (production?.calls || []).filter((c) => c.day_id === day.id && c.call_time);
      set('出演者と入り', calls.map((c) => `${chars.get(c.character_key)?.name || c.character_key} ${hm(c.call_time)}${c.ready_time ? `（準備完了 ${hm(c.ready_time)}）` : ''}`).join('／'));
    }
  }
  if (templateId === 'location') {
    const l = locs.get(choice.locationKey);
    if (l) { set('ロケ地', l.name); set('住所', l.address); set('控室・駐車場', [l.green_room, l.parking].filter(Boolean).join('／')); }
  }
  return blank;
}

// 題の既定（型の名前と、日々スケ・入りなら撮影日）
export function defaultTitle(templateId, fields) {
  const t = templateOf(templateId);
  const day = fields.find((f) => f.label === '撮影日')?.value;
  return day ? `${day} ${t.label}` : t.label;
}

// 1つのスペースの連絡を、新しい順に。訂正された連絡は「訂正あり」として残す（消さない）
export function threadView(posts, receipts, userId) {
  const corrected = new Set(posts.filter((p) => p.corrects_post_id).map((p) => p.corrects_post_id));
  return posts.slice().sort((a, b) => b.id - a.id).map((p) => {
    const mine = receipts.filter((r) => r.post_id === p.id);
    return {...p, corrected: corrected.has(p.id), reads: mine.filter((r) => r.kind === 'read').length, acks: mine.filter((r) => r.kind === 'ack').length,
      readByMe: mine.some((r) => r.kind === 'read' && r.user_id === userId), ackedByMe: mine.some((r) => r.kind === 'ack' && r.user_id === userId)};
  });
}
