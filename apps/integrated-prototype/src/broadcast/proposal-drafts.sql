-- 放送ウィンドウ提案から作った放送枠の下書き（2026-09-26）。設計: docs/platform/team-development/broadcast-windows.md §9。
-- 放送枠そのものは既存の表（broadcast_slots・broadcast_slot_versions、状態 draft）に作る。この2表は「どの提案から作ったか」と
-- 「合意に至らず削除したか」を足すだけで、既存の表は変えない。どちらも追加だけで、変更・削除はトリガーで禁止。
-- ・broadcast_proposal_drafts: 提案から作った放送枠1つにつき1行（商品・局・放送月・初回／再放送・メモと、提案の基準日・提案する期間・根拠）
-- ・broadcast_proposal_draft_deletions: 下書きのうちに「削除（合意に至らず）」にした放送枠1つにつき1行（理由・誰が・いつ）。
--   放送枠の版は消さず（版の表は削除をトリガーで止めている）、同じ束で状態「中止」の版を1つ積み、この表の行で「削除」と区別する。
--   中止の枠は二重登録・競合・同時期の他局・直近3局・放送履歴表に数えない（既存の決まり）。この表にある枠は、放送枠の一覧・Excel からも外す。
-- 既存の表（broadcast_slot_versions・broadcast_sale_links）にはトリガーを足すだけで、列も行も変えない。
-- トリガーの本体では CASE 式を使わない（本番の wrangler d1 migrations apply が「incomplete input」で落ちるため）。条件は WHEN 句に書く。

CREATE TABLE IF NOT EXISTS broadcast_proposal_drafts (
  org_id INTEGER NOT NULL, slot_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  proposal_key TEXT NOT NULL CHECK(length(proposal_key) BETWEEN 1 AND 64),
  product_id INTEGER, station_partner_id INTEGER NOT NULL,
  broadcast_month TEXT NOT NULL CHECK(broadcast_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  run_kind TEXT NOT NULL CHECK(run_kind IN ('first','rerun')),
  as_of TEXT NOT NULL CHECK(as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  proposal_from TEXT NOT NULL CHECK(proposal_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  proposal_to TEXT NOT NULL CHECK(proposal_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  basis_text TEXT NOT NULL CHECK(length(basis_text) BETWEEN 1 AND 4000),
  memo TEXT CHECK(memo IS NULL OR length(memo) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,slot_id),
  CHECK(proposal_to>=proposal_from),
  FOREIGN KEY(org_id,work_id,slot_id) REFERENCES broadcast_slots(org_id,work_id,id),
  FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id),
  FOREIGN KEY(org_id,station_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TABLE IF NOT EXISTS broadcast_proposal_draft_deletions (
  org_id INTEGER NOT NULL, slot_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>1),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  deleted_by INTEGER NOT NULL, deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,slot_id),
  FOREIGN KEY(org_id,slot_id) REFERENCES broadcast_proposal_drafts(org_id,slot_id),
  FOREIGN KEY(org_id,slot_id,revision) REFERENCES broadcast_slot_versions(org_id,slot_id,revision),
  FOREIGN KEY(org_id,deleted_by) REFERENCES memberships(org_id,user_id)
);

CREATE TRIGGER IF NOT EXISTS broadcast_proposal_drafts_no_update BEFORE UPDATE ON broadcast_proposal_drafts BEGIN SELECT RAISE(ABORT,'broadcast proposal draft immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_proposal_drafts_no_delete BEFORE DELETE ON broadcast_proposal_drafts BEGIN SELECT RAISE(ABORT,'broadcast proposal draft immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_proposal_draft_deletions_no_update BEFORE UPDATE ON broadcast_proposal_draft_deletions BEGIN SELECT RAISE(ABORT,'broadcast proposal draft deletion immutable'); END;
CREATE TRIGGER IF NOT EXISTS broadcast_proposal_draft_deletions_no_delete BEFORE DELETE ON broadcast_proposal_draft_deletions BEGIN SELECT RAISE(ABORT,'broadcast proposal draft deletion immutable'); END;

-- 提案の記録は、いま作った下書きの放送枠（第1版だけ・状態は下書き・同じ作品と放送月・取引先がその局）にだけ付ける
CREATE TRIGGER IF NOT EXISTS broadcast_proposal_drafts_new_draft BEFORE INSERT ON broadcast_proposal_drafts
WHEN NOT EXISTS(SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id=NEW.org_id AND v.slot_id=NEW.slot_id AND v.revision=1 AND v.status='draft'
    AND v.work_id=NEW.work_id AND v.broadcast_month=NEW.broadcast_month AND v.customer_partner_id=NEW.station_partner_id)
  OR EXISTS(SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id=NEW.org_id AND v.slot_id=NEW.slot_id AND v.revision>1) BEGIN
  SELECT RAISE(ABORT,'broadcast proposal draft needs a new draft slot');
END;
-- 削除は、下書きの版の次に積んだ中止の版（最新）を指す。下書きでない枠（申請中・確定など）と、放送報告の売上を紐付けた枠は削除にできない
-- （売上を紐付けた枠は放送枠のタブで中止にする。売上突合に「中止枠に売上あり」で残る。削除すると売上が突合のどちらの一覧からも消えるため）
CREATE TRIGGER IF NOT EXISTS broadcast_proposal_draft_deletions_draft_only BEFORE INSERT ON broadcast_proposal_draft_deletions
WHEN NOT EXISTS(SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id=NEW.org_id AND v.slot_id=NEW.slot_id AND v.revision=NEW.revision AND v.status='cancelled')
  OR NOT EXISTS(SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id=NEW.org_id AND v.slot_id=NEW.slot_id AND v.revision=NEW.revision-1 AND v.status='draft')
  OR EXISTS(SELECT 1 FROM broadcast_slot_versions v WHERE v.org_id=NEW.org_id AND v.slot_id=NEW.slot_id AND v.revision>NEW.revision)
  OR EXISTS(SELECT 1 FROM broadcast_sale_links l WHERE l.org_id=NEW.org_id AND l.slot_id=NEW.slot_id) BEGIN
  SELECT RAISE(ABORT,'broadcast proposal draft deletion needs a cancelled draft');
END;
-- 削除した放送枠には売上を紐付けない（削除を確かめた後に紐付けが入る競合も止める）
CREATE TRIGGER IF NOT EXISTS broadcast_sale_links_not_deleted_draft BEFORE INSERT ON broadcast_sale_links
WHEN EXISTS(SELECT 1 FROM broadcast_proposal_draft_deletions d WHERE d.org_id=NEW.org_id AND d.slot_id=NEW.slot_id) BEGIN
  SELECT RAISE(ABORT,'broadcast slot deleted as a proposal draft');
END;
-- 削除した放送枠には新しい版を積まない（削除の後に直す・申請することはできない。同じ作品・月・局は新しい提案として作り直す）
CREATE TRIGGER IF NOT EXISTS broadcast_slot_versions_not_deleted BEFORE INSERT ON broadcast_slot_versions
WHEN EXISTS(SELECT 1 FROM broadcast_proposal_draft_deletions d WHERE d.org_id=NEW.org_id AND d.slot_id=NEW.slot_id) BEGIN
  SELECT RAISE(ABORT,'broadcast slot deleted as a proposal draft');
END;
