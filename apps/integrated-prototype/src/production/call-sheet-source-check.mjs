// 日々スケを表に起こした JSON を、取り込む前に確かめる純関数（会社ルートの plans/2026-11-06-r2-ingest.md の C）。
// 流れは「PDF → Claude が JSON に起こす → ここで形と中の食い違いを確かめる → 受け口に入れる」。AI を使わず決まりだけで判定する。
// 入れたあとの制作情報（入り・支度完了・バラしとシーン）の矛盾は call-sheet-check.mjs が見る。こちらは入れる前の JSON だけを見る。
// 形の見本は demo-fixtures/call-sheets/call-sheets-demo.json（架空）。
// 返すのは問題の一覧 [{sheet, row, field, message}]。sheet は file 名（無ければ「n枚目」）、row は 1 から数えた行の番号（rows は「n行目」、calls は「入りn」）。

export const SLOT_KINDS = Object.freeze(['move', 'meal', 'wrap', 'prep', 'other']);
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WORK_FIELDS = ['projectCode', 'projectTitle', 'workCode', 'workTitle', 'unit'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isClock = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const absent = (value) => value === undefined || value === null;

// YYYY-MM-DD で、暦に実在する日
export function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export const weekdayOf = (value) => WEEKDAYS[new Date(`${value}T00:00:00Z`).getUTCDay()];

export function formatProblem({sheet, row, field, message}) {
  const where = [sheet, row, field].filter(Boolean).join(' ');
  return where ? `${where}: ${message}` : message;
}

export function checkCallSheetJson(source) {
  const problems = [];
  const add = (sheet, row, field, message) => problems.push({sheet: sheet ?? null, row: row ?? null, field: field ?? null, message});
  if (!isObject(source)) { add(null, null, null, 'JSON の一番外はオブジェクトにする'); return problems; }

  // 作品
  if (!isObject(source.work)) add(null, null, 'work', 'work（案件・作品・班）がない');
  else for (const field of WORK_FIELDS) if (!isText(source.work[field])) add(null, null, `work.${field}`, '空でない文字にする');

  // 役・グループ・ロケ地
  const characterKeys = new Set();
  if (!Array.isArray(source.characters)) add(null, null, 'characters', 'characters（役）の配列がない');
  else source.characters.forEach((c, index) => {
    const field = `characters[${index + 1}]`;
    if (!isObject(c)) { add(null, null, field, 'オブジェクトにする'); return; }
    if (!isText(c.key)) add(null, null, `${field}.key`, '空でない文字にする');
    else if (characterKeys.has(c.key)) add(null, null, `${field}.key`, `役 ${c.key} が2つある`);
    else characterKeys.add(c.key);
    if (!isText(c.name)) add(null, null, `${field}.name`, '空でない文字にする');
    for (const key of ['short', 'actor', 'group', 'note']) if (!absent(c[key]) && typeof c[key] !== 'string') add(null, null, `${field}.${key}`, '文字か null にする');
  });
  const groupNames = new Set();
  if (!absent(source.groups) && !isObject(source.groups)) add(null, null, 'groups', 'groups は {グループ名: [役]} にする');
  else for (const [name, members] of Object.entries(source.groups || {})) {
    groupNames.add(name);
    if (!Array.isArray(members) || !members.length) { add(null, null, `groups.${name}`, '役の配列（1人以上）にする'); continue; }
    for (const key of members) if (!characterKeys.has(key)) add(null, null, `groups.${name}`, `役 ${key} が characters にない`);
  }
  const locationKeys = new Set();
  if (!Array.isArray(source.locations) || !source.locations.length) add(null, null, 'locations', 'locations（ロケ地）を1つ以上にする');
  else source.locations.forEach((l, index) => {
    const field = `locations[${index + 1}]`;
    if (!isObject(l)) { add(null, null, field, 'オブジェクトにする'); return; }
    if (!isText(l.key)) add(null, null, `${field}.key`, '空でない文字にする');
    else if (locationKeys.has(l.key)) add(null, null, `${field}.key`, `ロケ地 ${l.key} が2つある`);
    else locationKeys.add(l.key);
    if (!isText(l.name)) add(null, null, `${field}.name`, '空でない文字にする');
  });

  // cast・who のキー（役か @グループ）
  const checkKeys = (sheet, row, field, keys) => {
    if (!Array.isArray(keys)) { add(sheet, row, field, '役の配列にする'); return; }
    for (const key of keys) {
      if (typeof key !== 'string' || !key) add(sheet, row, field, '役のキーは空でない文字にする');
      else if (key.startsWith('@') ? !groupNames.has(key.slice(1)) : !characterKeys.has(key)) add(sheet, row, field, `役 ${key} が characters・groups にない`);
    }
  };
  const checkClocks = (sheet, row, item) => {
    for (const field of ['start', 'end']) if (!absent(item[field]) && !isClock(item[field])) add(sheet, row, field, `時刻 ${JSON.stringify(item[field])} は HH:MM（00:00〜23:59）にする`);
    if (isClock(item.start) && isClock(item.end) && item.end <= item.start) add(sheet, row, 'end', `終わり ${item.end} が始まり ${item.start} より前か同じ`);
  };
  const checkSceneNos = (sheet, row, s) => {
    if (!Array.isArray(s) || !s.length) { add(sheet, row, 's', 'S# を1つ以上の配列にする'); return []; }
    if (s.some((no) => !isText(no))) { add(sheet, row, 's', 'S# は空でない文字にする'); return []; }
    return s;
  };

  if (!Array.isArray(source.sheets) || !source.sheets.length) { add(null, null, 'sheets', 'sheets（日々スケ）を1枚以上にする'); return problems; }
  const files = new Map(), versions = new Map();
  source.sheets.forEach((sheet, index) => {
    const name = isObject(sheet) && isText(sheet.file) ? sheet.file : `${index + 1}枚目`;
    if (!isObject(sheet)) { add(name, null, null, 'オブジェクトにする'); return; }
    if (!isText(sheet.file)) add(name, null, 'file', '原本の PDF のファイル名を入れる');
    else if (!/\.pdf$/i.test(sheet.file)) add(name, null, 'file', 'ファイル名は .pdf で終える');
    else if (files.has(sheet.file)) add(name, null, 'file', `ファイル名が ${files.get(sheet.file)} 枚目と同じ`);
    else files.set(sheet.file, index + 1);
    if (!absent(sheet.originPath) && typeof sheet.originPath !== 'string') add(name, null, 'originPath', '文字にする');
    if (!isText(sheet.stamp)) add(name, null, 'stamp', '版の印（仮・決など）を入れる');
    if (!isText(sheet.crew)) add(name, null, 'crew', '班を入れる');
    if (!isRealDate(sheet.date)) add(name, null, 'date', `日付 ${JSON.stringify(sheet.date)} は実在する YYYY-MM-DD にする`);
    else {
      if (sheet.weekday !== weekdayOf(sheet.date)) add(name, null, 'weekday', `曜日 ${JSON.stringify(sheet.weekday)} が ${sheet.date}（${weekdayOf(sheet.date)}）と合わない`);
      if (isText(sheet.stamp)) {
        const version = `${sheet.date}\u0000${sheet.stamp}`;
        if (versions.has(version)) add(name, null, 'stamp', `${sheet.date} の「${sheet.stamp}」が ${versions.get(version)} と2つある`);
        else versions.set(version, name);
      }
    }
    for (const field of ['sunrise', 'sunset']) if (!absent(sheet[field]) && !isClock(sheet[field])) add(name, null, field, `時刻 ${JSON.stringify(sheet[field])} は HH:MM（00:00〜23:59）にする`);
    if (absent(sheet.sunrise) !== absent(sheet.sunset)) add(name, null, 'sunset', '日の出と日の入りはそろえて入れる');
    for (const field of ['weather', 'departure', 'state']) if (!absent(sheet[field]) && typeof sheet[field] !== 'string') add(name, null, field, '文字にする');
    if (!absent(sheet.notes) && (!Array.isArray(sheet.notes) || sheet.notes.some((n) => typeof n !== 'string'))) add(name, null, 'notes', '文字の配列にする');

    if (!Array.isArray(sheet.rows)) add(name, null, 'rows', '行の配列にする');
    else {
      const seen = new Map();
      sheet.rows.forEach((row, rowIndex) => {
        const at = `${rowIndex + 1}行目`;
        if (!isObject(row)) { add(name, at, null, 'オブジェクトにする'); return; }
        const isSlot = !absent(row.slot), isAgain = !absent(row.again), hasScenes = !absent(row.s);
        if (isSlot && (isAgain || hasScenes)) { add(name, at, null, 'シーンの行・帯（slot）・2回目（again）のどれか1つにする'); return; }
        if (!isSlot && !isAgain && !hasScenes) { add(name, at, null, 'シーンの行（s）・帯（slot）・2回目（again）のどれでもない'); return; }
        checkClocks(name, at, row);
        if (isSlot) {
          if (!SLOT_KINDS.includes(row.slot)) add(name, at, 'slot', `帯の種類 ${JSON.stringify(row.slot)} は ${SLOT_KINDS.join('・')} のどれかにする`);
          if (!isText(row.label)) add(name, at, 'label', '帯の名前を入れる');
          return;
        }
        const sceneNos = checkSceneNos(name, at, row.s);
        if (!absent(row.cast)) checkKeys(name, at, 'cast', row.cast);
        if (isAgain) {
          if (row.again !== true) add(name, at, 'again', 'true にする');
          if (!isText(row.label)) add(name, at, 'label', '2回目の帯の名前を入れる');
          return;
        }
        if (!absent(row.pages) && (typeof row.pages !== 'number' || !Number.isFinite(row.pages) || row.pages < 0)) add(name, at, 'pages', '頁数は 0 以上の数か null にする');
        for (const field of ['dn', 'dnLabel', 'head', 'synopsis', 'team', 'note']) if (!absent(row[field]) && typeof row[field] !== 'string') add(name, at, field, '文字か null にする');
        for (const no of sceneNos) {
          if (seen.has(no)) add(name, at, 's', `S#${no} が ${seen.get(no)} と重なる（同じ日に同じシーンは1回。2回目は again にする）`);
          else seen.set(no, at);
        }
      });
    }

    if (!Array.isArray(sheet.calls)) add(name, null, 'calls', '入り時間の配列にする（無ければ []）');
    else sheet.calls.forEach((entry, callIndex) => {
      const at = `入り${callIndex + 1}`;
      if (!isObject(entry)) { add(name, at, null, 'オブジェクトにする'); return; }
      if (!Array.isArray(entry.who) || !entry.who.length) add(name, at, 'who', '役を1つ以上の配列にする');
      else checkKeys(name, at, 'who', entry.who);
      if (!absent(entry.time) && !isClock(entry.time)) add(name, at, 'time', `時刻 ${JSON.stringify(entry.time)} は HH:MM（00:00〜23:59）にする`);
      if (!absent(entry.ready) && typeof entry.ready !== 'boolean') add(name, at, 'ready', 'true か false にする');
      if (!absent(entry.place) && !locationKeys.has(entry.place)) add(name, at, 'place', `ロケ地 ${entry.place} が locations にない`);
      for (const field of ['label', 'placeNote', 'note']) if (!absent(entry[field]) && typeof entry[field] !== 'string') add(name, at, field, '文字か null にする');
    });
  });
  return problems;
}

// 問題があれば投げる（一覧を全部メッセージに入れる）。取り込みの先頭で呼び、何も書かずに止める
export function assertCallSheetJson(source) {
  const problems = checkCallSheetJson(source);
  if (problems.length) {
    const error = new Error(`日々スケの JSON に ${problems.length} 件の問題があるので取り込まない:\n${problems.map((p) => `- ${formatProblem(p)}`).join('\n')}`);
    error.problems = problems;
    throw error;
  }
}
