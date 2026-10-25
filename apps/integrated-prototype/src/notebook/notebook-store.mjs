// 現場の連絡帳の DB の読み書き（DB の役。移行 0055 のスペース・連絡・既読と了解）。表は追加だけ。

export const findSpace = (db, orgId, spaceId) => db.get('SELECT * FROM notebook_spaces WHERE org_id=? AND id=?', [orgId, spaceId]);
export const listSpaces = (db, orgId, workId) => db.all('SELECT * FROM notebook_spaces WHERE org_id=? AND work_id=? ORDER BY id', [orgId, workId]);

// 同じ名前のスペースが無いときだけ足す（2回開いても増えない）
export const addSpaceIfMissing = (db, orgId, workId, kind, name, userId) => db.run(
  'INSERT INTO notebook_spaces(org_id,work_id,kind,name,created_by) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM notebook_spaces WHERE org_id=? AND work_id=? AND name=?)',
  [orgId, workId, kind, name, userId, orgId, workId, name]);
export const addSpace = (db, orgId, workId, kind, name, userId) =>
  db.run('INSERT INTO notebook_spaces(org_id,work_id,kind,name,created_by) VALUES(?,?,?,?,?)', [orgId, workId, kind, name, userId]);

// スペースごとの未読の数（その人の既読の行が無い連絡）
export const unreadBySpace = (db, orgId, workId, userId) => db.all(`SELECT p.space_id, COUNT(*) AS n FROM notebook_posts p WHERE p.org_id=? AND p.work_id=?
  AND NOT EXISTS (SELECT 1 FROM notebook_receipts r WHERE r.org_id=p.org_id AND r.post_id=p.id AND r.user_id=? AND r.kind='read') GROUP BY p.space_id`, [orgId, workId, userId]);

export const listPosts = (db, orgId, spaceId) =>
  db.all('SELECT p.*, u.display_name AS author FROM notebook_posts p LEFT JOIN users u ON u.id=p.posted_by WHERE p.org_id=? AND p.space_id=? ORDER BY p.id DESC LIMIT 200', [orgId, spaceId]);
export const listReceipts = (db, orgId, spaceId) =>
  db.all('SELECT post_id,user_id,kind FROM notebook_receipts WHERE org_id=? AND post_id IN (SELECT id FROM notebook_posts WHERE org_id=? AND space_id=?)', [orgId, orgId, spaceId]);

export const insertPost = (db, orgId, workId, spaceId, userId, post) => db.run(
  'INSERT INTO notebook_posts(org_id,work_id,space_id,template,title,fields_json,body,attachments_json,design,needs_ack,corrects_post_id,posted_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  [orgId, workId, spaceId, post.template, post.title, JSON.stringify(post.fields), post.body, JSON.stringify(post.attachments), post.design, post.needs_ack, post.corrects_post_id, userId]);

export const findPost = (db, orgId, postId) => db.get('SELECT id,space_id FROM notebook_posts WHERE org_id=? AND id=?', [orgId, postId]);

// 既読・了解。同じ人の2回目は何も足さない
export const addReceipt = (db, orgId, postId, userId, kind) => db.run(
  'INSERT INTO notebook_receipts(org_id,post_id,user_id,kind) SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM notebook_receipts WHERE org_id=? AND post_id=? AND user_id=? AND kind=?)',
  [orgId, postId, userId, kind, orgId, postId, userId, kind]);
