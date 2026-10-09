-- ロイヤリティ・製作委員会の月次・原本の付け替え（2026-09-25）の追加表。src/ の royalty/royalty.sql・committee/committee-extras.sql・sales-source.sql・session-org.sql をこの順で連結したもの。
-- scripts/build-ux-migration.mjs で作る（手で直さない）。0002 の後に当てる。既存の本番D1へ自動では適用しない。

-- ロイヤリティ（監督料・脚本料・音楽著作権料・原作料など）の契約・条件版・サイクル・台帳・報告書（0003）。
-- 設計: docs/platform/team-development/royalty-committee-design.md §3。すべて追加だけ・変更と削除はトリガーで禁止。
-- 直すときは新しい版（条件版・サイクルの版）、取消（報告書）、逆仕訳（reverses_*_id）を足す。
-- 金額は税抜の整数円、率は bp。月は YYYY-MM、日は YYYY-MM-DD。

-- 契約（作品×権利者×種別）。条件とサイクルは版で持つ
CREATE TABLE IF NOT EXISTS royalty_agreements (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  project_id INTEGER NOT NULL,
  work_id INTEGER NOT NULL,
  holder_partner_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('director','screenplay','music','original','creator','other')),
  agreement_code TEXT NOT NULL CHECK(length(trim(agreement_code)) BETWEEN 1 AND 60),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  document_reference TEXT CHECK(document_reference IS NULL OR length(document_reference)<=500),
  note TEXT CHECK(note IS NULL OR length(note)<=1000),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id), UNIQUE(org_id, agreement_code),
  FOREIGN KEY(org_id, project_id, work_id) REFERENCES works(org_id, project_id, id),
  FOREIGN KEY(org_id, holder_partner_id) REFERENCES partners(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS royalty_agreements_by_holder ON royalty_agreements(org_id, holder_partner_id);
CREATE INDEX IF NOT EXISTS royalty_agreements_by_work ON royalty_agreements(org_id, work_id);

-- 条件版。effective_from の計上月から効く（前の版より後の月だけ）。
-- rate: 基礎×料率（after_window_fee 系は窓口手数料率が必須）／fixed_monthly: 毎月定額／manual: 実額の計上（royalty_manual_accruals）
CREATE TABLE IF NOT EXISTS royalty_term_versions (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  agreement_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  effective_from TEXT NOT NULL CHECK(effective_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(effective_from,6,2) BETWEEN '01' AND '12'),
  calc_method TEXT NOT NULL CHECK(calc_method IN ('rate','fixed_monthly','manual')),
  base_kind TEXT CHECK(base_kind IS NULL OR base_kind IN ('gross_sales','after_window_fee','after_window_fee_and_expenses','committee_income','committee_income_after_expenses')),
  rate_bps INTEGER CHECK(rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  window_fee_bps INTEGER CHECK(window_fee_bps IS NULL OR window_fee_bps BETWEEN 0 AND 10000),
  fixed_amount_yen INTEGER CHECK(fixed_amount_yen IS NULL OR fixed_amount_yen>=0),
  advance_yen INTEGER NOT NULL DEFAULT 0 CHECK(advance_yen>=0),
  min_payment_yen INTEGER CHECK(min_payment_yen IS NULL OR min_payment_yen>=0),
  clause_reference TEXT NOT NULL CHECK(length(trim(clause_reference)) BETWEEN 1 AND 500),
  reason TEXT CHECK(reason IS NULL OR length(reason)<=1000),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id), UNIQUE(org_id, agreement_id, version_no), UNIQUE(org_id, agreement_id, effective_from),
  CHECK(
    (calc_method='rate' AND base_kind IS NOT NULL AND rate_bps IS NOT NULL AND fixed_amount_yen IS NULL AND (
      (base_kind IN ('after_window_fee','after_window_fee_and_expenses') AND window_fee_bps IS NOT NULL) OR
      (base_kind NOT IN ('after_window_fee','after_window_fee_and_expenses') AND window_fee_bps IS NULL))) OR
    (calc_method='fixed_monthly' AND fixed_amount_yen IS NOT NULL AND base_kind IS NULL AND rate_bps IS NULL AND window_fee_bps IS NULL) OR
    (calc_method='manual' AND base_kind IS NULL AND rate_bps IS NULL AND window_fee_bps IS NULL AND fixed_amount_yen IS NULL)
  ),
  FOREIGN KEY(org_id, agreement_id) REFERENCES royalty_agreements(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);

-- 条件版の対象流通（行が無ければ全流通）。区分未確認のビデオグラム（package）は対象に選べない（レンタル・セルの両方を選ぶと入る）
CREATE TABLE IF NOT EXISTS royalty_term_channels (
  org_id INTEGER NOT NULL,
  term_version_id INTEGER NOT NULL,
  channel_group TEXT NOT NULL CHECK(channel_group IN ('theatrical','rental','sell','digital','broadcast','overseas','other')),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, term_version_id, channel_group),
  FOREIGN KEY(org_id, term_version_id) REFERENCES royalty_term_versions(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);

-- 条件版で控除する経費の費目（*_expenses の基礎だけ。行が無ければその作品×計上月の経費すべて）
CREATE TABLE IF NOT EXISTS royalty_term_expense_categories (
  org_id INTEGER NOT NULL,
  term_version_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(length(trim(category)) BETWEEN 1 AND 100),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, term_version_id, category),
  FOREIGN KEY(org_id, term_version_id) REFERENCES royalty_term_versions(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);

-- サイクルの版（定型業務の作品契約マスタの型）。最新の版がすべての計上月の締め方を決める（確定済みの報告書は変わらない）。
-- statements_from: この締め月より前の期間は、この仕組みの外で報告済みとして報告書を作らない（移行用。空欄＝すべて作る）
CREATE TABLE IF NOT EXISTS royalty_schedule_versions (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  agreement_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK(version_no>0),
  statements_from TEXT CHECK(statements_from IS NULL OR (statements_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(statements_from,6,2) BETWEEN '01' AND '12')),
  reason TEXT CHECK(reason IS NULL OR length(reason)<=1000),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id), UNIQUE(org_id, agreement_id, version_no),
  FOREIGN KEY(org_id, agreement_id) REFERENCES royalty_agreements(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);

-- サイクルのフェーズ。計上月 → フェーズ → 締め月 → 報告期限・支払期限（締め月＋offset か月の day 日。'eom' は月末、月末を超える日は月末）
CREATE TABLE IF NOT EXISTS royalty_schedule_phases (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  schedule_version_id INTEGER NOT NULL,
  starts_month TEXT NOT NULL CHECK(starts_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(starts_month,6,2) BETWEEN '01' AND '12'),
  ends_month TEXT CHECK(ends_month IS NULL OR (ends_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(ends_month,6,2) BETWEEN '01' AND '12')),
  cycle_kind TEXT NOT NULL CHECK(cycle_kind IN ('monthly','quarterly','semiannual','annual','custom','manual','none')),
  anchor_month INTEGER CHECK(anchor_month IS NULL OR anchor_month BETWEEN 1 AND 12),
  custom_close_months TEXT CHECK(custom_close_months IS NULL OR length(custom_close_months) BETWEEN 7 AND 2000),
  first_close_immediate INTEGER NOT NULL DEFAULT 0 CHECK(first_close_immediate IN (0,1)),
  report_offset_months INTEGER NOT NULL DEFAULT 1 CHECK(report_offset_months BETWEEN 0 AND 24),
  report_day TEXT NOT NULL DEFAULT 'eom' CHECK(report_day='eom' OR report_day GLOB '[1-9]' OR report_day GLOB '[12][0-9]' OR report_day GLOB '3[01]'),
  payment_offset_months INTEGER NOT NULL DEFAULT 2 CHECK(payment_offset_months BETWEEN 0 AND 24),
  payment_day TEXT NOT NULL DEFAULT 'eom' CHECK(payment_day='eom' OR payment_day GLOB '[1-9]' OR payment_day GLOB '[12][0-9]' OR payment_day GLOB '3[01]'),
  note TEXT CHECK(note IS NULL OR length(note)<=500),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id),
  CHECK(ends_month IS NULL OR ends_month>=starts_month),
  CHECK((cycle_kind IN ('quarterly','semiannual','annual') AND anchor_month IS NOT NULL) OR (cycle_kind NOT IN ('quarterly','semiannual','annual') AND anchor_month IS NULL)),
  CHECK((cycle_kind='custom' AND custom_close_months IS NOT NULL) OR (cycle_kind<>'custom' AND custom_close_months IS NULL)),
  CHECK(first_close_immediate=0 OR cycle_kind IN ('quarterly','semiannual','annual','custom')),
  FOREIGN KEY(org_id, schedule_version_id) REFERENCES royalty_schedule_versions(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);

-- 実額の計上（音楽著作権料の分配明細など）。取消は符号を反対にした行（reverses_entry_id）を足す
CREATE TABLE IF NOT EXISTS royalty_manual_accruals (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  agreement_id INTEGER NOT NULL,
  accrual_month TEXT NOT NULL CHECK(accrual_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(accrual_month,6,2) BETWEEN '01' AND '12'),
  amount_yen INTEGER NOT NULL CHECK(amount_yen<>0),
  source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  reverses_entry_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id),
  FOREIGN KEY(org_id, agreement_id) REFERENCES royalty_agreements(org_id, id),
  FOREIGN KEY(org_id, reverses_entry_id) REFERENCES royalty_manual_accruals(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
-- 同じ元資料を同じ契約・計上月へ二重に計上しない（取消の行は除く）。1つの行は1回だけ取り消せる
CREATE UNIQUE INDEX IF NOT EXISTS royalty_manual_accruals_source ON royalty_manual_accruals(org_id, agreement_id, accrual_month, source_reference) WHERE reverses_entry_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS royalty_manual_accruals_reversal ON royalty_manual_accruals(org_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- イレギュラーの台帳。adjust_amount 金額の調整（締め月の報告書に調整行）／move_period 締め月の変更／hold 保留にする／release 保留を解く／note 記録だけ。
-- 取消は同じ内容で reverses_entry_id を持つ行を足す（取消の行そのものは効かない）
CREATE TABLE IF NOT EXISTS royalty_irregular_entries (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  holder_partner_id INTEGER NOT NULL,
  agreement_id INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('adjust_amount','move_period','hold','release','note')),
  accrual_month TEXT CHECK(accrual_month IS NULL OR (accrual_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(accrual_month,6,2) BETWEEN '01' AND '12')),
  close_month TEXT CHECK(close_month IS NULL OR (close_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(close_month,6,2) BETWEEN '01' AND '12')),
  amount_yen INTEGER,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  source_reference TEXT CHECK(source_reference IS NULL OR length(source_reference)<=200),
  reverses_entry_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id),
  CHECK(
    (kind='adjust_amount' AND close_month IS NOT NULL AND amount_yen IS NOT NULL AND amount_yen<>0) OR
    (kind='move_period' AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND close_month IS NOT NULL AND close_month>=accrual_month AND amount_yen IS NULL) OR
    (kind IN ('hold','release') AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND close_month IS NULL AND amount_yen IS NULL) OR
    (kind='note' AND amount_yen IS NULL)
  ),
  FOREIGN KEY(org_id, holder_partner_id) REFERENCES partners(org_id, id),
  FOREIGN KEY(org_id, agreement_id) REFERENCES royalty_agreements(org_id, id),
  FOREIGN KEY(org_id, reverses_entry_id) REFERENCES royalty_irregular_entries(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS royalty_irregular_entries_by_holder ON royalty_irregular_entries(org_id, holder_partner_id);
CREATE UNIQUE INDEX IF NOT EXISTS royalty_irregular_entries_reversal ON royalty_irregular_entries(org_id, reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

-- 報告書の確定版（権利者×締め月）。取消されていない版は1つ。前の確定版（同じ権利者で締め月が直前のもの）の翌期繰越を前期繰越に引き継ぐ。
-- 前期繰越＋当期＋調整−前払金の充当＝支払予定額＋翌期繰越。明細の行数（line_count）まで行を足すと、行の和を確かめる。
CREATE TABLE IF NOT EXISTS royalty_statements (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  holder_partner_id INTEGER NOT NULL,
  close_month TEXT NOT NULL CHECK(close_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(close_month,6,2) BETWEEN '01' AND '12'),
  report_due_on TEXT CHECK(report_due_on IS NULL OR report_due_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  payment_due_on TEXT CHECK(payment_due_on IS NULL OR payment_due_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  version_no INTEGER NOT NULL CHECK(version_no>0),
  previous_statement_id INTEGER,
  calculation_version TEXT NOT NULL CHECK(calculation_version IN ('royalty-cycle-v1')),
  as_of TEXT NOT NULL CHECK(as_of GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  calculation_json TEXT NOT NULL CHECK(json_valid(calculation_json)),
  royalty_yen INTEGER NOT NULL,
  adjustment_yen INTEGER NOT NULL,
  advance_recouped_yen INTEGER NOT NULL,
  carried_in_yen INTEGER NOT NULL,
  payable_yen INTEGER NOT NULL CHECK(payable_yen>=0),
  carried_out_yen INTEGER NOT NULL,
  hold_count INTEGER NOT NULL CHECK(hold_count>=0),
  line_count INTEGER NOT NULL CHECK(line_count>=0),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id), UNIQUE(org_id, holder_partner_id, close_month, version_no),
  CHECK(carried_in_yen+royalty_yen+adjustment_yen-advance_recouped_yen=payable_yen+carried_out_yen),
  CHECK(line_count>0 OR (royalty_yen=0 AND adjustment_yen=0 AND advance_recouped_yen=0)),
  FOREIGN KEY(org_id, holder_partner_id) REFERENCES partners(org_id, id),
  FOREIGN KEY(org_id, previous_statement_id) REFERENCES royalty_statements(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS royalty_statements_by_holder ON royalty_statements(org_id, holder_partner_id, close_month);

CREATE TABLE IF NOT EXISTS royalty_statement_voids (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  statement_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id), UNIQUE(org_id, statement_id),
  FOREIGN KEY(org_id, statement_id) REFERENCES royalty_statements(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);

-- 報告書の明細。accrual 当期の計上月／revision 報告後の修正・締め月を過ぎてからの計上（差額）／adjustment イレギュラーの金額の調整／advance_recoup 前払金の充当
CREATE TABLE IF NOT EXISTS royalty_statement_lines (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  statement_id INTEGER NOT NULL,
  line_no INTEGER NOT NULL CHECK(line_no>0),
  line_kind TEXT NOT NULL CHECK(line_kind IN ('accrual','revision','adjustment','advance_recoup')),
  agreement_id INTEGER,
  accrual_month TEXT CHECK(accrual_month IS NULL OR (accrual_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(accrual_month,6,2) BETWEEN '01' AND '12')),
  term_version_id INTEGER,
  irregular_entry_id INTEGER,
  sales_yen INTEGER,
  window_fee_yen INTEGER,
  expense_yen INTEGER,
  committee_income_yen INTEGER,
  base_yen INTEGER,
  rate_bps INTEGER CHECK(rate_bps IS NULL OR rate_bps BETWEEN 0 AND 10000),
  amount_yen INTEGER NOT NULL,
  note TEXT CHECK(note IS NULL OR length(note)<=500),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id), UNIQUE(org_id, statement_id, line_no),
  CHECK(
    (line_kind IN ('accrual','revision') AND agreement_id IS NOT NULL AND accrual_month IS NOT NULL AND irregular_entry_id IS NULL) OR
    (line_kind='adjustment' AND irregular_entry_id IS NOT NULL) OR
    (line_kind='advance_recoup' AND agreement_id IS NOT NULL AND accrual_month IS NULL AND irregular_entry_id IS NULL)
  ),
  FOREIGN KEY(org_id, statement_id) REFERENCES royalty_statements(org_id, id),
  FOREIGN KEY(org_id, agreement_id) REFERENCES royalty_agreements(org_id, id),
  FOREIGN KEY(org_id, term_version_id) REFERENCES royalty_term_versions(org_id, id),
  FOREIGN KEY(org_id, irregular_entry_id) REFERENCES royalty_irregular_entries(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS royalty_statement_lines_by_agreement ON royalty_statement_lines(org_id, agreement_id, accrual_month);

-- 実際の報告日・支払の記録。支払は金額（正）と識別番号が必須。取消は同じ報告書・同じ種類・同じ金額で reverses_event_id を持つ行を足す（理由必須）
CREATE TABLE IF NOT EXISTS royalty_statement_events (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  statement_id INTEGER NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('reported','paid')),
  occurred_on TEXT NOT NULL CHECK(occurred_on GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]'),
  amount_yen INTEGER,
  reference TEXT CHECK(reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 200),
  note TEXT CHECK(note IS NULL OR length(note)<=1000),
  reverses_event_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, id),
  CHECK((event_kind='reported' AND amount_yen IS NULL) OR (event_kind='paid' AND amount_yen IS NOT NULL AND amount_yen>0 AND reference IS NOT NULL)),
  CHECK(reverses_event_id IS NULL OR (note IS NOT NULL AND length(trim(note))>0)),
  FOREIGN KEY(org_id, statement_id) REFERENCES royalty_statements(org_id, id),
  FOREIGN KEY(org_id, reverses_event_id) REFERENCES royalty_statement_events(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE INDEX IF NOT EXISTS royalty_statement_events_by_statement ON royalty_statement_events(org_id, statement_id);
CREATE UNIQUE INDEX IF NOT EXISTS royalty_statement_events_reversal ON royalty_statement_events(org_id, reverses_event_id) WHERE reverses_event_id IS NOT NULL;

-- ここから検査のトリガー（変更・削除の禁止と、版・台帳・報告書の整合）

CREATE TRIGGER IF NOT EXISTS royalty_agreements_no_update BEFORE UPDATE ON royalty_agreements
BEGIN SELECT RAISE(ABORT, 'ロイヤリティ契約は変更できません。条件版・サイクルの版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_agreements_no_delete BEFORE DELETE ON royalty_agreements
BEGIN SELECT RAISE(ABORT, 'ロイヤリティ契約は削除できません'); END;

CREATE TRIGGER IF NOT EXISTS royalty_term_versions_no_update BEFORE UPDATE ON royalty_term_versions
BEGIN SELECT RAISE(ABORT, '条件版は変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_versions_no_delete BEFORE DELETE ON royalty_term_versions
BEGIN SELECT RAISE(ABORT, '条件版は削除できません'); END;
-- 版番号は1から順に、適用開始月は前の版より後
CREATE TRIGGER IF NOT EXISTS royalty_term_versions_order BEFORE INSERT ON royalty_term_versions BEGIN
  SELECT CASE WHEN NEW.version_no <> (SELECT COALESCE(MAX(version_no), 0) + 1 FROM royalty_term_versions WHERE org_id=NEW.org_id AND agreement_id=NEW.agreement_id)
    THEN RAISE(ABORT, '条件版の版番号が連続していません。再読込してから追加してください') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_term_versions WHERE org_id=NEW.org_id AND agreement_id=NEW.agreement_id AND effective_from>=NEW.effective_from)
    THEN RAISE(ABORT, '条件版の適用開始月は、前の版より後の月にしてください') END;
END;

CREATE TRIGGER IF NOT EXISTS royalty_term_channels_no_update BEFORE UPDATE ON royalty_term_channels
BEGIN SELECT RAISE(ABORT, '条件版の対象流通は変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_channels_no_delete BEFORE DELETE ON royalty_term_channels
BEGIN SELECT RAISE(ABORT, '条件版の対象流通は削除できません'); END;
-- 対象流通・控除費目は最新の版にだけ、報告書で使われる前に登録できる（後から版の意味を変えない）
CREATE TRIGGER IF NOT EXISTS royalty_term_channels_latest BEFORE INSERT ON royalty_term_channels
WHEN EXISTS (SELECT 1 FROM royalty_term_versions v JOIN royalty_term_versions n ON n.org_id=v.org_id AND n.agreement_id=v.agreement_id AND n.version_no>v.version_no
    WHERE v.org_id=NEW.org_id AND v.id=NEW.term_version_id)
  OR EXISTS (SELECT 1 FROM royalty_statement_lines l WHERE l.org_id=NEW.org_id AND l.term_version_id=NEW.term_version_id)
BEGIN SELECT RAISE(ABORT, '対象流通は、報告書で使われる前の最新の条件版にだけ登録できます'); END;

CREATE TRIGGER IF NOT EXISTS royalty_term_expense_categories_no_update BEFORE UPDATE ON royalty_term_expense_categories
BEGIN SELECT RAISE(ABORT, '控除する経費の費目は変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_expense_categories_no_delete BEFORE DELETE ON royalty_term_expense_categories
BEGIN SELECT RAISE(ABORT, '控除する経費の費目は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_expense_categories_base BEFORE INSERT ON royalty_term_expense_categories
WHEN (SELECT base_kind FROM royalty_term_versions WHERE org_id=NEW.org_id AND id=NEW.term_version_id) IS NULL
  OR (SELECT base_kind FROM royalty_term_versions WHERE org_id=NEW.org_id AND id=NEW.term_version_id) NOT IN ('after_window_fee_and_expenses','committee_income_after_expenses')
BEGIN SELECT RAISE(ABORT, '控除する経費の費目は、経費を差し引く基礎の条件版にだけ登録できます'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_expense_categories_latest BEFORE INSERT ON royalty_term_expense_categories
WHEN EXISTS (SELECT 1 FROM royalty_term_versions v JOIN royalty_term_versions n ON n.org_id=v.org_id AND n.agreement_id=v.agreement_id AND n.version_no>v.version_no
    WHERE v.org_id=NEW.org_id AND v.id=NEW.term_version_id)
  OR EXISTS (SELECT 1 FROM royalty_statement_lines l WHERE l.org_id=NEW.org_id AND l.term_version_id=NEW.term_version_id)
BEGIN SELECT RAISE(ABORT, '控除する経費の費目は、報告書で使われる前の最新の条件版にだけ登録できます'); END;

CREATE TRIGGER IF NOT EXISTS royalty_schedule_versions_no_update BEFORE UPDATE ON royalty_schedule_versions
BEGIN SELECT RAISE(ABORT, 'サイクルの版は変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_schedule_versions_no_delete BEFORE DELETE ON royalty_schedule_versions
BEGIN SELECT RAISE(ABORT, 'サイクルの版は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS royalty_schedule_versions_order BEFORE INSERT ON royalty_schedule_versions
WHEN NEW.version_no <> (SELECT COALESCE(MAX(version_no), 0) + 1 FROM royalty_schedule_versions WHERE org_id=NEW.org_id AND agreement_id=NEW.agreement_id)
BEGIN SELECT RAISE(ABORT, 'サイクルの版番号が連続していません。再読込してから追加してください'); END;

CREATE TRIGGER IF NOT EXISTS royalty_schedule_phases_no_update BEFORE UPDATE ON royalty_schedule_phases
BEGIN SELECT RAISE(ABORT, 'サイクルのフェーズは変更できません。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_schedule_phases_no_delete BEFORE DELETE ON royalty_schedule_phases
BEGIN SELECT RAISE(ABORT, 'サイクルのフェーズは削除できません'); END;
-- フェーズは最新のサイクルの版にだけ足せ、同じ版の中で期間が重ならない（終了月が空欄なら以降ずっと）
CREATE TRIGGER IF NOT EXISTS royalty_schedule_phases_valid BEFORE INSERT ON royalty_schedule_phases BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_schedule_versions v JOIN royalty_schedule_versions n ON n.org_id=v.org_id AND n.agreement_id=v.agreement_id AND n.version_no>v.version_no
      WHERE v.org_id=NEW.org_id AND v.id=NEW.schedule_version_id)
    THEN RAISE(ABORT, 'フェーズは最新のサイクルの版にだけ足せます') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_schedule_phases p WHERE p.org_id=NEW.org_id AND p.schedule_version_id=NEW.schedule_version_id
      AND p.starts_month<=COALESCE(NEW.ends_month, '9999-12') AND NEW.starts_month<=COALESCE(p.ends_month, '9999-12'))
    THEN RAISE(ABORT, 'サイクルのフェーズの期間が重なっています') END;
END;

CREATE TRIGGER IF NOT EXISTS royalty_manual_accruals_no_update BEFORE UPDATE ON royalty_manual_accruals
BEGIN SELECT RAISE(ABORT, '実額の計上は変更できません。取り消して計上し直してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_manual_accruals_no_delete BEFORE DELETE ON royalty_manual_accruals
BEGIN SELECT RAISE(ABORT, '実額の計上は削除できません。取消の行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_manual_accruals_reversal BEFORE INSERT ON royalty_manual_accruals
WHEN NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM royalty_manual_accruals o
  WHERE o.org_id=NEW.org_id AND o.id=NEW.reverses_entry_id AND o.reverses_entry_id IS NULL
    AND o.agreement_id=NEW.agreement_id AND o.accrual_month=NEW.accrual_month AND o.amount_yen=-NEW.amount_yen)
BEGIN SELECT RAISE(ABORT, '取り消す実額の計上と、契約・計上月・金額（符号が反対）が一致しません'); END;

CREATE TRIGGER IF NOT EXISTS royalty_irregular_entries_no_update BEFORE UPDATE ON royalty_irregular_entries
BEGIN SELECT RAISE(ABORT, 'イレギュラーの記録は変更できません。取り消して記録し直してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_irregular_entries_no_delete BEFORE DELETE ON royalty_irregular_entries
BEGIN SELECT RAISE(ABORT, 'イレギュラーの記録は削除できません。取消の行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_irregular_entries_valid BEFORE INSERT ON royalty_irregular_entries BEGIN
  SELECT CASE WHEN NEW.agreement_id IS NOT NULL AND (SELECT holder_partner_id FROM royalty_agreements WHERE org_id=NEW.org_id AND id=NEW.agreement_id) IS NOT NEW.holder_partner_id
    THEN RAISE(ABORT, 'イレギュラーの権利者が契約の権利者と一致しません') END;
  SELECT CASE WHEN NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM royalty_irregular_entries o
      WHERE o.org_id=NEW.org_id AND o.id=NEW.reverses_entry_id AND o.reverses_entry_id IS NULL AND o.kind=NEW.kind
        AND o.holder_partner_id=NEW.holder_partner_id AND o.agreement_id IS NEW.agreement_id AND o.accrual_month IS NEW.accrual_month
        AND o.close_month IS NEW.close_month AND o.amount_yen IS NEW.amount_yen)
    THEN RAISE(ABORT, '取り消すイレギュラーの記録と内容が一致しません') END;
END;

CREATE TRIGGER IF NOT EXISTS royalty_statements_no_update BEFORE UPDATE ON royalty_statements
BEGIN SELECT RAISE(ABORT, '報告書の確定版は変更できません。取り消して作り直してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statements_no_delete BEFORE DELETE ON royalty_statements
BEGIN SELECT RAISE(ABORT, '報告書の確定版は削除できません'); END;
-- 権利者×締め月で取消されていない版は1つ。版番号は1から順。後の締め月の確定版があるときは作れない（繰越の順を崩さない）。
-- 前の確定版は、同じ権利者で締め月が直前の取消されていない版。前期繰越はその翌期繰越と一致する
CREATE TRIGGER IF NOT EXISTS royalty_statements_valid BEFORE INSERT ON royalty_statements BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_statements s WHERE s.org_id=NEW.org_id AND s.holder_partner_id=NEW.holder_partner_id AND s.close_month=NEW.close_month
      AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=s.org_id AND v.statement_id=s.id))
    THEN RAISE(ABORT, 'この権利者・締め月の報告書は作成済みです。取り消してから作り直してください') END;
  SELECT CASE WHEN NEW.version_no <> (SELECT COUNT(*) + 1 FROM royalty_statements s WHERE s.org_id=NEW.org_id AND s.holder_partner_id=NEW.holder_partner_id AND s.close_month=NEW.close_month)
    THEN RAISE(ABORT, '報告書の版番号が連続していません。再読込してから作成してください') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_statements s WHERE s.org_id=NEW.org_id AND s.holder_partner_id=NEW.holder_partner_id AND s.close_month>NEW.close_month
      AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=s.org_id AND v.statement_id=s.id))
    THEN RAISE(ABORT, '後の締め月の報告書が作成済みのため、この締め月の報告書は作れません') END;
  SELECT CASE WHEN NEW.previous_statement_id IS NOT (SELECT s.id FROM royalty_statements s WHERE s.org_id=NEW.org_id AND s.holder_partner_id=NEW.holder_partner_id AND s.close_month<NEW.close_month
      AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=s.org_id AND v.statement_id=s.id) ORDER BY s.close_month DESC LIMIT 1)
    THEN RAISE(ABORT, '前の報告書が最新ではありません。再読込してから作成してください') END;
  SELECT CASE WHEN NEW.carried_in_yen <> COALESCE((SELECT carried_out_yen FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.previous_statement_id), 0)
    THEN RAISE(ABORT, '前期繰越が前の報告書の翌期繰越と一致しません') END;
END;

CREATE TRIGGER IF NOT EXISTS royalty_statement_voids_no_update BEFORE UPDATE ON royalty_statement_voids
BEGIN SELECT RAISE(ABORT, '報告書の取消記録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statement_voids_no_delete BEFORE DELETE ON royalty_statement_voids
BEGIN SELECT RAISE(ABORT, '報告書の取消記録は削除できません'); END;
-- 取り消せるのは、その権利者の最新の確定版で、取消していない支払の記録が無いものだけ
CREATE TRIGGER IF NOT EXISTS royalty_statement_voids_valid BEFORE INSERT ON royalty_statement_voids BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_statements t JOIN royalty_statements s ON s.org_id=t.org_id AND s.holder_partner_id=t.holder_partner_id AND s.close_month>t.close_month
      WHERE t.org_id=NEW.org_id AND t.id=NEW.statement_id
        AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=s.org_id AND v.statement_id=s.id))
    THEN RAISE(ABORT, '後の締め月の報告書があるため取り消せません。後の報告書から順に取り消してください') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_statement_events e WHERE e.org_id=NEW.org_id AND e.statement_id=NEW.statement_id AND e.event_kind='paid' AND e.reverses_event_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM royalty_statement_events r WHERE r.org_id=e.org_id AND r.reverses_event_id=e.id))
    THEN RAISE(ABORT, '支払の記録があるため取り消せません。先に支払の記録を取り消してください') END;
END;

CREATE TRIGGER IF NOT EXISTS royalty_statement_lines_no_update BEFORE UPDATE ON royalty_statement_lines
BEGIN SELECT RAISE(ABORT, '報告書の明細は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statement_lines_no_delete BEFORE DELETE ON royalty_statement_lines
BEGIN SELECT RAISE(ABORT, '報告書の明細は削除できません'); END;
-- 明細は報告書の行数まで。契約の権利者は報告書の権利者と同じ。取り消した報告書には足せない
CREATE TRIGGER IF NOT EXISTS royalty_statement_lines_valid BEFORE INSERT ON royalty_statement_lines BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM royalty_statement_lines l WHERE l.org_id=NEW.org_id AND l.statement_id=NEW.statement_id)
      >= (SELECT line_count FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
    THEN RAISE(ABORT, '報告書の明細の行数が確定版と一致しません') END;
  SELECT CASE WHEN NEW.agreement_id IS NOT NULL AND (SELECT holder_partner_id FROM royalty_agreements WHERE org_id=NEW.org_id AND id=NEW.agreement_id)
      IS NOT (SELECT holder_partner_id FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
    THEN RAISE(ABORT, '明細の契約の権利者が報告書の権利者と一致しません') END;
  SELECT CASE WHEN NEW.irregular_entry_id IS NOT NULL AND (SELECT holder_partner_id FROM royalty_irregular_entries WHERE org_id=NEW.org_id AND id=NEW.irregular_entry_id)
      IS NOT (SELECT holder_partner_id FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
    THEN RAISE(ABORT, '明細のイレギュラーの権利者が報告書の権利者と一致しません') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=NEW.org_id AND v.statement_id=NEW.statement_id)
    THEN RAISE(ABORT, '取り消した報告書には明細を足せません') END;
END;
-- 最後の行を足したとき、種類ごとの和が確定版の当期・調整・前払金の充当と一致すること
CREATE TRIGGER IF NOT EXISTS royalty_statement_lines_complete AFTER INSERT ON royalty_statement_lines
WHEN (SELECT COUNT(*) FROM royalty_statement_lines l WHERE l.org_id=NEW.org_id AND l.statement_id=NEW.statement_id)
  = (SELECT line_count FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
BEGIN
  SELECT CASE WHEN (SELECT COALESCE(SUM(amount_yen), 0) FROM royalty_statement_lines WHERE org_id=NEW.org_id AND statement_id=NEW.statement_id AND line_kind IN ('accrual','revision'))
      <> (SELECT royalty_yen FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
    OR (SELECT COALESCE(SUM(amount_yen), 0) FROM royalty_statement_lines WHERE org_id=NEW.org_id AND statement_id=NEW.statement_id AND line_kind='adjustment')
      <> (SELECT adjustment_yen FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
    OR (SELECT COALESCE(SUM(amount_yen), 0) FROM royalty_statement_lines WHERE org_id=NEW.org_id AND statement_id=NEW.statement_id AND line_kind='advance_recoup')
      <> (SELECT advance_recouped_yen FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
    THEN RAISE(ABORT, '報告書の明細の和が確定版の金額と一致しません') END;
END;

CREATE TRIGGER IF NOT EXISTS royalty_statement_events_no_update BEFORE UPDATE ON royalty_statement_events
BEGIN SELECT RAISE(ABORT, '報告・支払の記録は変更できません。取消の記録を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statement_events_no_delete BEFORE DELETE ON royalty_statement_events
BEGIN SELECT RAISE(ABORT, '報告・支払の記録は削除できません。取消の記録を足してください'); END;
-- 取り消した報告書には記録を足せない。報告の記録は取消していないものが1つだけ。支払の合計は支払予定額まで。
-- 取消は同じ報告書・同じ種類・同じ金額の、取消でない記録を指し、日付はその記録の日以後（二重の取消は一意索引で止める）
CREATE TRIGGER IF NOT EXISTS royalty_statement_events_valid BEFORE INSERT ON royalty_statement_events BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=NEW.org_id AND v.statement_id=NEW.statement_id)
    THEN RAISE(ABORT, '取り消した報告書には報告・支払を記録できません') END;
  SELECT CASE WHEN NEW.reverses_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM royalty_statement_events o
      WHERE o.org_id=NEW.org_id AND o.id=NEW.reverses_event_id AND o.statement_id=NEW.statement_id AND o.reverses_event_id IS NULL
        AND o.event_kind=NEW.event_kind AND o.amount_yen IS NEW.amount_yen AND o.occurred_on<=NEW.occurred_on)
    THEN RAISE(ABORT, '取り消す記録と、報告書・種類・金額・日付が一致しません') END;
  SELECT CASE WHEN NEW.reverses_event_id IS NULL AND NEW.event_kind='reported' AND EXISTS (SELECT 1 FROM royalty_statement_events e
      WHERE e.org_id=NEW.org_id AND e.statement_id=NEW.statement_id AND e.event_kind='reported' AND e.reverses_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM royalty_statement_events r WHERE r.org_id=e.org_id AND r.reverses_event_id=e.id))
    THEN RAISE(ABORT, '報告の記録は登録済みです。日付を直すときは取り消してから記録してください') END;
  SELECT CASE WHEN NEW.reverses_event_id IS NULL AND NEW.event_kind='paid' AND COALESCE((SELECT SUM(e.amount_yen) FROM royalty_statement_events e
      WHERE e.org_id=NEW.org_id AND e.statement_id=NEW.statement_id AND e.event_kind='paid' AND e.reverses_event_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM royalty_statement_events r WHERE r.org_id=e.org_id AND r.reverses_event_id=e.id)), 0) + NEW.amount_yen
      > (SELECT payable_yen FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id)
    THEN RAISE(ABORT, '支払の合計が報告書の支払予定額を超えます') END;
END;

-- ここから 2026-09-25 のレビューで足した検査（追加だけ。既存の表は変えない）

-- 報告書を作り始める締め月（移行）は、この契約の明細を含む確定版（取り消していないもの）の締め月より後にできない
-- （報告済みの計上月を「以前の仕組みで報告済み」と「この仕組みで報告済み」の両方で数えない）
CREATE TRIGGER IF NOT EXISTS royalty_schedule_versions_statements_from BEFORE INSERT ON royalty_schedule_versions
WHEN NEW.statements_from IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_statement_lines l JOIN royalty_statements s ON s.org_id=l.org_id AND s.id=l.statement_id
    WHERE l.org_id=NEW.org_id AND l.agreement_id=NEW.agreement_id AND s.close_month<NEW.statements_from
      AND NOT EXISTS (SELECT 1 FROM royalty_statement_voids v WHERE v.org_id=s.org_id AND v.statement_id=s.id))
BEGIN SELECT RAISE(ABORT, '確定版がある締め月は移行前（以前の仕組みで報告済み）にできません。報告書を作り始める締め月を、この契約の明細を含む最初の確定版の締め月以前にしてください'); END;

-- 報告書の確定版の計算の内容の分割保存。クラウド（D1）は1つの値を128KBまでしか入れられないため、大きい内容は
-- royalty_statements.calculation_json に {"calculationParts": 分割数, "calculationBytes": バイト数} だけを入れ、内容はこの表の part_no 順の連結にする
CREATE TABLE IF NOT EXISTS royalty_statement_calculation_parts (
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  statement_id INTEGER NOT NULL,
  part_no INTEGER NOT NULL CHECK(part_no>0),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 100000),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, statement_id, part_no),
  FOREIGN KEY(org_id, statement_id) REFERENCES royalty_statements(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE TRIGGER IF NOT EXISTS royalty_statement_calculation_parts_no_update BEFORE UPDATE ON royalty_statement_calculation_parts
BEGIN SELECT RAISE(ABORT, '報告書の計算の内容は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statement_calculation_parts_no_delete BEFORE DELETE ON royalty_statement_calculation_parts
BEGIN SELECT RAISE(ABORT, '報告書の計算の内容は削除できません'); END;
-- 分割は1から順に、確定版に記録した分割数まで（同じ番号の置き換えもこれで止まる）
CREATE TRIGGER IF NOT EXISTS royalty_statement_calculation_parts_valid BEFORE INSERT ON royalty_statement_calculation_parts
WHEN NEW.part_no <> (SELECT COUNT(*) + 1 FROM royalty_statement_calculation_parts p WHERE p.org_id=NEW.org_id AND p.statement_id=NEW.statement_id)
  OR NEW.part_no > COALESCE((SELECT json_extract(calculation_json, '$.calculationParts') FROM royalty_statements WHERE org_id=NEW.org_id AND id=NEW.statement_id), 0)
BEGIN SELECT RAISE(ABORT, '報告書の計算の内容の分割が確定版の記録と一致しません'); END;

-- INSERT OR REPLACE（衝突した行を消して入れ直す）で、変更・削除の禁止を回り込ませない。
-- REPLACE の削除では DELETE のトリガーが動かない（recursive_triggers が OFF）ため、同じ番号・同じ一意の値の行があれば入れる前に止める
CREATE TRIGGER IF NOT EXISTS royalty_agreements_no_replace BEFORE INSERT ON royalty_agreements
WHEN EXISTS (SELECT 1 FROM royalty_agreements WHERE id=NEW.id)
  OR EXISTS (SELECT 1 FROM royalty_agreements WHERE org_id=NEW.org_id AND agreement_code=NEW.agreement_code)
BEGIN SELECT RAISE(ABORT, 'ロイヤリティ契約は登録済みです（同じ番号・契約コードの行は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_versions_no_replace BEFORE INSERT ON royalty_term_versions
WHEN EXISTS (SELECT 1 FROM royalty_term_versions WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, '条件版は変更できません（同じ番号の行は置き換えられません）。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_channels_no_replace BEFORE INSERT ON royalty_term_channels
WHEN EXISTS (SELECT 1 FROM royalty_term_channels WHERE org_id=NEW.org_id AND term_version_id=NEW.term_version_id AND channel_group=NEW.channel_group)
BEGIN SELECT RAISE(ABORT, '条件版の対象流通は登録済みです（行は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_term_expense_categories_no_replace BEFORE INSERT ON royalty_term_expense_categories
WHEN EXISTS (SELECT 1 FROM royalty_term_expense_categories WHERE org_id=NEW.org_id AND term_version_id=NEW.term_version_id AND category=NEW.category)
BEGIN SELECT RAISE(ABORT, '控除する経費の費目は登録済みです（行は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_schedule_versions_no_replace BEFORE INSERT ON royalty_schedule_versions
WHEN EXISTS (SELECT 1 FROM royalty_schedule_versions WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'サイクルの版は変更できません（同じ番号の行は置き換えられません）。新しい版を足してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_schedule_phases_no_replace BEFORE INSERT ON royalty_schedule_phases
WHEN EXISTS (SELECT 1 FROM royalty_schedule_phases WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'サイクルのフェーズは変更できません（同じ番号の行は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_manual_accruals_no_replace BEFORE INSERT ON royalty_manual_accruals
WHEN EXISTS (SELECT 1 FROM royalty_manual_accruals WHERE id=NEW.id)
  OR (NEW.reverses_entry_id IS NULL AND EXISTS (SELECT 1 FROM royalty_manual_accruals WHERE org_id=NEW.org_id AND agreement_id=NEW.agreement_id
    AND accrual_month=NEW.accrual_month AND source_reference=NEW.source_reference AND reverses_entry_id IS NULL))
  OR (NEW.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_manual_accruals WHERE org_id=NEW.org_id AND reverses_entry_id=NEW.reverses_entry_id))
BEGIN SELECT RAISE(ABORT, '実額の計上は変更できません（同じ番号・同じ元資料の計上・取消済みの計上の行は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_irregular_entries_no_replace BEFORE INSERT ON royalty_irregular_entries
WHEN EXISTS (SELECT 1 FROM royalty_irregular_entries WHERE id=NEW.id)
  OR (NEW.reverses_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_irregular_entries WHERE org_id=NEW.org_id AND reverses_entry_id=NEW.reverses_entry_id))
BEGIN SELECT RAISE(ABORT, 'イレギュラーの記録は変更できません（同じ番号の行・取消済みの記録の取消は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statements_no_replace BEFORE INSERT ON royalty_statements
WHEN EXISTS (SELECT 1 FROM royalty_statements WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, '報告書の確定版は変更できません（同じ番号の行は置き換えられません）。再読込してから作成してください'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statement_voids_no_replace BEFORE INSERT ON royalty_statement_voids
WHEN EXISTS (SELECT 1 FROM royalty_statement_voids WHERE id=NEW.id)
  OR EXISTS (SELECT 1 FROM royalty_statement_voids WHERE org_id=NEW.org_id AND statement_id=NEW.statement_id)
BEGIN SELECT RAISE(ABORT, '報告書の取消記録は変更できません（取消済みの報告書・同じ番号の行は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statement_lines_no_replace BEFORE INSERT ON royalty_statement_lines
WHEN EXISTS (SELECT 1 FROM royalty_statement_lines WHERE id=NEW.id)
  OR EXISTS (SELECT 1 FROM royalty_statement_lines WHERE org_id=NEW.org_id AND statement_id=NEW.statement_id AND line_no=NEW.line_no)
BEGIN SELECT RAISE(ABORT, '報告書の明細は変更できません（同じ番号・同じ行番号の行は置き換えられません）'); END;
CREATE TRIGGER IF NOT EXISTS royalty_statement_events_no_replace BEFORE INSERT ON royalty_statement_events
WHEN EXISTS (SELECT 1 FROM royalty_statement_events WHERE id=NEW.id)
  OR (NEW.reverses_event_id IS NOT NULL AND EXISTS (SELECT 1 FROM royalty_statement_events WHERE org_id=NEW.org_id AND reverses_event_id=NEW.reverses_event_id))
BEGIN SELECT RAISE(ABORT, '報告・支払の記録は変更できません（同じ番号の行・取消済みの記録の取消は置き換えられません）'); END;

-- 製作委員会の追加表（0003）。窓口手数料を複数社で分けるときの取り分（例: 配信・放送の窓口手数料を2社で半分ずつ）。
-- 窓口（committee_term_windows）は条件版に付く変更不可の行なので、取り分も窓口ごとに1回だけ登録する（変える時は新しい条件版）。
-- 行が無い窓口は、窓口の受取先（window_partner_id）1社が手数料をすべて受け取る。合計は 10000bp（アプリで検査、超過はトリガーで拒否）。
CREATE TABLE IF NOT EXISTS committee_term_window_fee_shares (
  org_id INTEGER NOT NULL, window_id INTEGER NOT NULL, partner_id INTEGER NOT NULL,
  share_bps INTEGER NOT NULL CHECK(share_bps BETWEEN 1 AND 10000),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, window_id, partner_id),
  FOREIGN KEY(org_id, window_id) REFERENCES committee_term_windows(org_id, id),
  FOREIGN KEY(org_id, partner_id) REFERENCES partners(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE TRIGGER IF NOT EXISTS committee_window_fee_shares_no_update BEFORE UPDATE ON committee_term_window_fee_shares
BEGIN SELECT RAISE(ABORT, '窓口手数料の取り分は変更できません。新しい条件版で登録してください'); END;
CREATE TRIGGER IF NOT EXISTS committee_window_fee_shares_no_delete BEFORE DELETE ON committee_term_window_fee_shares
BEGIN SELECT RAISE(ABORT, '窓口手数料の取り分は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS committee_window_fee_shares_total BEFORE INSERT ON committee_term_window_fee_shares
WHEN (SELECT COALESCE(SUM(share_bps), 0) FROM committee_term_window_fee_shares WHERE org_id=NEW.org_id AND window_id=NEW.window_id) + NEW.share_bps > 10000
BEGIN SELECT RAISE(ABORT, '窓口手数料の取り分の合計は100%以内にしてください'); END;

-- 条件版の適用開始月（計上月 YYYY-MM）。条件版（committee_term_versions）に列を足せないため別の表に持つ（1条件版に1行、変更・削除不可）。
-- 計上月ごとに「適用開始月がその月以前の条件版のうち、版番号が最大のもの」を使う。行の無い条件版は最初の月から適用する
-- （この表を足す前の条件版と、契約の版1）。新しい版は適用開始月から後のすべての月で前の版に代わり、それより前の月は前の版のまま。
-- 適用開始月を決めずに作った版（最初の月から）が確定済みのロイヤリティ報告書の計上月にかかるときは、画面・APIで確認を取ってから作る。
CREATE TABLE IF NOT EXISTS committee_term_version_effective (
  org_id INTEGER NOT NULL, term_version_id INTEGER NOT NULL,
  effective_from TEXT NOT NULL CHECK(effective_from GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]' AND substr(effective_from,6,2) BETWEEN '01' AND '12'),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id, term_version_id),
  FOREIGN KEY(org_id, term_version_id) REFERENCES committee_term_versions(org_id, id),
  FOREIGN KEY(org_id, created_by) REFERENCES memberships(org_id, user_id)
);
CREATE TRIGGER IF NOT EXISTS committee_term_version_effective_no_update BEFORE UPDATE ON committee_term_version_effective
BEGIN SELECT RAISE(ABORT, '条件版の適用開始月は変更できません。新しい条件版で登録してください'); END;
CREATE TRIGGER IF NOT EXISTS committee_term_version_effective_no_delete BEFORE DELETE ON committee_term_version_effective
BEGIN SELECT RAISE(ABORT, '条件版の適用開始月は削除できません'); END;

-- 作品で絞って売上明細を読むための索引（sales/channel-group.mjs の workSaleLines。組織全体を読まない）
CREATE INDEX IF NOT EXISTS committee_sale_lines_product_month_idx ON sale_lines(org_id, product_id, accounting_month);
CREATE INDEX IF NOT EXISTS committee_sale_lines_work_month_idx ON sale_lines(org_id, work_id, accounting_month);
CREATE INDEX IF NOT EXISTS committee_product_works_work_idx ON product_works(org_id, work_id, product_id);

-- 受領原本を作品から切り離し、作品・商品へ付け替え・分割するための表（0003）。
-- 設計: docs/platform/team-development/royalty-committee-design.md §5。すべて追加だけ・変更と削除はトリガーで禁止。
-- 流れ: 原本（作品を持たない）→ 表の選択（版）→ 割り当て（版。1つの作品／商品コードの列／作品コードの列）
--       → 作品ごとの分割（割り当ての版×選択の版×分け方の照合値ごと）→ 分割ごとの登録（報告1件）。
-- 旧方式の原本（workflow_raw_artifacts）は、付け替え・続きの取込のときに参照行（storage='legacy_artifact'）を作って引き継ぐ。
-- 旧経路と新経路で同じファイルを二重に取り込まないことは、この表のトリガーと、旧経路の書き込みと同じ batch の検査
-- （transaction_guards。src/workflow.mjs・src/app.mjs の commitImport）の両方で保証する。既存の表にはトリガーを足さない。

-- 原本。ハッシュで組織内一意。storage='inline' は中身を持ち、'legacy_artifact' は旧原本を参照するだけ（中身は複製しない）。
CREATE TABLE IF NOT EXISTS sales_source_files (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL,
  storage TEXT NOT NULL CHECK(storage IN ('inline','legacy_artifact')),
  file_name TEXT NOT NULL CHECK(length(trim(file_name)) BETWEEN 1 AND 240),
  media_type TEXT, byte_length INTEGER NOT NULL CHECK(byte_length>0),
  raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64),
  original_base64 TEXT, extraction_json TEXT,
  extractor_name TEXT NOT NULL, extractor_version TEXT NOT NULL,
  extraction_status TEXT NOT NULL CHECK(extraction_status IN ('extracted','ocr_pending')),
  legacy_artifact_id INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,raw_sha256), UNIQUE(org_id,legacy_artifact_id),
  FOREIGN KEY(org_id,legacy_artifact_id) REFERENCES workflow_raw_artifacts(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((storage='inline' AND original_base64 IS NOT NULL AND extraction_json IS NOT NULL AND legacy_artifact_id IS NULL)
     OR (storage='legacy_artifact' AND original_base64 IS NULL AND extraction_json IS NULL AND legacy_artifact_id IS NOT NULL))
);

-- 表の選択（見出しの行と取り込まない行）。版ごとに追加する。excluded_json は取り込まない行・理由・金額。
CREATE TABLE IF NOT EXISTS sales_source_selections (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  sheet_name TEXT NOT NULL, header_row INTEGER NOT NULL CHECK(header_row>0),
  canonical_csv TEXT NOT NULL, canonical_sha256 TEXT NOT NULL CHECK(length(canonical_sha256)=64),
  source_rows_json TEXT NOT NULL, excluded_json TEXT NOT NULL DEFAULT '[]', suggestions_json TEXT NOT NULL DEFAULT '[]',
  suggestion_source TEXT NOT NULL CHECK(suggestion_source IN ('rule-based','imported-ai','configured-ai')),
  legacy_selection_id INTEGER,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,file_id,id), UNIQUE(org_id,file_id,version_no),
  FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
  FOREIGN KEY(org_id,legacy_selection_id) REFERENCES workflow_report_selections(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 割り当て（版）。どの版が有効かは最大の版番号で決め、状態の列は持たない。付け替えは新しい版を足す（理由必須）。
-- single_work: 全行を1つの作品へ。by_product: 商品コードの列 → products.sku → product_works で作品を決める。
-- by_work_column: 作品コードの列 → works.code。商品コードの列を併せて指定すると、行ごとに商品も照合する。
CREATE TABLE IF NOT EXISTS sales_source_bindings (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, version_no INTEGER NOT NULL CHECK(version_no>0),
  mode TEXT NOT NULL CHECK(mode IN ('single_work','by_product','by_work_column')),
  project_id INTEGER, work_id INTEGER, product_column TEXT, work_column TEXT,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,file_id,id), UNIQUE(org_id,file_id,version_no),
  FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
  CHECK((mode='single_work' AND project_id IS NOT NULL AND work_id IS NOT NULL AND product_column IS NULL AND work_column IS NULL)
     OR (mode='by_product' AND project_id IS NULL AND work_id IS NULL AND length(trim(product_column)) BETWEEN 1 AND 200 AND work_column IS NULL)
     OR (mode='by_work_column' AND project_id IS NULL AND work_id IS NULL AND length(trim(work_column)) BETWEEN 1 AND 200
         AND (product_column IS NULL OR length(trim(product_column)) BETWEEN 1 AND 200)))
);

-- 作品ごとの分割。1回の分け方（plan_sha256）で作品ごとに1行。分割後の表は D1 に置かず、選択版と行番号から同じ規則で作り直す。
-- product_map_json は商品コード → 商品ID と、そのときの配賦の写し（照合の根拠）。
CREATE TABLE IF NOT EXISTS sales_source_partitions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, selection_id INTEGER NOT NULL, binding_id INTEGER NOT NULL,
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64),
  project_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count>0), source_rows_json TEXT NOT NULL, product_map_json TEXT NOT NULL DEFAULT '[]',
  partition_sha256 TEXT NOT NULL CHECK(length(partition_sha256)=64),
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,work_id,id), UNIQUE(org_id,file_id,id), UNIQUE(org_id,binding_id,selection_id,plan_sha256,work_id),
  FOREIGN KEY(org_id,file_id,selection_id) REFERENCES sales_source_selections(org_id,file_id,id),
  FOREIGN KEY(org_id,file_id,binding_id) REFERENCES sales_source_bindings(org_id,file_id,id),
  FOREIGN KEY(org_id,project_id,work_id) REFERENCES works(org_id,project_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

-- 分割ごとの登録（報告1件）。1つのファイルの登録は、すべて同じ割り当て・選択・分け方でなければならない。
CREATE TABLE IF NOT EXISTS sales_source_commits (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, file_id INTEGER NOT NULL, partition_id INTEGER NOT NULL,
  binding_id INTEGER NOT NULL, selection_id INTEGER NOT NULL, work_id INTEGER NOT NULL,
  mapping_version_id INTEGER NOT NULL, report_id INTEGER NOT NULL, preview_token TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,partition_id), UNIQUE(org_id,report_id), UNIQUE(preview_token),
  FOREIGN KEY(org_id,file_id) REFERENCES sales_source_files(org_id,id),
  FOREIGN KEY(org_id,work_id,partition_id) REFERENCES sales_source_partitions(org_id,work_id,id),
  FOREIGN KEY(org_id,work_id,report_id) REFERENCES report_imports(org_id,work_id,id),
  FOREIGN KEY(org_id,mapping_version_id) REFERENCES report_mapping_versions(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE INDEX IF NOT EXISTS sales_source_commits_file_idx ON sales_source_commits(org_id,file_id);

-- 変更・削除の禁止（直すときは版・付け替えを足す）
CREATE TRIGGER IF NOT EXISTS sales_source_files_no_update BEFORE UPDATE ON sales_source_files
BEGIN SELECT RAISE(ABORT,'受領した原本は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_files_no_delete BEFORE DELETE ON sales_source_files
BEGIN SELECT RAISE(ABORT,'受領した原本は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_selections_no_update BEFORE UPDATE ON sales_source_selections
BEGIN SELECT RAISE(ABORT,'原本の表の選択は変更できません。新しい版を作ってください'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_selections_no_delete BEFORE DELETE ON sales_source_selections
BEGIN SELECT RAISE(ABORT,'原本の表の選択は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_bindings_no_update BEFORE UPDATE ON sales_source_bindings
BEGIN SELECT RAISE(ABORT,'原本の割り当ては変更できません。付け替えは新しい版で行います'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_bindings_no_delete BEFORE DELETE ON sales_source_bindings
BEGIN SELECT RAISE(ABORT,'原本の割り当ては削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_partitions_no_update BEFORE UPDATE ON sales_source_partitions
BEGIN SELECT RAISE(ABORT,'原本の分割は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_partitions_no_delete BEFORE DELETE ON sales_source_partitions
BEGIN SELECT RAISE(ABORT,'原本の分割は削除できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_commits_no_update BEFORE UPDATE ON sales_source_commits
BEGIN SELECT RAISE(ABORT,'原本の分割の登録は変更できません'); END;
CREATE TRIGGER IF NOT EXISTS sales_source_commits_no_delete BEFORE DELETE ON sales_source_commits
BEGIN SELECT RAISE(ABORT,'原本の分割の登録は削除できません'); END;

-- 中身を持つ原本は、同じハッシュの旧方式の原本があれば作れない（旧原本を引き継ぐ）
CREATE TRIGGER IF NOT EXISTS sales_source_files_inline_not_legacy BEFORE INSERT ON sales_source_files
WHEN NEW.storage='inline' AND EXISTS(SELECT 1 FROM workflow_raw_artifacts a WHERE a.org_id=NEW.org_id AND a.kind='sales_report' AND a.raw_sha256=NEW.raw_sha256)
BEGIN SELECT RAISE(ABORT,'同じ原本が旧方式の原本として保存済みです。その原本を引き継いでください'); END;
-- 旧原本の引き継ぎは、売上報告の原本で、ハッシュと大きさが一致し、旧経路でまだ登録していないものだけ
CREATE TRIGGER IF NOT EXISTS sales_source_files_legacy_takeover BEFORE INSERT ON sales_source_files
WHEN NEW.storage='legacy_artifact' AND (
  NOT EXISTS(SELECT 1 FROM workflow_raw_artifacts a WHERE a.org_id=NEW.org_id AND a.id=NEW.legacy_artifact_id AND a.kind='sales_report'
    AND a.raw_sha256=NEW.raw_sha256 AND a.byte_length=NEW.byte_length)
  OR EXISTS(SELECT 1 FROM workflow_report_commits x WHERE x.org_id=NEW.org_id AND x.artifact_id=NEW.legacy_artifact_id))
BEGIN SELECT RAISE(ABORT,'引き継げない旧方式の原本です（売上報告でない・中身が一致しない・旧方式で登録済みのいずれか）'); END;

-- 表の選択は、1件でも登録した原本には足せない。版番号は1から連番
CREATE TRIGGER IF NOT EXISTS sales_source_selections_before_commit BEFORE INSERT ON sales_source_selections
WHEN EXISTS(SELECT 1 FROM sales_source_commits x WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id)
  OR NEW.version_no<>COALESCE((SELECT MAX(s.version_no) FROM sales_source_selections s WHERE s.org_id=NEW.org_id AND s.file_id=NEW.file_id),0)+1
BEGIN SELECT RAISE(ABORT,'登録を始めた原本の表の選択は変えられません（または版番号が連番ではありません）'); END;
-- 旧原本から写した選択は、その原本の旧選択だけ
CREATE TRIGGER IF NOT EXISTS sales_source_selections_legacy_match BEFORE INSERT ON sales_source_selections
WHEN NEW.legacy_selection_id IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM workflow_report_selections s JOIN sales_source_files f ON f.org_id=s.org_id AND f.legacy_artifact_id=s.artifact_id
  WHERE s.org_id=NEW.org_id AND s.id=NEW.legacy_selection_id AND f.id=NEW.file_id)
BEGIN SELECT RAISE(ABORT,'引き継ぐ旧選択がこの原本のものではありません'); END;

-- 付け替え（割り当ての版）は登録前だけ。版番号は1から連番
CREATE TRIGGER IF NOT EXISTS sales_source_bindings_before_commit BEFORE INSERT ON sales_source_bindings
WHEN EXISTS(SELECT 1 FROM sales_source_commits x WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id)
  OR NEW.version_no<>COALESCE((SELECT MAX(b.version_no) FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.file_id=NEW.file_id),0)+1
BEGIN SELECT RAISE(ABORT,'登録を始めた原本は付け替えられません（または版番号が連番ではありません）'); END;

-- 分割は、その時点で最新の割り当て・最新の選択に対してだけ作る。1つの作品への割り当てなら、その作品だけ。登録を始めた原本には足さない
CREATE TRIGGER IF NOT EXISTS sales_source_partitions_consistent BEFORE INSERT ON sales_source_partitions
WHEN NEW.binding_id<>(SELECT b.id FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.file_id=NEW.file_id ORDER BY b.version_no DESC LIMIT 1)
  OR NEW.selection_id<>(SELECT s.id FROM sales_source_selections s WHERE s.org_id=NEW.org_id AND s.file_id=NEW.file_id ORDER BY s.version_no DESC LIMIT 1)
  OR EXISTS(SELECT 1 FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.id=NEW.binding_id AND b.mode='single_work' AND b.work_id<>NEW.work_id)
  OR EXISTS(SELECT 1 FROM sales_source_commits x WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id)
BEGIN SELECT RAISE(ABORT,'原本の分割は、最新の割り当てと表の選択で、登録を始める前に作ります'); END;

-- 登録は、分割と同じ原本・割り当て・選択で、割り当てと選択が最新であり、同じ原本のほかの登録と分け方がそろっているときだけ
CREATE TRIGGER IF NOT EXISTS sales_source_commits_consistent BEFORE INSERT ON sales_source_commits
WHEN NOT EXISTS(SELECT 1 FROM sales_source_partitions p WHERE p.org_id=NEW.org_id AND p.id=NEW.partition_id AND p.file_id=NEW.file_id
    AND p.binding_id=NEW.binding_id AND p.selection_id=NEW.selection_id AND p.work_id=NEW.work_id)
  OR NEW.binding_id<>(SELECT b.id FROM sales_source_bindings b WHERE b.org_id=NEW.org_id AND b.file_id=NEW.file_id ORDER BY b.version_no DESC LIMIT 1)
  OR NEW.selection_id<>(SELECT s.id FROM sales_source_selections s WHERE s.org_id=NEW.org_id AND s.file_id=NEW.file_id ORDER BY s.version_no DESC LIMIT 1)
  OR EXISTS(SELECT 1 FROM sales_source_commits x JOIN sales_source_partitions xp ON xp.org_id=x.org_id AND xp.id=x.partition_id
    WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id AND (x.binding_id<>NEW.binding_id OR x.selection_id<>NEW.selection_id
      OR xp.plan_sha256<>(SELECT p.plan_sha256 FROM sales_source_partitions p WHERE p.org_id=NEW.org_id AND p.id=NEW.partition_id)))
BEGIN SELECT RAISE(ABORT,'原本の割り当てか表の選択が更新されたため、この分割は登録できません。割り当てからやり直してください'); END;

-- 1つの原本から分けた報告は、最初の登録と同じ取引先・同じ報告の種類で登録する（1通の受領報告を別々の取引先・種類の売上にしない）。
-- 報告（report_imports）は同じ batch で先に入るので、登録済みの報告と、いま登録する報告の取引先・種類を比べる
CREATE TRIGGER IF NOT EXISTS sales_source_commits_same_terms BEFORE INSERT ON sales_source_commits
WHEN EXISTS(SELECT 1 FROM sales_source_commits x
    JOIN report_imports r ON r.org_id=x.org_id AND r.id=x.report_id
    JOIN report_imports n ON n.org_id=NEW.org_id AND n.id=NEW.report_id
  WHERE x.org_id=NEW.org_id AND x.file_id=NEW.file_id AND (r.partner_id IS NOT n.partner_id OR r.kind<>n.kind))
BEGIN SELECT RAISE(ABORT,'1つの原本から分けた報告は、最初の登録と同じ取引先・報告の種類で登録します'); END;

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
