// プリプロの保管庫の DB の読み書き（DB の役。移行 0054 の置き場の記録）。原本そのものは source-documents-store.mjs が持つ。
// 置き場の記録は追加だけ。

export const insertPlacement = (db, orgId, userId, workId, documentId, p) => db.run(
  'INSERT INTO preprod_document_placements(org_id,work_id,document_id,category,episode,dated_on,origin_path,shooting_day_id,scene_id,note,placed_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  [orgId, workId, documentId, p.category, p.episode, p.dated_on, p.origin_path, p.shooting_day_id, p.scene_id, p.note, userId]);

// 作品の置き場の記録の全部（原本の名前・形式・大きさ・受けた日つき）。いまの置き場は vault-model の currentPlacements で導く
export const readPlacementRows = (db, orgId, workId) => db.all(`SELECT p.*, d.file_name, d.media_type, d.byte_length, d.kind AS source_kind, d.received_on
  FROM preprod_document_placements p JOIN source_documents d ON d.org_id=p.org_id AND d.id=p.document_id
  WHERE p.org_id=? AND p.work_id=? ORDER BY p.id`, [orgId, workId]);

// この作品の保管庫にその原本があるか（開く・置き場を変える・連絡帳の添付の判定）
export const isPlacedInWork = async (db, orgId, workId, documentId) =>
  Boolean(await db.get('SELECT 1 AS ok FROM preprod_document_placements WHERE org_id=? AND work_id=? AND document_id=? LIMIT 1', [orgId, workId, documentId]));
