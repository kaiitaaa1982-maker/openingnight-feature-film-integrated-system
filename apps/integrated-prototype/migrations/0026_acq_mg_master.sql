-- 支払う MG（権利元へ払う MG。買付分）のマスタ（会社ルートの plans/2026-10-22-folder-mg-buy.md の香盤表 #3）。
-- 要件は docs/requirements/planning/rights-acquisition.md の FR-PLAN-ACQ-006〜009・015・022・029・039・040・045〜048、
-- 計画の仮説 H1（媒体ごとの配分）・H3（経費の上限）・H4（MG の分割払い）。
-- 足すだけの移行: 10表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。
-- 受け取る MG（mg_incoming_contracts ほか。MG_販売分）の表は使わない（D-026 決定2、FR-PLAN-ACQ-007）。
--
-- この移行に入れないもの（表の作り直しが要るので次の移行に分ける）:
--   調達案件の受け方に「買付」を足すこと（rights_intake_cases の CHECK。FR-PLAN-ACQ-026）。それまで契約の調達案件は空を許す
--   rights_payment_events に支払う MG の契約・支払の種類・外貨の列を足すこと（約束 C-3・F-2）
--   古い支払 MG の条件版の新しい行を止めるトリガー（約束 S-1。移しを終えて古い入口を閉じる PR）
-- 番号 0026 は調整役から受け取った（0024 は予算書、0025 は共通の原本の表 source_documents）。acq_mg_documents は source_documents を指す（約束 C-1）。
--
-- 回収の値（回収累計・残高・超過・分配額）は表に持たない（FR-PLAN-ACQ-011）。src/acquisition/acq-mg-recoup.mjs が売上明細から毎回計算し、
-- 発行した分配報告書（acq_mg_statements）にだけ、その時点の値を写して残す。
-- 金額は整数の円（外貨は、計算がまだ JPY だけなので、通貨の列だけを持つ）、率は bp。
-- トリガーの本体に CASE を書かない（D1 の remote 適用が落とす）。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS acq_mg_contracts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 code TEXT NOT NULL CHECK(length(trim(code)) BETWEEN 1 AND 40),
 title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
 partner_id INTEGER NOT NULL,
 intake_case_id INTEGER,
 legacy_settlement_contract_id INTEGER,
 legacy_outgoing_contract_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,code),
 UNIQUE(org_id,legacy_settlement_contract_id), UNIQUE(org_id,legacy_outgoing_contract_id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,intake_case_id) REFERENCES rights_intake_cases(org_id,id),
 FOREIGN KEY(org_id,legacy_settlement_contract_id) REFERENCES settlement_contracts(org_id,id),
 FOREIGN KEY(org_id,legacy_outgoing_contract_id) REFERENCES mg_outgoing_contracts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_contracts_no_update BEFORE UPDATE ON acq_mg_contracts
 BEGIN SELECT RAISE(ABORT,'支払う MG の契約は変更できません。条件は新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_contracts_no_delete BEFORE DELETE ON acq_mg_contracts
 BEGIN SELECT RAISE(ABORT,'支払う MG の契約は削除できません'); END;

-- 条件版。契約ごとの連番で、直すときは新しい版を足す（FR-PLAN-ACQ-008）
CREATE TABLE IF NOT EXISTS acq_mg_term_versions (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 contract_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(typeof(version_no)='integer' AND version_no>0),
 consideration TEXT NOT NULL CHECK(consideration IN ('mg','buyout')),
 currency TEXT NOT NULL DEFAULT 'JPY' CHECK(length(currency)=3 AND upper(currency)=currency),
 mg_amount INTEGER NOT NULL CHECK(typeof(mg_amount)='integer' AND mg_amount BETWEEN 0 AND 9007199254740991),
 starts_on TEXT NOT NULL CHECK(length(starts_on)=10 AND starts_on BETWEEN '1900-01-01' AND '2999-12-31'),
 ends_on TEXT NOT NULL CHECK(length(ends_on)=10 AND ends_on BETWEEN '1900-01-01' AND '2999-12-31'),
 recoup_basis TEXT NOT NULL CHECK(recoup_basis IN ('platform_net','after_fee')),
 platform_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK(typeof(platform_rate_bps)='integer' AND platform_rate_bps BETWEEN 0 AND 10000),
 agency_fee_bps INTEGER CHECK(agency_fee_bps IS NULL OR (typeof(agency_fee_bps)='integer' AND agency_fee_bps BETWEEN 0 AND 10000)),
 overage_enabled INTEGER CHECK(overage_enabled IS NULL OR overage_enabled IN (0,1)),
 overage_rate_bps INTEGER CHECK(overage_rate_bps IS NULL OR (typeof(overage_rate_bps)='integer' AND overage_rate_bps BETWEEN 0 AND 10000)),
 pooling TEXT NOT NULL DEFAULT 'all_media' CHECK(pooling IN ('all_media','per_media')),
 shortfall_from_other_media INTEGER NOT NULL DEFAULT 0 CHECK(shortfall_from_other_media IN (0,1)),
 multi_work TEXT NOT NULL DEFAULT 'single' CHECK(multi_work IN ('single','actual','hold_until_total')),
 hold_agreement_ref TEXT CHECK(hold_agreement_ref IS NULL OR length(trim(hold_agreement_ref)) BETWEEN 1 AND 200),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(ends_on>=starts_on),
 CHECK(recoup_basis<>'after_fee' OR agency_fee_bps IS NOT NULL),
 CHECK((overage_enabled IS NULL AND overage_rate_bps IS NULL) OR (overage_enabled=0 AND overage_rate_bps IS NULL) OR (overage_enabled=1 AND overage_rate_bps IS NOT NULL)),
 CHECK(consideration='mg' OR (overage_enabled=0 AND overage_rate_bps IS NULL)),
 CHECK(multi_work<>'hold_until_total' OR hold_agreement_ref IS NOT NULL),
 CHECK(pooling='per_media' OR shortfall_from_other_media=0),
 UNIQUE(org_id,id), UNIQUE(org_id,contract_id,version_no),
 FOREIGN KEY(org_id,contract_id) REFERENCES acq_mg_contracts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_term_versions_sequence BEFORE INSERT ON acq_mg_term_versions
 WHEN NEW.version_no<>(SELECT COALESCE(MAX(v.version_no),0)+1 FROM acq_mg_term_versions v WHERE v.org_id=NEW.org_id AND v.contract_id=NEW.contract_id)
 BEGIN SELECT RAISE(ABORT,'支払う MG の条件版の番号が連番ではありません'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_term_versions_no_update BEFORE UPDATE ON acq_mg_term_versions
 BEGIN SELECT RAISE(ABORT,'支払う MG の条件版は変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_term_versions_no_delete BEFORE DELETE ON acq_mg_term_versions
 BEGIN SELECT RAISE(ABORT,'支払う MG の条件版は削除できません'); END;

-- 版ごとの対象の作品。作品ごとの額は、先に決めた契約だけ（FR-PLAN-ACQ-048）
CREATE TABLE IF NOT EXISTS acq_mg_term_works (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 preset_amount INTEGER CHECK(preset_amount IS NULL OR (typeof(preset_amount)='integer' AND preset_amount BETWEEN 0 AND 9007199254740991)),
 PRIMARY KEY(org_id,term_version_id,work_id),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_term_works_no_update BEFORE UPDATE ON acq_mg_term_works
 BEGIN SELECT RAISE(ABORT,'条件版の対象の作品は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_term_works_no_delete BEFORE DELETE ON acq_mg_term_works
 BEGIN SELECT RAISE(ABORT,'条件版の対象の作品は削除できません'); END;

-- 分配の前に引く費目（契約に書かれた費目だけ。FR-PLAN-ACQ-040）と、その上限（仮説 H3）
CREATE TABLE IF NOT EXISTS acq_mg_term_deductions (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 category TEXT NOT NULL CHECK(length(trim(category)) BETWEEN 1 AND 80),
 cap_amount INTEGER CHECK(cap_amount IS NULL OR (typeof(cap_amount)='integer' AND cap_amount BETWEEN 0 AND 9007199254740991)),
 cap_bps INTEGER CHECK(cap_bps IS NULL OR (typeof(cap_bps)='integer' AND cap_bps BETWEEN 0 AND 10000)),
 source_ref TEXT NOT NULL CHECK(length(trim(source_ref)) BETWEEN 1 AND 200),
 PRIMARY KEY(org_id,term_version_id,category),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_term_deductions_no_update BEFORE UPDATE ON acq_mg_term_deductions
 BEGIN SELECT RAISE(ABORT,'分配の前に引く費目は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_term_deductions_no_delete BEFORE DELETE ON acq_mg_term_deductions
 BEGIN SELECT RAISE(ABORT,'分配の前に引く費目は削除できません'); END;

-- 分配報告の周期（D-029 決定1。royalty_schedule_phases と同じ列。日の空は月末）
CREATE TABLE IF NOT EXISTS acq_mg_term_phases (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 phase_order INTEGER NOT NULL CHECK(typeof(phase_order)='integer' AND phase_order BETWEEN 1 AND 20),
 starts_month TEXT NOT NULL CHECK(length(starts_month)=7 AND substr(starts_month,5,1)='-' AND substr(starts_month,6,2) BETWEEN '01' AND '12' AND substr(starts_month,1,4) BETWEEN '1900' AND '2999'),
 ends_month TEXT CHECK(ends_month IS NULL OR (length(ends_month)=7 AND substr(ends_month,5,1)='-' AND substr(ends_month,6,2) BETWEEN '01' AND '12' AND substr(ends_month,1,4) BETWEEN '1900' AND '2999')),
 cycle_kind TEXT NOT NULL CHECK(cycle_kind IN ('monthly','quarterly','semiannual','annual','custom','manual','none')),
 anchor_month INTEGER CHECK(anchor_month IS NULL OR anchor_month BETWEEN 1 AND 12),
 custom_close_months TEXT CHECK(custom_close_months IS NULL OR length(custom_close_months) BETWEEN 7 AND 2000),
 first_close_immediate INTEGER NOT NULL DEFAULT 0 CHECK(first_close_immediate IN (0,1)),
 report_offset_months INTEGER NOT NULL DEFAULT 1 CHECK(report_offset_months BETWEEN 0 AND 24),
 report_day INTEGER CHECK(report_day IS NULL OR report_day BETWEEN 1 AND 31),
 payment_offset_months INTEGER NOT NULL DEFAULT 1 CHECK(payment_offset_months BETWEEN 0 AND 24),
 payment_day INTEGER CHECK(payment_day IS NULL OR payment_day BETWEEN 1 AND 31),
 PRIMARY KEY(org_id,term_version_id,phase_order),
 CHECK(ends_month IS NULL OR ends_month>=starts_month),
 CHECK((cycle_kind IN ('quarterly','semiannual','annual') AND anchor_month IS NOT NULL) OR (cycle_kind NOT IN ('quarterly','semiannual','annual') AND anchor_month IS NULL)),
 CHECK((cycle_kind='custom' AND custom_close_months IS NOT NULL) OR (cycle_kind<>'custom' AND custom_close_months IS NULL)),
 CHECK(first_close_immediate=0 OR cycle_kind IN ('quarterly','semiannual','annual','custom')),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_term_phases_no_update BEFORE UPDATE ON acq_mg_term_phases
 BEGIN SELECT RAISE(ABORT,'分配報告の周期は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_term_phases_no_delete BEFORE DELETE ON acq_mg_term_phases
 BEGIN SELECT RAISE(ABORT,'分配報告の周期は削除できません'); END;

-- 媒体ごとに配分する契約の配分額（仮説 H1）。媒体は売上集計シートの流通のまとまり（column-registry.mjs の salesBlock）
CREATE TABLE IF NOT EXISTS acq_mg_term_media_allocations (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 media TEXT NOT NULL CHECK(media IN ('flat','mg','rs','rss','vod')),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(org_id,term_version_id,media),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_term_media_allocations_no_update BEFORE UPDATE ON acq_mg_term_media_allocations
 BEGIN SELECT RAISE(ABORT,'媒体ごとの配分は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_term_media_allocations_no_delete BEFORE DELETE ON acq_mg_term_media_allocations
 BEGIN SELECT RAISE(ABORT,'媒体ごとの配分は削除できません'); END;

-- MG の支払予定（仮説 H4）。きっかけは署名・納品・公開・日付。予定日は日付のときと、きっかけが起きて決まったとき
CREATE TABLE IF NOT EXISTS acq_mg_payment_schedule (
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 installment INTEGER NOT NULL CHECK(typeof(installment)='integer' AND installment BETWEEN 1 AND 50),
 trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('signing','delivery','release','date')),
 due_on TEXT CHECK(due_on IS NULL OR (length(due_on)=10 AND due_on BETWEEN '1900-01-01' AND '2999-12-31')),
 amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 0 AND 9007199254740991),
 PRIMARY KEY(org_id,term_version_id,installment),
 CHECK(trigger_kind<>'date' OR due_on IS NOT NULL),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_payment_schedule_no_update BEFORE UPDATE ON acq_mg_payment_schedule
 BEGIN SELECT RAISE(ABORT,'MG の支払予定は変更できません。新しい条件版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_payment_schedule_no_delete BEFORE DELETE ON acq_mg_payment_schedule
 BEGIN SELECT RAISE(ABORT,'MG の支払予定は削除できません'); END;

-- 売上報告×作品 → 条件版の結び付け（問い3 A: 作品と期間で1つに決まれば自動、決まらなければ人）。
-- 1つの報告×作品には結び付けの鎖が1本だけ。直すときは前の行を replaces_link_id で指す新しい行を足す
CREATE TABLE IF NOT EXISTS acq_mg_report_links (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 report_id INTEGER NOT NULL,
 work_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 report_basis TEXT NOT NULL CHECK(report_basis IN ('gross','net')),
 decided_by TEXT NOT NULL CHECK(decided_by IN ('auto','human')),
 decision TEXT NOT NULL CHECK(decision IN ('include','exclude')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 replaces_link_id INTEGER,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,replaces_link_id),
 FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
 FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id),
 FOREIGN KEY(org_id,replaces_link_id) REFERENCES acq_mg_report_links(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS acq_mg_report_links_single_chain BEFORE INSERT ON acq_mg_report_links
 WHEN NEW.replaces_link_id IS NULL
  AND EXISTS(SELECT 1 FROM acq_mg_report_links l WHERE l.org_id=NEW.org_id AND l.report_id=NEW.report_id AND l.work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'この報告と作品は結び付け済みです。直すときは前の結び付けを指してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_report_links_replace_scope BEFORE INSERT ON acq_mg_report_links
 WHEN NEW.replaces_link_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM acq_mg_report_links l WHERE l.org_id=NEW.org_id AND l.id=NEW.replaces_link_id AND l.report_id=NEW.report_id AND l.work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'直す元は同じ報告と作品の結び付けを指してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_report_links_no_update BEFORE UPDATE ON acq_mg_report_links
 BEGIN SELECT RAISE(ABORT,'結び付けは変更できません。直す行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_report_links_no_delete BEFORE DELETE ON acq_mg_report_links
 BEGIN SELECT RAISE(ABORT,'結び付けは削除できません'); END;

-- 締め月の分配報告書（FR-PLAN-ACQ-016・017・031）。発行した時点の回収の値と本体・ハッシュを写して残す。
-- 取消は、前の報告書を voids_statement_id で指す行を足す（取消の行は値を持たず、理由を持つ）
CREATE TABLE IF NOT EXISTS acq_mg_statements (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 term_version_id INTEGER NOT NULL,
 close_month TEXT NOT NULL CHECK(length(close_month)=7 AND substr(close_month,5,1)='-' AND substr(close_month,6,2) BETWEEN '01' AND '12' AND substr(close_month,1,4) BETWEEN '1900' AND '2999'),
 kind TEXT NOT NULL CHECK(kind IN ('issue','void')),
 status TEXT CHECK(status IS NULL OR status IN ('recouping','recouped','buyout','hold')),
 recouped INTEGER CHECK(recouped IS NULL OR typeof(recouped)='integer'),
 balance INTEGER CHECK(balance IS NULL OR typeof(balance)='integer'),
 overage INTEGER CHECK(overage IS NULL OR typeof(overage)='integer'),
 distribution INTEGER CHECK(distribution IS NULL OR typeof(distribution)='integer'),
 body_json TEXT CHECK(body_json IS NULL OR (json_valid(body_json) AND length(body_json) BETWEEN 2 AND 1000000)),
 body_sha256 TEXT CHECK(body_sha256 IS NULL OR length(body_sha256)=64),
 issued_on TEXT NOT NULL CHECK(length(issued_on)=10 AND issued_on BETWEEN '1900-01-01' AND '2999-12-31'),
 voids_statement_id INTEGER,
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK((kind='issue' AND status IS NOT NULL AND recouped IS NOT NULL AND balance IS NOT NULL AND overage IS NOT NULL AND body_json IS NOT NULL AND body_sha256 IS NOT NULL AND voids_statement_id IS NULL)
    OR (kind='void' AND status IS NULL AND recouped IS NULL AND balance IS NULL AND overage IS NULL AND distribution IS NULL AND body_json IS NULL AND body_sha256 IS NULL AND voids_statement_id IS NOT NULL AND reason IS NOT NULL)),
 UNIQUE(org_id,id), UNIQUE(org_id,voids_statement_id),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id),
 FOREIGN KEY(org_id,voids_statement_id) REFERENCES acq_mg_statements(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 取消すのは、同じ条件版の発行の行だけ
CREATE TRIGGER IF NOT EXISTS acq_mg_statements_void_scope BEFORE INSERT ON acq_mg_statements
 WHEN NEW.kind='void'
  AND NOT EXISTS(SELECT 1 FROM acq_mg_statements s WHERE s.org_id=NEW.org_id AND s.id=NEW.voids_statement_id AND s.kind='issue' AND s.term_version_id=NEW.term_version_id AND s.close_month=NEW.close_month)
 BEGIN SELECT RAISE(ABORT,'取り消せるのは、同じ条件版と締め月の発行した報告書だけです'); END;
-- 同じ条件版と締め月に、取り消されていない発行は1通だけ
CREATE TRIGGER IF NOT EXISTS acq_mg_statements_one_live_issue BEFORE INSERT ON acq_mg_statements
 WHEN NEW.kind='issue'
  AND EXISTS(SELECT 1 FROM acq_mg_statements s WHERE s.org_id=NEW.org_id AND s.term_version_id=NEW.term_version_id AND s.close_month=NEW.close_month AND s.kind='issue'
   AND NOT EXISTS(SELECT 1 FROM acq_mg_statements v WHERE v.org_id=s.org_id AND v.voids_statement_id=s.id))
 BEGIN SELECT RAISE(ABORT,'この締め月の報告書は発行済みです。取り消してから発行し直してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_statements_no_update BEFORE UPDATE ON acq_mg_statements
 BEGIN SELECT RAISE(ABORT,'分配報告書は変更できません。取り消して発行し直してください'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_statements_no_delete BEFORE DELETE ON acq_mg_statements
 BEGIN SELECT RAISE(ABORT,'分配報告書は削除できません'); END;

-- 契約・条件版 → 原本の結び付き（約束 C-1。原本は共通の原本の表 source_documents）
CREATE TABLE IF NOT EXISTS acq_mg_documents (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 contract_id INTEGER NOT NULL,
 term_version_id INTEGER,
 source_document_id INTEGER NOT NULL CHECK(typeof(source_document_id)='integer' AND source_document_id>0),
 kind TEXT NOT NULL CHECK(kind IN ('contract','payment_proof','invoice')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,contract_id,source_document_id,kind),
 FOREIGN KEY(org_id,contract_id) REFERENCES acq_mg_contracts(org_id,id),
 FOREIGN KEY(org_id,term_version_id) REFERENCES acq_mg_term_versions(org_id,id),
 FOREIGN KEY(org_id,source_document_id) REFERENCES source_documents(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
-- 条件版を指すなら、同じ契約の版だけ
CREATE TRIGGER IF NOT EXISTS acq_mg_documents_version_scope BEFORE INSERT ON acq_mg_documents
 WHEN NEW.term_version_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM acq_mg_term_versions v WHERE v.org_id=NEW.org_id AND v.id=NEW.term_version_id AND v.contract_id=NEW.contract_id)
 BEGIN SELECT RAISE(ABORT,'原本が指す条件版は、同じ契約のものです'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_documents_no_update BEFORE UPDATE ON acq_mg_documents
 BEGIN SELECT RAISE(ABORT,'原本の結び付きは変更できません'); END;
CREATE TRIGGER IF NOT EXISTS acq_mg_documents_no_delete BEFORE DELETE ON acq_mg_documents
 BEGIN SELECT RAISE(ABORT,'原本の結び付きは削除できません'); END;
