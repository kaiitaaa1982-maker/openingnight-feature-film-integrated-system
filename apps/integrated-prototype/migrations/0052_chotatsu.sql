-- 調達（MG を払わずに販売権を調達し、製造へ渡すまで）。会社ルートの plans/2026-10-24-folder-chotatsu.md（代表の決定 2026-10-24。フォルダ台帳 F19）。
-- 足すだけの移行: 調達の表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない（rights_intake_* の受け方の CHECK も変えない）。
-- 番号 0052 は調整役から受け取った（C:/ONwt/MIGRATION-ORDER.md）。
--
-- chotatsu_cases: 調達の案件の芯（番号だけ）。題・権利元・発売予定などは版（chotatsu_case_versions）に持つ。
-- chotatsu_stage_events: 段（希望・試算・合意・稟議・契約・素材・渡す）の出来事。追加のみ。取消は event='void' の行で前の行の seq を指す。
--   見送りは dropped、MG を払うことになって MG_買付分へ移したときは moved_to_mg（どちらも案件を閉じる）。段の順番は受け口が守る。
-- chotatsu_estimates / chotatsu_estimate_lines: 試算と仕様案の版と、見積の行（経費の種類で書く。見積は経費の行に入れない）。MG の型は持たない。
-- chotatsu_agreements / chotatsu_ringi: 合意した試算の版と、稟議の結果（承認の流れは持たない。原本と結果と日だけ）。
-- chotatsu_contracts: 契約の段で作った調達案件（rights_intake_cases。受け方 entrusted）と配給委託の契約（settlement_contracts の commission）を指す。
-- chotatsu_materials: 素材の受領と検品の記録（追加のみ。種類ごとに最後の行がいまの状態）。
-- chotatsu_handoffs / chotatsu_handoff_events: 製造へ渡す行と、その段（notice＝予告・received＝受領・void＝取消）。製造は読むだけ。
-- chotatsu_documents: 案件と共通の原本の表（source_documents）の結び付き。chotatsu_case_expenses: 案件と経費の明細の行の結び付き。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS chotatsu_cases (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_code TEXT NOT NULL CHECK(length(trim(case_code)) BETWEEN 1 AND 40),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_code),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_cases_no_update BEFORE UPDATE ON chotatsu_cases BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_cases_no_delete BEFORE DELETE ON chotatsu_cases BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;

CREATE TABLE IF NOT EXISTS chotatsu_case_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
 holder_partner_id INTEGER,
 distributor_partner_id INTEGER,
 media_family TEXT NOT NULL CHECK(media_family IN ('videogram','digital','broadcast','overseas','other')),
 work_id INTEGER,
 origin TEXT NOT NULL CHECK(origin IN ('self','sales_activity')),
 sales_activity_id INTEGER,
 theatrical_release_on TEXT CHECK(theatrical_release_on IS NULL OR (length(theatrical_release_on)=10 AND substr(theatrical_release_on,5,1)='-' AND substr(theatrical_release_on,8,1)='-'
  AND ltrim(substr(theatrical_release_on,1,4)||substr(theatrical_release_on,6,2)||substr(theatrical_release_on,9,2),'0123456789')='')),
 offer_from TEXT CHECK(offer_from IS NULL OR (length(offer_from)=10 AND substr(offer_from,5,1)='-' AND substr(offer_from,8,1)='-'
  AND ltrim(substr(offer_from,1,4)||substr(offer_from,6,2)||substr(offer_from,9,2),'0123456789')='')),
 offer_until TEXT CHECK(offer_until IS NULL OR (length(offer_until)=10 AND substr(offer_until,5,1)='-' AND substr(offer_until,8,1)='-'
  AND ltrim(substr(offer_until,1,4)||substr(offer_until,6,2)||substr(offer_until,9,2),'0123456789')='')),
 release_month TEXT CHECK(release_month IS NULL OR (length(release_month)=7 AND substr(release_month,5,1)='-'
  AND ltrim(substr(release_month,1,4)||substr(release_month,6,2),'0123456789')='' AND substr(release_month,6,2) BETWEEN '01' AND '12')),
 release_slot TEXT CHECK(release_slot IS NULL OR release_slot IN ('day25','first_wed','other')),
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 2000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_id,version_no),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,holder_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,distributor_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,sales_activity_id) REFERENCES sales_activities(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((origin='self' AND sales_activity_id IS NULL) OR (origin='sales_activity' AND sales_activity_id IS NOT NULL)),
 CHECK(offer_from IS NULL OR offer_until IS NULL OR offer_until>=offer_from),
 CHECK(release_slot IS NULL OR release_month IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_case_versions_sequence BEFORE INSERT ON chotatsu_case_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM chotatsu_case_versions v WHERE v.org_id=NEW.org_id AND v.case_id=NEW.case_id)
 BEGIN SELECT RAISE(ABORT,'stale chotatsu version'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_case_versions_no_update BEFORE UPDATE ON chotatsu_case_versions BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_case_versions_no_delete BEFORE DELETE ON chotatsu_case_versions BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE INDEX IF NOT EXISTS chotatsu_case_versions_case_idx ON chotatsu_case_versions(org_id,case_id);

CREATE TABLE IF NOT EXISTS chotatsu_stage_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 stage TEXT NOT NULL CHECK(stage IN ('wish','estimate','agreement','ringi','contract','materials','handoff')),
 event TEXT NOT NULL CHECK(event IN ('done','void','dropped','moved_to_mg')),
 voids_seq INTEGER CHECK(voids_seq IS NULL OR (typeof(voids_seq)='integer' AND voids_seq>0)),
 on_date TEXT NOT NULL CHECK(length(on_date)=10 AND substr(on_date,5,1)='-' AND substr(on_date,8,1)='-'
  AND ltrim(substr(on_date,1,4)||substr(on_date,6,2)||substr(on_date,9,2),'0123456789')=''),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_id,seq),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((event='void' AND voids_seq IS NOT NULL AND voids_seq<seq AND reason IS NOT NULL) OR (event<>'void' AND voids_seq IS NULL)),
 CHECK(event NOT IN ('dropped','moved_to_mg') OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_stage_events_sequence BEFORE INSERT ON chotatsu_stage_events
 WHEN NEW.seq<>(SELECT COALESCE(MAX(e.seq),0)+1 FROM chotatsu_stage_events e WHERE e.org_id=NEW.org_id AND e.case_id=NEW.case_id)
 BEGIN SELECT RAISE(ABORT,'stale chotatsu event'); END;
-- 閉じた案件（見送り・MG_買付分へ移した）には、取消のほかの出来事を足せない
CREATE TRIGGER IF NOT EXISTS chotatsu_stage_events_closed BEFORE INSERT ON chotatsu_stage_events
 WHEN NEW.event<>'void' AND EXISTS(SELECT 1 FROM chotatsu_stage_events e WHERE e.org_id=NEW.org_id AND e.case_id=NEW.case_id AND e.event IN ('dropped','moved_to_mg')
  AND NOT EXISTS(SELECT 1 FROM chotatsu_stage_events x WHERE x.org_id=e.org_id AND x.case_id=e.case_id AND x.event='void' AND x.voids_seq=e.seq))
 BEGIN SELECT RAISE(ABORT,'chotatsu case closed'); END;
-- 取消せるのは、同じ案件の取消でない出来事で、まだ取消していないものだけ
CREATE TRIGGER IF NOT EXISTS chotatsu_stage_events_void_target BEFORE INSERT ON chotatsu_stage_events
 WHEN NEW.event='void' AND (NOT EXISTS(SELECT 1 FROM chotatsu_stage_events e WHERE e.org_id=NEW.org_id AND e.case_id=NEW.case_id AND e.seq=NEW.voids_seq AND e.event<>'void' AND e.stage=NEW.stage)
  OR EXISTS(SELECT 1 FROM chotatsu_stage_events x WHERE x.org_id=NEW.org_id AND x.case_id=NEW.case_id AND x.event='void' AND x.voids_seq=NEW.voids_seq))
 BEGIN SELECT RAISE(ABORT,'chotatsu void target invalid'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_stage_events_no_update BEFORE UPDATE ON chotatsu_stage_events BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_stage_events_no_delete BEFORE DELETE ON chotatsu_stage_events BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;

CREATE TABLE IF NOT EXISTS chotatsu_estimates (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 format TEXT NOT NULL CHECK(format IN ('sell_dvd','sell_bd','sell_dvd_bd','rental_dvd','rental_bd','digital','other')),
 set_count INTEGER NOT NULL CHECK(typeof(set_count)='integer' AND set_count BETWEEN 1 AND 100),
 bonus_note TEXT CHECK(bonus_note IS NULL OR length(trim(bonus_note)) BETWEEN 1 AND 500),
 list_price_ex_tax_yen INTEGER CHECK(list_price_ex_tax_yen IS NULL OR (typeof(list_price_ex_tax_yen)='integer' AND list_price_ex_tax_yen BETWEEN 0 AND 1000000000)),
 unit_revenue_ex_tax_yen INTEGER NOT NULL CHECK(typeof(unit_revenue_ex_tax_yen)='integer' AND unit_revenue_ex_tax_yen BETWEEN 0 AND 1000000000),
 quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 0 AND 100000000),
 royalty_kind TEXT NOT NULL CHECK(royalty_kind IN ('rate','per_unit','none')),
 royalty_rate_bps INTEGER CHECK(royalty_rate_bps IS NULL OR (typeof(royalty_rate_bps)='integer' AND royalty_rate_bps BETWEEN 0 AND 10000)),
 royalty_per_unit_yen INTEGER CHECK(royalty_per_unit_yen IS NULL OR (typeof(royalty_per_unit_yen)='integer' AND royalty_per_unit_yen BETWEEN 0 AND 1000000000)),
 promotion_note TEXT CHECK(promotion_note IS NULL OR length(trim(promotion_note)) BETWEEN 1 AND 2000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_id,id), UNIQUE(org_id,case_id,version_no),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((royalty_kind='rate' AND royalty_rate_bps IS NOT NULL AND royalty_per_unit_yen IS NULL)
    OR (royalty_kind='per_unit' AND royalty_per_unit_yen IS NOT NULL AND royalty_rate_bps IS NULL)
    OR (royalty_kind='none' AND royalty_rate_bps IS NULL AND royalty_per_unit_yen IS NULL))
);
CREATE TRIGGER IF NOT EXISTS chotatsu_estimates_sequence BEFORE INSERT ON chotatsu_estimates
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM chotatsu_estimates v WHERE v.org_id=NEW.org_id AND v.case_id=NEW.case_id)
 BEGIN SELECT RAISE(ABORT,'stale chotatsu estimate'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_estimates_no_update BEFORE UPDATE ON chotatsu_estimates BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_estimates_no_delete BEFORE DELETE ON chotatsu_estimates BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;

CREATE TABLE IF NOT EXISTS chotatsu_estimate_lines (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 estimate_id INTEGER NOT NULL,
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 200),
 expense_type TEXT NOT NULL CHECK(length(trim(expense_type)) BETWEEN 1 AND 60),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 amount_ex_tax_yen INTEGER NOT NULL CHECK(typeof(amount_ex_tax_yen)='integer' AND amount_ex_tax_yen BETWEEN 0 AND 1000000000000),
 source_document_id INTEGER,
 UNIQUE(org_id,id), UNIQUE(org_id,estimate_id,line_no),
 FOREIGN KEY(org_id,case_id,estimate_id) REFERENCES chotatsu_estimates(org_id,case_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_estimate_lines_no_update BEFORE UPDATE ON chotatsu_estimate_lines BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_estimate_lines_no_delete BEFORE DELETE ON chotatsu_estimate_lines BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE INDEX IF NOT EXISTS chotatsu_estimate_lines_estimate_idx ON chotatsu_estimate_lines(org_id,estimate_id);

CREATE TABLE IF NOT EXISTS chotatsu_agreements (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 estimate_id INTEGER NOT NULL,
 agreed_on TEXT NOT NULL CHECK(length(agreed_on)=10 AND substr(agreed_on,5,1)='-' AND substr(agreed_on,8,1)='-'
  AND ltrim(substr(agreed_on,1,4)||substr(agreed_on,6,2)||substr(agreed_on,9,2),'0123456789')=''),
 source_document_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,case_id,estimate_id) REFERENCES chotatsu_estimates(org_id,case_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_agreements_no_update BEFORE UPDATE ON chotatsu_agreements BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_agreements_no_delete BEFORE DELETE ON chotatsu_agreements BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE INDEX IF NOT EXISTS chotatsu_agreements_case_idx ON chotatsu_agreements(org_id,case_id);

CREATE TABLE IF NOT EXISTS chotatsu_ringi (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 estimate_id INTEGER NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('approved','returned','rejected')),
 result_on TEXT NOT NULL CHECK(length(result_on)=10 AND substr(result_on,5,1)='-' AND substr(result_on,8,1)='-'
  AND ltrim(substr(result_on,1,4)||substr(result_on,6,2)||substr(result_on,9,2),'0123456789')=''),
 source_document_id INTEGER,
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,case_id,estimate_id) REFERENCES chotatsu_estimates(org_id,case_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_ringi_no_update BEFORE UPDATE ON chotatsu_ringi BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_ringi_no_delete BEFORE DELETE ON chotatsu_ringi BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE INDEX IF NOT EXISTS chotatsu_ringi_case_idx ON chotatsu_ringi(org_id,case_id);

CREATE TABLE IF NOT EXISTS chotatsu_contracts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 intake_case_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 settlement_contract_id INTEGER NOT NULL,
 signed_on TEXT NOT NULL CHECK(length(signed_on)=10 AND substr(signed_on,5,1)='-' AND substr(signed_on,8,1)='-'
  AND ltrim(substr(signed_on,1,4)||substr(signed_on,6,2)||substr(signed_on,9,2),'0123456789')=''),
 signed_document_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,intake_case_id), UNIQUE(org_id,settlement_contract_id),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
 FOREIGN KEY(org_id,settlement_contract_id,work_id) REFERENCES settlement_contracts(org_id,id,work_id),
 FOREIGN KEY(org_id,signed_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_contracts_no_update BEFORE UPDATE ON chotatsu_contracts BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_contracts_no_delete BEFORE DELETE ON chotatsu_contracts BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE INDEX IF NOT EXISTS chotatsu_contracts_case_idx ON chotatsu_contracts(org_id,case_id);

CREATE TABLE IF NOT EXISTS chotatsu_materials (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 material_kind TEXT NOT NULL CHECK(material_kind IN ('master','preview_copy','trailer','bonus','music','main_art','logo','stills','poster','work_info','other')),
 required INTEGER NOT NULL CHECK(required IN (0,1)),
 received_on TEXT CHECK(received_on IS NULL OR (length(received_on)=10 AND substr(received_on,5,1)='-' AND substr(received_on,8,1)='-'
  AND ltrim(substr(received_on,1,4)||substr(received_on,6,2)||substr(received_on,9,2),'0123456789')='')),
 check_result TEXT NOT NULL CHECK(check_result IN ('pending','ok','ng')),
 source_document_id INTEGER,
 note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_id,seq),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(check_result='pending' OR received_on IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_materials_sequence BEFORE INSERT ON chotatsu_materials
 WHEN NEW.seq<>(SELECT COALESCE(MAX(m.seq),0)+1 FROM chotatsu_materials m WHERE m.org_id=NEW.org_id AND m.case_id=NEW.case_id)
 BEGIN SELECT RAISE(ABORT,'stale chotatsu material'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_materials_no_update BEFORE UPDATE ON chotatsu_materials BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_materials_no_delete BEFORE DELETE ON chotatsu_materials BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;

CREATE TABLE IF NOT EXISTS chotatsu_handoffs (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 handoff_no INTEGER NOT NULL CHECK(typeof(handoff_no)='integer' AND handoff_no>0),
 work_id INTEGER NOT NULL,
 intake_case_id INTEGER NOT NULL,
 estimate_id INTEGER NOT NULL,
 allowed_formats TEXT NOT NULL CHECK(json_valid(allowed_formats) AND json_type(allowed_formats)='array' AND length(allowed_formats) BETWEEN 2 AND 500),
 territory TEXT CHECK(territory IS NULL OR length(trim(territory)) BETWEEN 1 AND 100),
 rights_end TEXT CHECK(rights_end IS NULL OR (length(rights_end)=10 AND substr(rights_end,5,1)='-' AND substr(rights_end,8,1)='-')),
 release_slot TEXT NOT NULL CHECK(release_slot IN ('day25','first_wed','other')),
 release_month TEXT NOT NULL CHECK(length(release_month)=7 AND substr(release_month,5,1)='-'
  AND ltrim(substr(release_month,1,4)||substr(release_month,6,2),'0123456789')='' AND substr(release_month,6,2) BETWEEN '01' AND '12'),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_id,handoff_no),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,intake_case_id,work_id) REFERENCES rights_intake_cases(org_id,id,work_id),
 FOREIGN KEY(org_id,case_id,estimate_id) REFERENCES chotatsu_estimates(org_id,case_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_handoffs_sequence BEFORE INSERT ON chotatsu_handoffs
 WHEN NEW.handoff_no<>(SELECT COALESCE(MAX(h.handoff_no),0)+1 FROM chotatsu_handoffs h WHERE h.org_id=NEW.org_id AND h.case_id=NEW.case_id)
 BEGIN SELECT RAISE(ABORT,'stale chotatsu handoff'); END;
-- 引き渡しは、契約の行がある案件だけ
CREATE TRIGGER IF NOT EXISTS chotatsu_handoffs_requires_contract BEFORE INSERT ON chotatsu_handoffs
 WHEN NOT EXISTS(SELECT 1 FROM chotatsu_contracts k WHERE k.org_id=NEW.org_id AND k.case_id=NEW.case_id AND k.intake_case_id=NEW.intake_case_id)
 BEGIN SELECT RAISE(ABORT,'chotatsu handoff requires contract'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_handoffs_no_update BEFORE UPDATE ON chotatsu_handoffs BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_handoffs_no_delete BEFORE DELETE ON chotatsu_handoffs BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;

CREATE TABLE IF NOT EXISTS chotatsu_handoff_events (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 handoff_id INTEGER NOT NULL,
 seq INTEGER NOT NULL CHECK(typeof(seq)='integer' AND seq>0),
 event TEXT NOT NULL CHECK(event IN ('notice','received','void')),
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,handoff_id,seq),
 FOREIGN KEY(org_id,handoff_id) REFERENCES chotatsu_handoffs(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(event<>'void' OR reason IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_handoff_events_sequence BEFORE INSERT ON chotatsu_handoff_events
 WHEN NEW.seq<>(SELECT COALESCE(MAX(e.seq),0)+1 FROM chotatsu_handoff_events e WHERE e.org_id=NEW.org_id AND e.handoff_id=NEW.handoff_id)
 BEGIN SELECT RAISE(ABORT,'stale chotatsu handoff event'); END;
-- 段の順: 予告（seq 1）→ 受領（seq 2）。取消のあとは何も足せない
CREATE TRIGGER IF NOT EXISTS chotatsu_handoff_events_order BEFORE INSERT ON chotatsu_handoff_events
 WHEN (NEW.event='notice' AND NEW.seq<>1) OR (NEW.event='received' AND NOT EXISTS(SELECT 1 FROM chotatsu_handoff_events e WHERE e.org_id=NEW.org_id AND e.handoff_id=NEW.handoff_id AND e.event='notice'))
  OR (NEW.event='received' AND EXISTS(SELECT 1 FROM chotatsu_handoff_events e WHERE e.org_id=NEW.org_id AND e.handoff_id=NEW.handoff_id AND e.event='received'))
  OR EXISTS(SELECT 1 FROM chotatsu_handoff_events e WHERE e.org_id=NEW.org_id AND e.handoff_id=NEW.handoff_id AND e.event='void')
 BEGIN SELECT RAISE(ABORT,'chotatsu handoff event order'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_handoff_events_no_update BEFORE UPDATE ON chotatsu_handoff_events BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_handoff_events_no_delete BEFORE DELETE ON chotatsu_handoff_events BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;

CREATE TABLE IF NOT EXISTS chotatsu_documents (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 source_document_id INTEGER NOT NULL,
 doc_kind TEXT NOT NULL CHECK(doc_kind IN ('estimate','agreement','ringi','contract_draft','contract','materials','other')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_id,source_document_id),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_documents_no_update BEFORE UPDATE ON chotatsu_documents BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_documents_no_delete BEFORE DELETE ON chotatsu_documents BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;

CREATE TABLE IF NOT EXISTS chotatsu_case_expenses (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 case_id INTEGER NOT NULL,
 expense_id INTEGER NOT NULL,
 estimate_line_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,case_id,expense_id),
 FOREIGN KEY(org_id,case_id) REFERENCES chotatsu_cases(org_id,id),
 FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,estimate_line_id) REFERENCES chotatsu_estimate_lines(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS chotatsu_case_expenses_no_update BEFORE UPDATE ON chotatsu_case_expenses BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
CREATE TRIGGER IF NOT EXISTS chotatsu_case_expenses_no_delete BEFORE DELETE ON chotatsu_case_expenses BEGIN SELECT RAISE(ABORT,'chotatsu record immutable'); END;
