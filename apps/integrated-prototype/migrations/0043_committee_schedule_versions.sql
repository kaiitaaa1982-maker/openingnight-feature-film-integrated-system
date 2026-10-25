-- 製作委員会の日程の版（要件 docs/requirements/settlement/committee.md の FR-SETL-COMM-010〜014・019。会社ルートの plans/2026-10-23-committee-terms-ledger.md の B）。
-- 足すだけの移行: 3表と、その表だけのトリガーを作る。既存の committee_schedule_phases（条件版に付く1段の日程）は変えない。番号 0043 は調整役から受け取った。
--
-- 報告と分配のタイミングは回ごとに変わるので、条件版とは別の版にする（日程だけを変えるたびに条件版を作り直さない）。
-- committee_schedule_versions: 契約ごとの日程の版。連番で追加だけ。基準日（公開日など）から年を数える。
-- committee_schedule_version_phases: 版×段×フェーズ。段は to_manager（業務担当者 → 幹事）と to_members（幹事 → 当事者）。
--   締めの月は12文字の 0/1（1月が先頭。例 2・5・8・11月 = '010010010010'）。回は表に持たず、src/committee/ledger/committee-schedule-model.mjs の roundsFor が導く。
-- committee_round_overrides: その回だけの変更（報告日・支払日・回の飛ばし）。理由は必須。追加だけで、同じ回×項目は後の行が効く。
--   ルールは版、イレギュラーはこの表（brain の royalty-settlement-cycle の「ルールはマスタ、イレギュラーは台帳」）。
--
-- トリガーの本体に CASE を書かない。形の CHECK は GLOB を使わない（dialect.md の「形の CHECK」）。

CREATE TABLE IF NOT EXISTS committee_schedule_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 contract_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 effective_from TEXT NOT NULL CHECK(length(effective_from)=10 AND substr(effective_from,5,1)='-' AND substr(effective_from,8,1)='-'
  AND ltrim(substr(effective_from,1,4)||substr(effective_from,6,2)||substr(effective_from,9,2),'0123456789')=''
  AND substr(effective_from,6,2) BETWEEN '01' AND '12' AND substr(effective_from,9,2) BETWEEN '01' AND '31'),
 base_kind TEXT NOT NULL CHECK(base_kind IN ('release','first_sales','contract','other')),
 base_date TEXT NOT NULL CHECK(length(base_date)=10 AND substr(base_date,5,1)='-' AND substr(base_date,8,1)='-'
  AND ltrim(substr(base_date,1,4)||substr(base_date,6,2)||substr(base_date,9,2),'0123456789')=''
  AND substr(base_date,6,2) BETWEEN '01' AND '12' AND substr(base_date,9,2) BETWEEN '01' AND '31'),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 source_reference TEXT CHECK(source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,contract_id,version_no),
 FOREIGN KEY(org_id,contract_id) REFERENCES committee_contracts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS committee_schedule_versions_sequence BEFORE INSERT ON committee_schedule_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM committee_schedule_versions v WHERE v.org_id=NEW.org_id AND v.contract_id=NEW.contract_id)
 BEGIN SELECT RAISE(ABORT,'stale committee schedule version'); END;
CREATE TRIGGER IF NOT EXISTS committee_schedule_versions_no_update BEFORE UPDATE ON committee_schedule_versions BEGIN SELECT RAISE(ABORT,'committee schedule immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_schedule_versions_no_delete BEFORE DELETE ON committee_schedule_versions BEGIN SELECT RAISE(ABORT,'committee schedule immutable'); END;

CREATE TABLE IF NOT EXISTS committee_schedule_version_phases (
 org_id INTEGER NOT NULL,
 schedule_version_id INTEGER NOT NULL,
 phase_no INTEGER NOT NULL CHECK(typeof(phase_no)='integer' AND phase_no BETWEEN 1 AND 20),
 tier TEXT NOT NULL CHECK(tier IN ('to_manager','to_members')),
 from_year INTEGER NOT NULL CHECK(typeof(from_year)='integer' AND from_year BETWEEN 1 AND 100),
 to_year INTEGER CHECK(to_year IS NULL OR (typeof(to_year)='integer' AND to_year BETWEEN 1 AND 100)),
 close_months TEXT NOT NULL CHECK(length(close_months)=12 AND ltrim(close_months,'01')='' AND close_months<>'000000000000'),
 report_offset_months INTEGER NOT NULL CHECK(typeof(report_offset_months)='integer' AND report_offset_months BETWEEN 0 AND 24),
 pay_from TEXT NOT NULL CHECK(pay_from IN ('close','report')),
 pay_offset_months INTEGER NOT NULL CHECK(typeof(pay_offset_months)='integer' AND pay_offset_months BETWEEN 0 AND 24),
 carry_under_yen INTEGER CHECK(carry_under_yen IS NULL OR (typeof(carry_under_yen)='integer' AND carry_under_yen BETWEEN 0 AND 100000000)),
 holiday_rule TEXT NOT NULL CHECK(holiday_rule IN ('previous_business_day','none')),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,schedule_version_id,phase_no),
 FOREIGN KEY(org_id,schedule_version_id) REFERENCES committee_schedule_versions(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK(to_year IS NULL OR to_year>=from_year)
);
CREATE TRIGGER IF NOT EXISTS committee_schedule_version_phases_no_update BEFORE UPDATE ON committee_schedule_version_phases BEGIN SELECT RAISE(ABORT,'committee schedule immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_schedule_version_phases_no_delete BEFORE DELETE ON committee_schedule_version_phases BEGIN SELECT RAISE(ABORT,'committee schedule immutable'); END;

CREATE TABLE IF NOT EXISTS committee_round_overrides (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 contract_id INTEGER NOT NULL,
 tier TEXT NOT NULL CHECK(tier IN ('to_manager','to_members')),
 close_on TEXT NOT NULL CHECK(length(close_on)=10 AND substr(close_on,5,1)='-' AND substr(close_on,8,1)='-'
  AND ltrim(substr(close_on,1,4)||substr(close_on,6,2)||substr(close_on,9,2),'0123456789')=''),
 field TEXT NOT NULL CHECK(field IN ('report_on','pay_on','skip')),
 value_on TEXT CHECK(value_on IS NULL OR (length(value_on)=10 AND substr(value_on,5,1)='-' AND substr(value_on,8,1)='-'
  AND ltrim(substr(value_on,1,4)||substr(value_on,6,2)||substr(value_on,9,2),'0123456789')='')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 source_reference TEXT CHECK(source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,contract_id) REFERENCES committee_contracts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((field='skip' AND value_on IS NULL) OR (field<>'skip' AND value_on IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS committee_round_overrides_no_update BEFORE UPDATE ON committee_round_overrides BEGIN SELECT RAISE(ABORT,'committee round override immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_round_overrides_no_delete BEFORE DELETE ON committee_round_overrides BEGIN SELECT RAISE(ABORT,'committee round override immutable'); END;
CREATE INDEX IF NOT EXISTS committee_round_overrides_round_idx ON committee_round_overrides(org_id,contract_id,tier,close_on);
