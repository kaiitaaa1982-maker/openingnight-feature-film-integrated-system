// 経費管理のフォルダ（販売の経費）の読み取り（DB の役）。受け口は keihi-routes.mjs、計画は会社ルート plans/2026-10-22-folder-keihi.md。

// 請求書に結んでいない原本（取込の束に使ったものを除く）と、有効な置き場所の月・外した理由。権限の絞り込みは呼ぶ側がする。
export function unlinkedFiles(db,orgId){return db.all(`SELECT f.id,f.file_name,f.media_type,f.byte_length,f.created_at,f.created_by,
   (SELECT p.placed_month FROM expense_file_placements p WHERE p.org_id=f.org_id AND p.file_id=f.id AND NOT EXISTS(SELECT 1 FROM expense_file_placement_voids v WHERE v.org_id=p.org_id AND v.placement_id=p.id) ORDER BY p.id DESC LIMIT 1) AS placed_month,
   (SELECT v.reason FROM expense_file_placements p JOIN expense_file_placement_voids v ON v.org_id=p.org_id AND v.placement_id=p.id WHERE p.org_id=f.org_id AND p.file_id=f.id ORDER BY p.id DESC LIMIT 1) AS removed_reason,
   (SELECT p.placed_month FROM expense_file_placements p WHERE p.org_id=f.org_id AND p.file_id=f.id ORDER BY p.id DESC LIMIT 1) AS last_month
  FROM expense_source_files f WHERE f.org_id=?
  AND NOT EXISTS(SELECT 1 FROM expense_invoice_file_links l WHERE l.org_id=f.org_id AND l.file_id=f.id AND NOT EXISTS(SELECT 1 FROM expense_invoice_file_unlinks u WHERE u.org_id=l.org_id AND u.link_id=l.id))
  AND NOT EXISTS(SELECT 1 FROM expense_import_batches b WHERE b.org_id=f.org_id AND b.file_id=f.id) ORDER BY f.created_at DESC,f.id DESC`,[orgId]);}
// 登録の画面の選択肢: 財務の権限がある案件の作品に付いた商品と、流通の一覧。
export async function folderOptions(db,orgId,projectIds){const works=(await db.all('SELECT id,project_id FROM works WHERE org_id=?',[orgId])).filter(w=>projectIds.has(w.project_id)).map(w=>w.id);
 const products=works.length?await db.all(`SELECT p.id,p.sku,p.name,pw.work_id FROM products p JOIN product_works pw ON pw.org_id=p.org_id AND pw.product_id=p.id WHERE p.org_id=? AND pw.work_id IN (${works.map(()=>'?').join(',')})`,[orgId,...works]):[];
 return {products,distributionTypes:await db.all('SELECT code,family,label FROM distribution_types ORDER BY sort_order')};}
// 明細の行の次の ID（取込と同じく、1回の書き込みの中で連番を振る）。
export async function nextExpenseId(db){return (await db.get('SELECT COALESCE(MAX(id),0)+1 id FROM expenses')).id;}
// 前後は書いた順（同じ一括で書く監査の行の ID。DB が振る連番）で決める。行の ID は乱数（newId）、created_at は秒までの時計の値なので、
// どちらも順にならない（同じ秒の前後が分からず、時計が戻ると前後が逆になる。2026-11-13 の CI の PG の組で、締めた直後の月が「締めのあとに追加」になった）。
// 監査の行が無い記録（この順を足す前に外すために置いた行）だけ created_at で比べる。
const AUDIT_OF=(type,alias)=>`a.org_id=${alias}.org_id AND a.entity_type='${type}' AND a.entity_id=CAST(${alias}.id AS TEXT)`;
// 月の締めの記録（書いた順。最新の行が今の状態）。audit_id は締めの監査の行の ID。
export function closures(db,orgId){return db.all(`SELECT c.id,c.month,c.kind,c.file_count,c.reason,c.created_at,a.id AS audit_id
  FROM expense_month_closures c LEFT JOIN audit_log a ON ${AUDIT_OF('expense_month_closure','c')} WHERE c.org_id=? ORDER BY COALESCE(a.id,0),c.created_at,c.id`,[orgId]);}
// 締め（closures の1行）のあとにその月へ置いた原本の数。外した置き場所も数える。
export async function placedAfter(db,orgId,month,closure){
 if(closure.audit_id==null)return (await db.get('SELECT COUNT(*) n FROM expense_file_placements WHERE org_id=? AND placed_month=? AND created_at>?',[orgId,month,closure.created_at])).n;
 return (await db.get(`SELECT (SELECT COUNT(*) FROM audit_log a JOIN expense_file_placements p ON p.org_id=a.org_id AND p.id=CAST(a.entity_id AS INTEGER)
   WHERE a.org_id=? AND a.id>? AND a.entity_type='expense_file_placement' AND p.placed_month=?)
  +(SELECT COUNT(*) FROM expense_file_placements p WHERE p.org_id=? AND p.placed_month=? AND p.created_at>? AND NOT EXISTS(SELECT 1 FROM audit_log a WHERE ${AUDIT_OF('expense_file_placement','p')})) AS n`,
  [orgId,closure.audit_id,month,orgId,month,closure.created_at])).n;}
// 原本の有効な置き場所（外していないもの）。
export function activePlacement(db,orgId,fileId){return db.get('SELECT p.id FROM expense_file_placements p WHERE p.org_id=? AND p.file_id=? AND NOT EXISTS(SELECT 1 FROM expense_file_placement_voids v WHERE v.org_id=p.org_id AND v.placement_id=p.id)',[orgId,fileId]);}
// 原本が請求書に結ばれているか（結び付きを外したものは除く）。
export async function isFileLinked(db,orgId,fileId){return !!await db.get('SELECT 1 FROM expense_invoice_file_links l WHERE l.org_id=? AND l.file_id=? AND NOT EXISTS(SELECT 1 FROM expense_invoice_file_unlinks u WHERE u.org_id=l.org_id AND u.link_id=l.id)',[orgId,fileId]);}
