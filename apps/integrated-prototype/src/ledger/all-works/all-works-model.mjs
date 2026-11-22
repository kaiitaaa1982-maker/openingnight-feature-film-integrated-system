// 全案件の画面（作品を選ばずに、全作品の行を1つの表で見る）の計算。引数の検査・行の形・並べ方・ページ送りを持つ。
// DB と時刻を読まない。「今日」は受け口から受け取る。

// 種類。順は表で同じ日付の行を並べる順と、画面の札の順
export const ACTIVITY_KINDS = Object.freeze(['schedule', 'expense', 'script']);
export const ACTIVITY_KIND_LABELS = Object.freeze({schedule: '日々スケ', expense: '経費', script: '台本'});
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 200;
export const MAX_OFFSET = 10000;
// 作品の絞り込みの数の上限（D1 の1つの問い合わせの値の上限100個に掛からないようにする）
export const MAX_WORK_FILTER = 50;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value) => DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export class ActivityQueryError extends Error {}

const list = (values) => (values || []).flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);

function wholeNumber(raw, name, {min, max, fallback}) {
  if (raw == null || raw === '') return fallback;
  if (!/^\d+$/.test(String(raw))) throw new ActivityQueryError(`${name}を確かめてください`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ActivityQueryError(`${name}は${min}から${max}までです`);
  return value;
}

// 引数を読む。query は {work_id: [...], kind: [...], from, to, limit, offset}（同じ名前を重ねても、カンマで区切ってもよい）
export function parseActivityQuery(query = {}) {
  const workIds = [...new Set(list(query.work_id).map((raw) => {
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) throw new ActivityQueryError('作品の番号を確かめてください');
    return Number(raw);
  }))];
  if (workIds.length > MAX_WORK_FILTER) throw new ActivityQueryError(`作品の絞り込みは${MAX_WORK_FILTER}件までです`);
  const kinds = [...new Set(list(query.kind))];
  for (const kind of kinds) if (!ACTIVITY_KINDS.includes(kind)) throw new ActivityQueryError('種類を確かめてください');
  const from = query.from || null;
  const to = query.to || null;
  for (const value of [from, to]) if (value != null && !validDate(value)) throw new ActivityQueryError('日付は YYYY-MM-DD で指定してください');
  if (from && to && from > to) throw new ActivityQueryError('開始の日付が終わりの日付より後です');
  return {
    workIds,
    kinds: kinds.length ? ACTIVITY_KINDS.filter((kind) => kinds.includes(kind)) : [...ACTIVITY_KINDS],
    from,
    to,
    limit: wholeNumber(query.limit, '件数', {min: 1, max: MAX_LIMIT, fallback: DEFAULT_LIMIT}),
    offset: wholeNumber(query.offset, '開始の位置', {min: 0, max: MAX_OFFSET, fallback: 0}),
  };
}

const text = (value) => (value == null ? '' : String(value).trim());
const joinParts = (parts) => parts.map(text).filter(Boolean).join('　');

// 撮影日の状態。過ぎた日は済み、今日はいま、先は予定
function scheduleStatus(date, today) {
  if (date < today) return '済み';
  if (date === today) return 'いま';
  return '予定';
}

// 種類ごとに読んだ行を、画面の1行の形にする。works は見てよい作品（id・code・title）
export function activityRows({schedule = [], expenses = [], scripts = [], works = [], today}) {
  const byId = new Map(works.map((work) => [Number(work.id), {id: Number(work.id), code: work.code, title: work.title}]));
  const rows = [];
  const push = (kind, source, row) => {
    const work = byId.get(Number(source.work_id));
    if (!work) return; // 見てよい作品の行だけ（読み取りでも絞っているが、ここでも外す）
    rows.push({key: `${kind}:${source.id}`, id: Number(source.id), kind, kindLabel: ACTIVITY_KIND_LABELS[kind], work, ...row,
      open: {...row.open, workId: work.id}});
  };
  for (const day of schedule) {
    push('schedule', day, {
      date: day.date,
      summary: joinParts([day.label, day.unit, day.call_time ? `入り ${day.call_time}` : '']),
      status: scheduleStatus(day.date, today),
      attention: false,
      amount: null,
      open: {page: '制作', params: {tab: 'day', day: String(day.id)}},
    });
  }
  for (const expense of expenses) {
    const ready = Number(expense.ready) === 1;
    push('expense', expense, {
      date: expense.date,
      summary: joinParts([expense.category, expense.description]),
      status: ready ? '計上' : '未整備',
      attention: false,
      amount: expense.amount == null ? null : Number(expense.amount),
      open: {page: '経費', params: {}},
    });
  }
  for (const script of scripts) {
    const committed = Number(script.committed) === 1;
    push('script', script, {
      date: script.date,
      summary: text(script.file_name),
      status: committed ? '確定' : '要確認',
      attention: !committed,
      amount: null,
      open: {page: '台本・香盤', params: {}},
    });
  }
  return rows;
}

const KIND_ORDER = new Map(ACTIVITY_KINDS.map((kind, index) => [kind, index]));

// 新しい日付が上。同じ日は種類の順、同じ種類は新しく登録した行（番号の大きい行）が上
export function compareActivity(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.kind !== b.kind) return KIND_ORDER.get(a.kind) - KIND_ORDER.get(b.kind);
  return b.id - a.id;
}

// 並べてページを切り出す。rows は種類ごとに先頭から offset+limit+1 件まで読んだもの（それ以上先の行はこのページに入らない）
export function pageActivity(rows, {offset = 0, limit = DEFAULT_LIMIT} = {}) {
  const sorted = [...rows].sort(compareActivity);
  const page = sorted.slice(offset, offset + limit);
  return {rows: page, nextOffset: sorted.length > offset + limit ? offset + limit : null};
}
