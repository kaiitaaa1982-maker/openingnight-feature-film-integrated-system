-- 製作委員会の契約の型と、条件版の式の部品（要件 docs/requirements/settlement/committee.md の FR-SETL-COMM-019。会社ルートの plans/2026-10-23-committee-terms-ledger.md の A）。
-- 足すだけの移行: 6表と、その表だけのトリガーを作る。既存の表（committee_term_versions など）の列・制約・トリガーは変えない。番号 0042 は調整役から受け取った。
--
-- committee_term_templates: 契約の型（条件版の下書き）。型ごと（code）の連番で追加だけ。中身は条件版の入力と同じ形の JSON。
--   型を直すときは版を足し、前の版は消さない（企画の試算の版と条件版が型の版を指すため。企画との約束 X-4）。
-- committee_term_version_templates: 条件版をどの型の版から写したか（条件版に列を足せないので別の表。1条件版に1行）。
-- committee_term_businesses: 条件版×事業化権利ごとの業務担当者。事業化権利の語は契約書の別紙の型（下の CHECK）。
-- committee_term_business_steps: 事業ごとの式の段。並べた順（step_no）が計算の順（src/committee/ledger/committee-formula-model.mjs の calcBusiness）。
--   expense: 経費（区分の名前だけ。額は回ごとの台帳に入る）／secondary_royalty: 二次使用料（料率はロイヤリティの契約が持つ。ここは著作権者の役と、経費を引くかだけ）
--   agent_fee: 窓口手数料（率と基礎）
-- committee_term_committee_steps: 委員会全体の式の段（委員会経費・幹事手数料・成功報酬）。並べた順が計算の順（calcCommittee）。
--   成功報酬の after_recoup は、閾値に届く回の扱い（crossing_rule）を必ず持つ（要件の要確認1。推測で既定を置かない）。
-- committee_term_budget_lines: 総事業費の内訳。出資金の総額 E の内訳で、収支（D−E）では E を1回だけ引く（内訳を別に引かない）。
--
-- どの表も変更・削除はトリガーで断る（直すときは新しい条件版）。トリガーの本体に CASE を書かない。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS committee_term_templates (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 code TEXT NOT NULL CHECK(length(trim(code)) BETWEEN 1 AND 60),
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 previous_id INTEGER,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
 body_json TEXT NOT NULL CHECK(length(body_json) BETWEEN 2 AND 200000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,code,version_no),
 FOREIGN KEY(org_id,previous_id) REFERENCES committee_term_templates(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((version_no=1 AND previous_id IS NULL) OR (version_no>1 AND previous_id IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS committee_term_templates_sequence BEFORE INSERT ON committee_term_templates
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(t.version_no),0)+1 FROM committee_term_templates t WHERE t.org_id=NEW.org_id AND t.code=NEW.code)
 BEGIN SELECT RAISE(ABORT,'stale committee template version'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_templates_previous BEFORE INSERT ON committee_term_templates
 WHEN NEW.previous_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committee_term_templates t WHERE t.org_id=NEW.org_id AND t.id=NEW.previous_id AND t.code=NEW.code AND t.version_no=NEW.version_no-1)
 BEGIN SELECT RAISE(ABORT,'committee template previous version mismatch'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_templates_no_update BEFORE UPDATE ON committee_term_templates BEGIN SELECT RAISE(ABORT,'committee template immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_templates_no_delete BEFORE DELETE ON committee_term_templates BEGIN SELECT RAISE(ABORT,'committee template immutable'); END;

CREATE TABLE IF NOT EXISTS committee_term_version_templates (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 template_id INTEGER NOT NULL,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,term_version_id),
 FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id),
 FOREIGN KEY(org_id,template_id) REFERENCES committee_term_templates(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS committee_term_version_templates_no_update BEFORE UPDATE ON committee_term_version_templates BEGIN SELECT RAISE(ABORT,'committee term template link immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_version_templates_no_delete BEFORE DELETE ON committee_term_version_templates BEGIN SELECT RAISE(ABORT,'committee term template link immutable'); END;

CREATE TABLE IF NOT EXISTS committee_term_businesses (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 business_code TEXT NOT NULL CHECK(business_code IN ('theatrical','program','non_theatrical','home_video','commercial_video','internet','tv','ancillary','publishing','merchandising','overseas','music_master','music_publishing','other')),
 display_order INTEGER NOT NULL CHECK(typeof(display_order)='integer' AND display_order BETWEEN 1 AND 100),
 operator_partner_id INTEGER NOT NULL,
 clause_reference TEXT CHECK(clause_reference IS NULL OR length(trim(clause_reference)) BETWEEN 1 AND 200),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,term_version_id,business_code),
 UNIQUE(org_id,term_version_id,display_order),
 FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id),
 FOREIGN KEY(org_id,operator_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS committee_term_businesses_no_update BEFORE UPDATE ON committee_term_businesses BEGIN SELECT RAISE(ABORT,'committee business terms immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_businesses_no_delete BEFORE DELETE ON committee_term_businesses BEGIN SELECT RAISE(ABORT,'committee business terms immutable'); END;

CREATE TABLE IF NOT EXISTS committee_term_business_steps (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 business_code TEXT NOT NULL,
 step_no INTEGER NOT NULL CHECK(typeof(step_no)='integer' AND step_no BETWEEN 1 AND 50),
 kind TEXT NOT NULL CHECK(kind IN ('expense','secondary_royalty','agent_fee')),
 expense_label TEXT CHECK(expense_label IS NULL OR length(trim(expense_label)) BETWEEN 1 AND 100),
 holder_role TEXT CHECK(holder_role IS NULL OR holder_role IN ('original','director','screenplay','music','other')),
 deduct_expenses INTEGER CHECK(deduct_expenses IS NULL OR deduct_expenses IN (0,1)),
 fee_rate_bps INTEGER CHECK(fee_rate_bps IS NULL OR (typeof(fee_rate_bps)='integer' AND fee_rate_bps BETWEEN 0 AND 10000)),
 fee_base TEXT CHECK(fee_base IS NULL OR fee_base IN ('income','remaining')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,term_version_id,business_code,step_no),
 FOREIGN KEY(org_id,term_version_id,business_code) REFERENCES committee_term_businesses(org_id,term_version_id,business_code),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((kind='expense' AND expense_label IS NOT NULL AND holder_role IS NULL AND deduct_expenses IS NULL AND fee_rate_bps IS NULL AND fee_base IS NULL)
  OR (kind='secondary_royalty' AND holder_role IS NOT NULL AND deduct_expenses IS NOT NULL AND expense_label IS NULL AND fee_rate_bps IS NULL AND fee_base IS NULL)
  OR (kind='agent_fee' AND fee_rate_bps IS NOT NULL AND fee_base IS NOT NULL AND expense_label IS NULL AND holder_role IS NULL AND deduct_expenses IS NULL))
);
CREATE TRIGGER IF NOT EXISTS committee_term_business_steps_no_update BEFORE UPDATE ON committee_term_business_steps BEGIN SELECT RAISE(ABORT,'committee business steps immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_business_steps_no_delete BEFORE DELETE ON committee_term_business_steps BEGIN SELECT RAISE(ABORT,'committee business steps immutable'); END;

CREATE TABLE IF NOT EXISTS committee_term_committee_steps (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 step_no INTEGER NOT NULL CHECK(typeof(step_no)='integer' AND step_no BETWEEN 1 AND 50),
 kind TEXT NOT NULL CHECK(kind IN ('overhead','manager_fee','success_fee')),
 overhead_label TEXT CHECK(overhead_label IS NULL OR length(trim(overhead_label)) BETWEEN 1 AND 100),
 recipient_partner_id INTEGER,
 rate_bps INTEGER CHECK(rate_bps IS NULL OR (typeof(rate_bps)='integer' AND rate_bps BETWEEN 0 AND 10000)),
 fee_base TEXT CHECK(fee_base IS NULL OR fee_base IN ('a','remaining')),
 threshold_kind TEXT CHECK(threshold_kind IS NULL OR threshold_kind IN ('total_budget','investment_total')),
 success_mode TEXT CHECK(success_mode IS NULL OR success_mode IN ('excess','after_recoup')),
 crossing_rule TEXT CHECK(crossing_rule IS NULL OR crossing_rule IN ('whole_period','excess_part')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,term_version_id,step_no),
 FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id),
 FOREIGN KEY(org_id,recipient_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((kind='overhead' AND overhead_label IS NOT NULL AND recipient_partner_id IS NULL AND rate_bps IS NULL AND fee_base IS NULL AND threshold_kind IS NULL AND success_mode IS NULL AND crossing_rule IS NULL)
  OR (kind='manager_fee' AND recipient_partner_id IS NOT NULL AND rate_bps IS NOT NULL AND fee_base IS NOT NULL AND overhead_label IS NULL AND threshold_kind IS NULL AND success_mode IS NULL AND crossing_rule IS NULL)
  OR (kind='success_fee' AND recipient_partner_id IS NOT NULL AND rate_bps IS NOT NULL AND threshold_kind IS NOT NULL AND success_mode IS NOT NULL AND overhead_label IS NULL AND fee_base IS NULL
      AND ((success_mode='excess' AND crossing_rule IS NULL) OR (success_mode='after_recoup' AND crossing_rule IS NOT NULL))))
);
CREATE TRIGGER IF NOT EXISTS committee_term_committee_steps_no_update BEFORE UPDATE ON committee_term_committee_steps BEGIN SELECT RAISE(ABORT,'committee steps immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_committee_steps_no_delete BEFORE DELETE ON committee_term_committee_steps BEGIN SELECT RAISE(ABORT,'committee steps immutable'); END;

CREATE TABLE IF NOT EXISTS committee_term_budget_lines (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 50),
 item TEXT NOT NULL CHECK(item IN ('production','pa','contingency','other')),
 label TEXT CHECK(label IS NULL OR length(trim(label)) BETWEEN 1 AND 100),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 0 AND 1000000000000),
 tax_basis TEXT NOT NULL CHECK(tax_basis IN ('ex_tax','inc_tax')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,term_version_id,line_no),
 FOREIGN KEY(org_id,term_version_id) REFERENCES committee_term_versions(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(item<>'other' OR label IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS committee_term_budget_lines_no_update BEFORE UPDATE ON committee_term_budget_lines BEGIN SELECT RAISE(ABORT,'committee budget lines immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_budget_lines_no_delete BEFORE DELETE ON committee_term_budget_lines BEGIN SELECT RAISE(ABORT,'committee budget lines immutable'); END;
