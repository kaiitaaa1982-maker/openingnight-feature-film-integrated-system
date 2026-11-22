// 香盤の読みの記録と、撮影の結果の行と読みの束の結びの DB の読み書き（移行 0069 の2表。番号は仮）。表の持ち主はプロダクション。
// AI が入れる撮影の結果（shooting_scene_results。移行 0051）も、読みの記録・結びと同じ batch で足す。
// 行は表ごとに複数行の INSERT にまとめ、1文の値を D1 の上限（100個）より少なく分ける。書くたびに同じ batch で audit_log に1行残す（読みの中身は残さない）
const AUDIT_INSERT = 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)';
const VALUES_PER_STATEMENT = 84;

// 複数行の INSERT を、1文の値が VALUES_PER_STATEMENT 以下になるように分ける。row(item) は [値…] と、行ごとの値の並び（'(?,?,…)'）を返す
function insertChunks(prefix, items, width, tuple, row) {
  const size = Math.max(1, Math.floor(VALUES_PER_STATEMENT / width));
  const statements = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const chunk = items.slice(offset, offset + size);
    statements.push({sql: `${prefix} VALUES ${chunk.map(() => tuple).join(',')}`, params: chunk.flatMap(row)});
  }
  return statements;
}

// この鍵の読みがもうあるか（同じ取り込みを2回入れない）
export async function readKeyUsed(db, orgId, readKey) {
  return Boolean(await db.get('SELECT id FROM shooting_scene_reads WHERE org_id=? AND read_key=? LIMIT 1', [orgId, readKey]));
}

// 撮影日のシーンごとの結果の連番の最大（結果の無いシーンは返らない）
export async function readResultSeqs(db, orgId, dayId) {
  const rows = await db.all('SELECT scene_id,MAX(seq) AS n FROM shooting_scene_results WHERE org_id=? AND shooting_day_id=? GROUP BY scene_id', [orgId, dayId]);
  return new Map(rows.map((row) => [Number(row.scene_id), Number(row.n)]));
}

// 1回の取り込みの読みの束を入れる。scenes は全シーンの2回の読み（sceneId・first・second・priorSeq）、agreed は一致して結果を入れるシーン（sceneId・result）。
// 読みの記録（1回目をまとめて、2回目をまとめて）→ 一致した行の結果（連番は priorSeq＋1）→ 結果の行と束の結び → audit_log を1回の batch で書く
export async function addAiResults(db, {orgId, day, userId, readKey, sourceDocumentId, scenes, agreed}) {
  const readColumns = 'INSERT INTO shooting_scene_reads(org_id,project_id,work_id,shooting_day_id,scene_id,read_key,read_no,model,reading,prior_result_seq,source_document_id,created_by)';
  const readRow = (readNo) => (scene) => {
    const read = readNo === 1 ? scene.first : scene.second;
    return [orgId, day.project_id, day.work_id, day.id, scene.sceneId, readKey, readNo, read.model, read.reading, scene.priorSeq, sourceDocumentId, userId];
  };
  const priorOf = new Map(scenes.map((scene) => [scene.sceneId, scene.priorSeq]));
  const statements = [
    ...insertChunks(readColumns, scenes, 12, '(?,?,?,?,?,?,?,?,?,?,?,?)', readRow(1)),
    ...insertChunks(readColumns, scenes, 12, '(?,?,?,?,?,?,?,?,?,?,?,?)', readRow(2)),
    ...insertChunks('INSERT INTO shooting_scene_results(org_id,project_id,work_id,shooting_day_id,scene_id,seq,result,created_by)', agreed, 8, '(?,?,?,?,?,?,?,?)',
      (row) => [orgId, day.project_id, day.work_id, day.id, row.sceneId, priorOf.get(row.sceneId) + 1, row.result, userId]),
    ...insertChunks('INSERT INTO shooting_scene_result_reads(org_id,work_id,scene_id,result_id,read_key)', agreed, 8,
      '(?,?,?,(SELECT r.id FROM shooting_scene_results r WHERE r.org_id=? AND r.shooting_day_id=? AND r.scene_id=? AND r.seq=?),?)',
      (row) => [orgId, day.work_id, row.sceneId, orgId, day.id, row.sceneId, priorOf.get(row.sceneId) + 1, readKey]),
    {sql: AUDIT_INSERT, params: [orgId, userId, 'append', 'shooting_scene_ai_result', `${day.id}:${readKey}`,
      JSON.stringify({dayId: day.id, readKey, sourceDocumentId, scenes: scenes.length, added: agreed.length, split: scenes.length - agreed.length})]},
  ];
  await db.batch(statements);
}

// 要確認（割れた読み）の導き方（ai-results-model.mjs の derivePendingReads）に使う行。workId を渡せばその作品だけ、渡さなければ組織のすべての作品を2文で読む
// （ホームの作業キューは作品ごとに SQL を回さない。見てよい作品は呼ぶ側が絞る）。結果の行は、読みの記録のある撮影日×シーンのものだけ
export async function readSceneReadSources(db, orgId, workId = null) {
  const params = workId == null ? [orgId] : [orgId, workId];
  const [reads, results] = await Promise.all([
    db.all(`SELECT r.id,r.work_id,r.shooting_day_id,r.scene_id,r.read_key,r.read_no,r.model,r.reading,r.prior_result_seq,r.source_document_id,r.created_at,
      d.shoot_date,s.scene_no,s.location FROM shooting_scene_reads r
      JOIN shooting_days d ON d.org_id=r.org_id AND d.id=r.shooting_day_id JOIN scenes s ON s.org_id=r.org_id AND s.id=r.scene_id
      WHERE r.org_id=?${workId == null ? '' : ' AND r.work_id=?'} ORDER BY r.id`, params),
    db.all(`SELECT res.id,res.shooting_day_id,res.scene_id,res.seq,res.result,l.read_key AS ai_read_key FROM shooting_scene_results res
      LEFT JOIN shooting_scene_result_reads l ON l.org_id=res.org_id AND l.result_id=res.id
      WHERE res.org_id=?${workId == null ? '' : ' AND res.work_id=?'}
      AND EXISTS(SELECT 1 FROM shooting_scene_reads r WHERE r.org_id=res.org_id AND r.shooting_day_id=res.shooting_day_id AND r.scene_id=res.scene_id)
      ORDER BY res.shooting_day_id,res.scene_id,res.seq`, params),
  ]);
  return {reads, results};
}
