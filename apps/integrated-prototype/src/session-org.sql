-- 組織の切替の記録（0003）。切替は業務データの変更ではないので audit_log には入れない
-- （分析は audit_log の最大IDで「分析版を作った後に業務データが更新された」を決めるため、切り替えるだけで古い表示になる）。
-- org_id は切り替えた先、from_org_id は切り替える前の組織。どちらも本人の所属。追加だけで、変更と削除はトリガーで禁止。
CREATE TABLE IF NOT EXISTS org_switch_events (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, user_id INTEGER NOT NULL, from_org_id INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id),
  CHECK(org_id<>from_org_id),
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(from_org_id,user_id) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS org_switch_events_no_update BEFORE UPDATE ON org_switch_events
BEGIN SELECT RAISE(ABORT, '組織の切替の記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS org_switch_events_no_delete BEFORE DELETE ON org_switch_events
BEGIN SELECT RAISE(ABORT, '組織の切替の記録は削除できません'); END;
