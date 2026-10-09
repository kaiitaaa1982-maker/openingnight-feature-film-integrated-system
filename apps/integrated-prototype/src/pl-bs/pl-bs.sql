-- PL・BS（管理会計の試算。決算書ではない）の追加表。設計: docs/platform/team-development/pl-bs-design.md。
-- ローカルは db.mjs の R7_SQL_FILES、D1 は migrations/0007_pl_bs.sql（scripts/build-ux-migration.mjs が連結）。
-- すべて組織（org_id）で区切り、組織の外の行は外部キー（org_id を含む複合キー）で指せない。
-- 記録は追加だけ。変更・削除はトリガーで止め、直すときは新しい版・取消の行を足す。
-- トリガーの本体では条件分岐の式を使わない（本番の wrangler d1 migrations apply が「incomplete input」で落ちるため）。条件は WHEN 句に書く。

-- 1. 組織の法人情報（版）。決算期は既存の fiscal_settings を使う。opening_month は期首残高の基準月（その月末の残高を手入力の残高として入れる）。
--    self_partner_id は自社を表す取引先（製作委員会の参加者の中から自社の取り分を選ぶために使う）
CREATE TABLE IF NOT EXISTS org_profile_versions (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  version_no INTEGER NOT NULL CHECK(version_no>0),
  legal_name TEXT NOT NULL CHECK(length(trim(legal_name)) BETWEEN 1 AND 200),
  corporate_number TEXT CHECK(corporate_number IS NULL OR (length(corporate_number)=13 AND corporate_number NOT GLOB '*[^0-9]*')),
  invoice_registration_number TEXT CHECK(invoice_registration_number IS NULL OR invoice_registration_number GLOB 'T[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  postal_code TEXT CHECK(postal_code IS NULL OR postal_code GLOB '[0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'),
  address TEXT CHECK(address IS NULL OR length(trim(address)) BETWEEN 1 AND 300),
  capital_yen INTEGER CHECK(capital_yen IS NULL OR capital_yen>=0),
  self_partner_id INTEGER,
  opening_month TEXT CHECK(opening_month IS NULL OR (opening_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(opening_month,6,2) BETWEEN '01' AND '12')),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,version_no),
  FOREIGN KEY(org_id,self_partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS org_profile_versions_no_update BEFORE UPDATE ON org_profile_versions BEGIN SELECT RAISE(ABORT,'会社の法人情報の版は変更できません。新しい版を作ってください'); END;
CREATE TRIGGER IF NOT EXISTS org_profile_versions_no_delete BEFORE DELETE ON org_profile_versions BEGIN SELECT RAISE(ABORT,'会社の法人情報の版は削除できません'); END;
-- 版は1から順に積む（前の版の次の番号だけ）
CREATE TRIGGER IF NOT EXISTS org_profile_versions_sequence BEFORE INSERT ON org_profile_versions
WHEN NEW.version_no<>COALESCE((SELECT MAX(p.version_no) FROM org_profile_versions p WHERE p.org_id=NEW.org_id),0)+1 BEGIN
  SELECT RAISE(ABORT,'会社の法人情報の版が連続していません。再読込してから保存してください');
END;

-- 2. 勘定科目（組織ごと）。共通の初期値は管理者が「初期値を入れる」で組織に足す（移行では入れない）。
--    section: sales 売上／cogs 売上原価／sga 販管費／non_operating_income 営業外収益／non_operating_expense 営業外費用／
--             extraordinary_gain 特別利益／extraordinary_loss 特別損失／income_tax 法人税等／asset 資産／liability 負債／equity 純資産
--    source: system＝システムが計算（system_key で計算の行を決める）／manual＝手入力。
--    cash_effect: 手入力の額が現預金を動かすか（1＝動かす。減価償却費などは0）。
CREATE TABLE IF NOT EXISTS gl_accounts (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 20 AND code NOT GLOB '*[^0-9A-Za-z_-]*'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
  section TEXT NOT NULL CHECK(section IN ('sales','cogs','sga','non_operating_income','non_operating_expense','extraordinary_gain','extraordinary_loss','income_tax','asset','liability','equity')),
  source TEXT NOT NULL CHECK(source IN ('system','manual')),
  system_key TEXT CHECK(system_key IS NULL OR (length(system_key) BETWEEN 1 AND 40 AND system_key NOT GLOB '*[^a-z0-9_]*')),
  cash_effect INTEGER NOT NULL DEFAULT 1 CHECK(cash_effect IN (0,1)),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 100000),
  note TEXT CHECK(note IS NULL OR length(note)<=500),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,code),
  CHECK((source='system' AND system_key IS NOT NULL) OR (source='manual' AND system_key IS NULL)),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_accounts_system_key ON gl_accounts(org_id,system_key) WHERE system_key IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS gl_accounts_no_update BEFORE UPDATE ON gl_accounts BEGIN SELECT RAISE(ABORT,'勘定科目は変更できません。新しい科目を足してください'); END;
CREATE TRIGGER IF NOT EXISTS gl_accounts_no_delete BEFORE DELETE ON gl_accounts BEGIN SELECT RAISE(ABORT,'勘定科目は削除できません'); END;

-- 3. 手入力の額（勘定科目×月×（PLの発生額 flow か月末の残高 balance か）×金額×作品（任意）×根拠×状態）。
--    追加だけ。直すときは取消の行（reverses_id に元の行、同じ科目・月・種類・作品、金額と税額は符号を逆）を足し、正しい額を入れ直す。
--    flow は PL の科目（売上〜法人税等）、balance は BS の科目（資産・負債・純資産）だけ。
--    amount_yen は税抜の発生額（PL）か月末残高（BS）。tax_yen は発生額の消費税額（課税の費用は仮払、課税の収益は仮受。現預金は税込で動く）。
--    税額は発生額（flow）で、現預金を動かす科目にだけ入れられる（減価償却費などは0）。
CREATE TABLE IF NOT EXISTS gl_manual_amounts (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  account_id INTEGER NOT NULL,
  month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12'),
  kind TEXT NOT NULL CHECK(kind IN ('flow','balance')),
  amount_yen INTEGER NOT NULL,
  tax_yen INTEGER NOT NULL DEFAULT 0,
  work_id INTEGER,
  basis TEXT NOT NULL CHECK(length(trim(basis)) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK(status IN ('unverified','reviewed')),
  reverses_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id),
  CHECK(reverses_id IS NULL OR reverses_id<>id),
  CHECK(kind='flow' OR tax_yen=0),
  FOREIGN KEY(org_id,account_id) REFERENCES gl_accounts(org_id,id),
  FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
  FOREIGN KEY(org_id,reverses_id) REFERENCES gl_manual_amounts(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS gl_manual_amounts_reversal ON gl_manual_amounts(org_id,reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gl_manual_amounts_by_month ON gl_manual_amounts(org_id,month);
CREATE TRIGGER IF NOT EXISTS gl_manual_amounts_no_update BEFORE UPDATE ON gl_manual_amounts BEGIN SELECT RAISE(ABORT,'手入力の額は変更できません。取消の行を足して入れ直してください'); END;
CREATE TRIGGER IF NOT EXISTS gl_manual_amounts_no_delete BEFORE DELETE ON gl_manual_amounts BEGIN SELECT RAISE(ABORT,'手入力の額は削除できません。取消の行を足してください'); END;
-- 発生額は PL の科目だけ、残高は BS の科目だけ
CREATE TRIGGER IF NOT EXISTS gl_manual_amounts_kind BEFORE INSERT ON gl_manual_amounts
WHEN NOT EXISTS(SELECT 1 FROM gl_accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.account_id
  AND ((NEW.kind='balance' AND a.section IN ('asset','liability','equity')) OR (NEW.kind='flow' AND a.section NOT IN ('asset','liability','equity')))) BEGIN
  SELECT RAISE(ABORT,'発生額はPLの科目、月末の残高はBSの科目にだけ入れられます');
END;
-- 取消の行は、取り消す行（取消ではない行）と同じ科目・月・種類・作品で、金額と税額の符号が逆
CREATE TRIGGER IF NOT EXISTS gl_manual_amounts_reversal_scope BEFORE INSERT ON gl_manual_amounts
WHEN NEW.reverses_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM gl_manual_amounts o WHERE o.org_id=NEW.org_id AND o.id=NEW.reverses_id AND o.reverses_id IS NULL
  AND o.account_id=NEW.account_id AND o.month=NEW.month AND o.kind=NEW.kind AND o.work_id IS NEW.work_id AND o.amount_yen=-NEW.amount_yen AND o.tax_yen=-NEW.tax_yen) BEGIN
  SELECT RAISE(ABORT,'取消の行は、取り消す行と同じ科目・月・種類・作品で、金額と税額の符号を逆にしてください');
END;
-- 税額は現預金を動かす科目にだけ入れられる（減価償却費など現預金を動かさない科目は税額0）
CREATE TRIGGER IF NOT EXISTS gl_manual_amounts_tax_cash BEFORE INSERT ON gl_manual_amounts
WHEN NEW.tax_yen<>0 AND EXISTS(SELECT 1 FROM gl_accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.account_id AND a.cash_effect=0) BEGIN
  SELECT RAISE(ABORT,'現預金を動かさない科目には消費税額を入れられません');
END;

-- 4. 経費の出金（出金日・金額・方法・備考）。追加だけ。取消は取消の行（reverses_id、金額は負、理由を備考に）を取消日に足す。
--    method: transfer 振込／cash 現金／card カード／offset 相殺／other その他
CREATE TABLE IF NOT EXISTS expense_payments (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  expense_id INTEGER NOT NULL,
  paid_on TEXT NOT NULL CHECK(paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  amount_yen INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('transfer','cash','card','offset','other')),
  note TEXT CHECK(note IS NULL OR length(note)<=500),
  reverses_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id),
  CHECK((reverses_id IS NULL AND amount_yen>0) OR (reverses_id IS NOT NULL AND reverses_id<>id AND amount_yen<0 AND note IS NOT NULL AND length(trim(note))>0)),
  FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
  FOREIGN KEY(org_id,reverses_id) REFERENCES expense_payments(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_payments_reversal ON expense_payments(org_id,reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expense_payments_by_expense ON expense_payments(org_id,expense_id);
CREATE TRIGGER IF NOT EXISTS expense_payments_no_update BEFORE UPDATE ON expense_payments BEGIN SELECT RAISE(ABORT,'経費の出金の記録は変更できません。取消の行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS expense_payments_no_delete BEFORE DELETE ON expense_payments BEGIN SELECT RAISE(ABORT,'経費の出金の記録は削除できません。取消の行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS expense_payments_reversal_scope BEFORE INSERT ON expense_payments
WHEN NEW.reverses_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expense_payments o WHERE o.org_id=NEW.org_id AND o.id=NEW.reverses_id AND o.reverses_id IS NULL
  AND o.expense_id=NEW.expense_id AND o.amount_yen=-NEW.amount_yen AND o.paid_on<=NEW.paid_on) BEGIN
  SELECT RAISE(ABORT,'出金の取消は、取り消す出金と同じ経費・同じ額で、出金日以後の日付にしてください');
END;

-- 5. 製作委員会への出資の払込（committee_term_investments の出資額に対する払込日・金額）。追加だけ・取消の行で直す（経費の出金と同じ）
CREATE TABLE IF NOT EXISTS committee_investment_payments (
  id INTEGER PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES organizations(id),
  term_version_id INTEGER NOT NULL,
  partner_id INTEGER NOT NULL,
  paid_on TEXT NOT NULL CHECK(paid_on GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  amount_yen INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('transfer','cash','card','offset','other')),
  note TEXT CHECK(note IS NULL OR length(note)<=500),
  reverses_id INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id),
  CHECK((reverses_id IS NULL AND amount_yen>0) OR (reverses_id IS NOT NULL AND reverses_id<>id AND amount_yen<0 AND note IS NOT NULL AND length(trim(note))>0)),
  FOREIGN KEY(org_id,term_version_id,partner_id) REFERENCES committee_term_investments(org_id,term_version_id,partner_id),
  FOREIGN KEY(org_id,reverses_id) REFERENCES committee_investment_payments(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS committee_investment_payments_reversal ON committee_investment_payments(org_id,reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS committee_investment_payments_by_version ON committee_investment_payments(org_id,term_version_id,partner_id);
CREATE TRIGGER IF NOT EXISTS committee_investment_payments_no_update BEFORE UPDATE ON committee_investment_payments BEGIN SELECT RAISE(ABORT,'出資の払込の記録は変更できません。取消の行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS committee_investment_payments_no_delete BEFORE DELETE ON committee_investment_payments BEGIN SELECT RAISE(ABORT,'出資の払込の記録は削除できません。取消の行を足してください'); END;
CREATE TRIGGER IF NOT EXISTS committee_investment_payments_reversal_scope BEFORE INSERT ON committee_investment_payments
WHEN NEW.reverses_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM committee_investment_payments o WHERE o.org_id=NEW.org_id AND o.id=NEW.reverses_id AND o.reverses_id IS NULL
  AND o.term_version_id=NEW.term_version_id AND o.partner_id=NEW.partner_id AND o.amount_yen=-NEW.amount_yen AND o.paid_on<=NEW.paid_on) BEGIN
  SELECT RAISE(ABORT,'払込の取消は、取り消す払込と同じ委員会・参加者・同じ額で、払込日以後の日付にしてください');
END;
