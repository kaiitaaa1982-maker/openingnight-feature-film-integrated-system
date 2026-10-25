// 制作（production）の領域の DB の読み書き。いまは台本の構造化画面が使う読み取りだけを置く。
// 台本の原本の表（workflow_raw_artifacts、src/workflow.sql）と作品（works）はまだ領域フォルダへ移していない古い形の表なので、
// ここから直接読む（docs/rules/architecture.md の「ほかの領域の表」）。どの読み取りも組織（org_id）で絞る。

// 台本の原本の行（本体を除く）。権限を確かめる前に読むので、R2 に置いた本体（original_base64）は読まない。台本でない原本・別の組織の原本は返さない
export async function readScriptArtifact(db, orgId, artifactId) {
  return db.get("SELECT id,work_id FROM workflow_raw_artifacts WHERE org_id=? AND id=? AND kind='script'", [orgId, artifactId]);
}

// 台本の原本の本体（保存した元のファイル）。権限を確かめたあとにだけ読む
export async function readScriptOriginal(db, orgId, artifactId) {
  return db.get("SELECT id,file_name,media_type,raw_sha256,original_base64 FROM workflow_raw_artifacts WHERE org_id=? AND id=? AND kind='script'", [orgId, artifactId]);
}

// 作品が属する案件（権限の確かめに使う）
export async function readWorkProject(db, orgId, workId) {
  return db.get('SELECT id,project_id FROM works WHERE org_id=? AND id=?', [orgId, workId]);
}

// 同じ内容（review_hash が同じ）の確認済みの版と、その原本の最新の版の ID。同じ内容の承認をくり返したときに、新しい版を作らずに済ませるために読む
export async function readScriptReviewByHash(db, orgId, artifactId, reviewHash) {
  return db.get('SELECT r.id,r.version_no,(SELECT MAX(x.id) FROM workflow_script_reviews x WHERE x.org_id=r.org_id AND x.artifact_id=r.artifact_id) latest_id FROM workflow_script_reviews r WHERE r.org_id=? AND r.artifact_id=? AND r.review_hash=?', [orgId, artifactId, reviewHash]);
}
