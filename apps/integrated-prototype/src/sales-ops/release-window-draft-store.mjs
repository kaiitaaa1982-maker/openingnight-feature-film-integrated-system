// 全作品のウィンドウ（営業管理の持ち物）へ、ほかの業務が下書きの版を1つ足す入口。
// 会社ルートの plans/2026-10-24-folder-chotatsu.md の約束 E-1（営業管理と合意 2026-10-24）: ほかの業務は work_release_windows へ直接書かず、
// 人が「ウィンドウへ写す」を押したときに、同じ書き込みの中でこの関数を呼ぶ。status は draft、source_reference に出どころを書く。
// 既に版がある系列には足さない（確定・下書きの版を上書きしない。営業の画面で直す）
const audit = (orgId, userId, entity, id, detail) => ({sql: 'INSERT INTO audit_log(org_id,user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?)',
  params: [orgId, userId, 'draft', entity, String(id), JSON.stringify(detail)]});

// input: {workId, family（既定 package）, startMonth（YYYY-MM）, sourceReference, reason}
// 戻り値: {created: true, typeLabel, territory} か {created: false, reason}
export async function createReleaseWindowDraft(db, orgId, input, user) {
  const family = input.family ?? 'package';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.startMonth ?? '')) throw new Error('発売予定月は YYYY-MM で入れてください');
  const type = await db.get(`SELECT t.id,t.type_key,v.version_no,v.label,v.default_territory FROM release_window_types t
    JOIN release_window_type_versions v ON v.org_id=t.org_id AND v.type_id=t.id
    WHERE t.org_id=? AND v.family=? AND v.active=1 AND v.version_no=(SELECT MAX(x.version_no) FROM release_window_type_versions x WHERE x.org_id=t.org_id AND x.type_id=t.id)
    ORDER BY v.sort_order,t.id LIMIT 1`, [orgId, family]);
  if (!type) return {created: false, reason: 'パッケージの種別がありません（営業基幹で種別を作ってください）'};
  const territory = type.default_territory;
  const existing = await db.get('SELECT id FROM work_release_windows WHERE org_id=? AND work_id=? AND type_id=? AND territory=?', [orgId, input.workId, type.id, territory]);
  if (existing) return {created: false, reason: `「${type.label}」のウィンドウは既にあります。営業基幹の全作品のウィンドウで直してください`};
  const windowRef = '(SELECT id FROM work_release_windows WHERE org_id=? AND work_id=? AND type_id=? AND territory=?)';
  const key = [orgId, input.workId, type.id, territory];
  await db.batch([
    {sql: 'INSERT INTO work_release_windows(org_id,work_id,type_id,territory,created_by) VALUES(?,?,?,?,?)', params: [...key, user.user_id]},
    {sql: `INSERT INTO work_release_window_versions(org_id,window_id,version_no,type_version_no,start_on,date_precision,status,source_kind,source_reference,reason,created_by)
      VALUES(?,${windowRef},1,?,?,'month','draft','manual',?,?,?)`, params: [orgId, ...key, type.version_no, input.startMonth, input.sourceReference, input.reason, user.user_id]},
    audit(orgId, user.user_id, 'release_window', `${input.workId}:${type.type_key}:${territory}`, {version: 1, status: 'draft', sourceReference: input.sourceReference}),
  ]);
  return {created: true, typeLabel: type.label, territory};
}
