-- 依頼6①：追加のみ。すべての業務記録は版または取消の追記。
CREATE TABLE IF NOT EXISTS gl_account_class_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 account_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 normal_side TEXT NOT NULL CHECK(normal_side IN ('debit','credit')),
 balance_class TEXT NOT NULL CHECK(balance_class IN ('none','current','noncurrent')),
 settlement_role TEXT CHECK(settlement_role IN ('cash','payable','card_payable','receivable','refund_receivable','prepaid','input_tax','output_tax','withholding','wip')),
 UNIQUE(org_id,account_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,account_id) REFERENCES gl_accounts(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS gl_account_class_versions_no_update BEFORE UPDATE ON gl_account_class_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS gl_account_class_versions_no_delete BEFORE DELETE ON gl_account_class_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS gl_account_class_versions_account_id_idx ON gl_account_class_versions(org_id,account_id);
CREATE INDEX IF NOT EXISTS gl_account_class_versions_author_idx ON gl_account_class_versions(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS gl_account_class_versions_sequence BEFORE INSERT ON gl_account_class_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM gl_account_class_versions WHERE org_id=NEW.org_id AND account_id=NEW.account_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS expense_categories (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL CHECK(code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
 UNIQUE(org_id,code),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_categories_no_update BEFORE UPDATE ON expense_categories BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_categories_no_delete BEFORE DELETE ON expense_categories BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_categories_author_idx ON expense_categories(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_tax_categories (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL CHECK(code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
 UNIQUE(org_id,code),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_tax_categories_no_update BEFORE UPDATE ON expense_tax_categories BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_tax_categories_no_delete BEFORE DELETE ON expense_tax_categories BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_tax_categories_author_idx ON expense_tax_categories(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_withholding_categories (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL CHECK(code IS NULL OR length(trim(code)) BETWEEN 1 AND 60),
 UNIQUE(org_id,code),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_withholding_categories_no_update BEFORE UPDATE ON expense_withholding_categories BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_withholding_categories_no_delete BEFORE DELETE ON expense_withholding_categories BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_withholding_categories_author_idx ON expense_withholding_categories(org_id,created_by);

CREATE TABLE IF NOT EXISTS expense_category_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 category_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 name TEXT NOT NULL CHECK(name IS NULL OR length(trim(name)) BETWEEN 1 AND 100),
 account_class_version_id INTEGER NOT NULL,
 recognition_timing TEXT NOT NULL CHECK(recognition_timing IN ('incurred_month','release_month_once')),
 UNIQUE(org_id,category_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,category_id) REFERENCES expense_categories(org_id,id),
 FOREIGN KEY(org_id,account_class_version_id) REFERENCES gl_account_class_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_category_versions_no_update BEFORE UPDATE ON expense_category_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_category_versions_no_delete BEFORE DELETE ON expense_category_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_category_versions_category_id_idx ON expense_category_versions(org_id,category_id);
CREATE INDEX IF NOT EXISTS expense_category_versions_account_class_version_id_idx ON expense_category_versions(org_id,account_class_version_id);
CREATE INDEX IF NOT EXISTS expense_category_versions_author_idx ON expense_category_versions(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS expense_category_versions_sequence BEFORE INSERT ON expense_category_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_category_versions WHERE org_id=NEW.org_id AND category_id=NEW.category_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS expense_category_alias_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 alias_text TEXT NOT NULL CHECK(alias_text IS NULL OR length(trim(alias_text)) BETWEEN 1 AND 100),
 version_no INTEGER NOT NULL CHECK(version_no>0),
 category_version_id INTEGER NOT NULL,
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 UNIQUE(org_id,alias_text,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,category_version_id) REFERENCES expense_category_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_category_alias_versions_no_update BEFORE UPDATE ON expense_category_alias_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_category_alias_versions_no_delete BEFORE DELETE ON expense_category_alias_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_category_alias_versions_category_version_id_idx ON expense_category_alias_versions(org_id,category_version_id);
CREATE INDEX IF NOT EXISTS expense_category_alias_versions_author_idx ON expense_category_alias_versions(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS expense_category_alias_versions_sequence BEFORE INSERT ON expense_category_alias_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_category_alias_versions WHERE org_id=NEW.org_id AND alias_text=NEW.alias_text) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS expense_tax_category_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 tax_category_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 name TEXT NOT NULL CHECK(name IS NULL OR length(trim(name)) BETWEEN 1 AND 100),
 tax_kind TEXT NOT NULL CHECK(tax_kind IN ('taxable','exempt','non_taxable','out_of_scope')),
 rate_bps INTEGER,
 rounding TEXT NOT NULL CHECK(rounding IN ('floor','nearest','ceil')),
 UNIQUE(org_id,tax_category_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,tax_category_id) REFERENCES expense_tax_categories(org_id,id),
 CHECK((tax_kind='taxable' AND rate_bps IS NOT NULL AND rate_bps IN (800,1000)) OR (tax_kind<>'taxable' AND rate_bps IS NULL))
);
CREATE TRIGGER IF NOT EXISTS expense_tax_category_versions_no_update BEFORE UPDATE ON expense_tax_category_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_tax_category_versions_no_delete BEFORE DELETE ON expense_tax_category_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_tax_category_versions_tax_category_id_idx ON expense_tax_category_versions(org_id,tax_category_id);
CREATE INDEX IF NOT EXISTS expense_tax_category_versions_author_idx ON expense_tax_category_versions(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS expense_tax_category_versions_sequence BEFORE INSERT ON expense_tax_category_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_tax_category_versions WHERE org_id=NEW.org_id AND tax_category_id=NEW.tax_category_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS expense_withholding_category_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 withholding_category_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 name TEXT NOT NULL CHECK(name IS NULL OR length(trim(name)) BETWEEN 1 AND 100),
 treatment TEXT NOT NULL CHECK(treatment IN ('not_applicable','manual_confirmed')),
 basis TEXT NOT NULL CHECK(basis IS NULL OR length(trim(basis)) BETWEEN 1 AND 1000),
 UNIQUE(org_id,withholding_category_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,withholding_category_id) REFERENCES expense_withholding_categories(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_withholding_category_versions_no_update BEFORE UPDATE ON expense_withholding_category_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_withholding_category_versions_no_delete BEFORE DELETE ON expense_withholding_category_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_withholding_category_versions_withholding_category_id_idx ON expense_withholding_category_versions(org_id,withholding_category_id);
CREATE INDEX IF NOT EXISTS expense_withholding_category_versions_author_idx ON expense_withholding_category_versions(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS expense_withholding_category_versions_sequence BEFORE INSERT ON expense_withholding_category_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_withholding_category_versions WHERE org_id=NEW.org_id AND withholding_category_id=NEW.withholding_category_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS partner_payment_term_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 partner_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 effective_from TEXT NOT NULL CHECK(effective_from IS NULL OR (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(effective_from,'+0 days') IS NOT NULL AND date(effective_from,'+0 days')=effective_from)),
 closing_rule TEXT NOT NULL CHECK(closing_rule IN ('day','month_end')),
 closing_day INTEGER CHECK(closing_day IS NULL OR typeof(closing_day)='integer'),
 payment_month_offset INTEGER NOT NULL CHECK(typeof(payment_month_offset)='integer' AND payment_month_offset BETWEEN 0 AND 24),
 payment_rule TEXT NOT NULL CHECK(payment_rule IN ('day','month_end')),
 payment_day INTEGER CHECK(payment_day IS NULL OR typeof(payment_day)='integer'),
 payment_method TEXT NOT NULL CHECK(payment_method IN ('transfer','cash','card','offset','other')),
 UNIQUE(org_id,partner_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 CHECK((closing_rule='day' AND closing_day IS NOT NULL AND closing_day BETWEEN 1 AND 31) OR (closing_rule='month_end' AND closing_day IS NULL)),
 CHECK((payment_rule='day' AND payment_day IS NOT NULL AND payment_day BETWEEN 1 AND 31) OR (payment_rule='month_end' AND payment_day IS NULL))
);
CREATE TRIGGER IF NOT EXISTS partner_payment_term_versions_no_update BEFORE UPDATE ON partner_payment_term_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS partner_payment_term_versions_no_delete BEFORE DELETE ON partner_payment_term_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS partner_payment_term_versions_partner_id_idx ON partner_payment_term_versions(org_id,partner_id);
CREATE INDEX IF NOT EXISTS partner_payment_term_versions_author_idx ON partner_payment_term_versions(org_id,created_by);
CREATE INDEX IF NOT EXISTS partner_payment_term_versions_effective_idx ON partner_payment_term_versions(org_id,partner_id,effective_from,version_no);
CREATE TRIGGER IF NOT EXISTS partner_payment_term_versions_sequence BEFORE INSERT ON partner_payment_term_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM partner_payment_term_versions WHERE org_id=NEW.org_id AND partner_id=NEW.partner_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS expense_accounting_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 expense_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 category_version_id INTEGER NOT NULL,
 tax_category_version_id INTEGER NOT NULL,
 withholding_category_version_id INTEGER,
 withholding_yen INTEGER CHECK(withholding_yen IS NULL OR (typeof(withholding_yen)='integer' AND withholding_yen BETWEEN 0 AND 9007199254740991)),
 withholding_state TEXT NOT NULL CHECK(withholding_state IN ('unverified','confirmed')),
 UNIQUE(org_id,expense_id,version_no),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,category_version_id) REFERENCES expense_category_versions(org_id,id),
 FOREIGN KEY(org_id,tax_category_version_id) REFERENCES expense_tax_category_versions(org_id,id),
 FOREIGN KEY(org_id,withholding_category_version_id) REFERENCES expense_withholding_category_versions(org_id,id),
 CHECK((withholding_state='unverified' AND withholding_yen IS NULL) OR (withholding_state='confirmed' AND withholding_yen IS NOT NULL AND withholding_category_version_id IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS expense_accounting_versions_no_update BEFORE UPDATE ON expense_accounting_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_accounting_versions_no_delete BEFORE DELETE ON expense_accounting_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_accounting_versions_expense_id_idx ON expense_accounting_versions(org_id,expense_id);
CREATE INDEX IF NOT EXISTS expense_accounting_versions_category_version_id_idx ON expense_accounting_versions(org_id,category_version_id);
CREATE INDEX IF NOT EXISTS expense_accounting_versions_tax_category_version_id_idx ON expense_accounting_versions(org_id,tax_category_version_id);
CREATE INDEX IF NOT EXISTS expense_accounting_versions_withholding_category_version_id_idx ON expense_accounting_versions(org_id,withholding_category_version_id);
CREATE INDEX IF NOT EXISTS expense_accounting_versions_author_idx ON expense_accounting_versions(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS expense_accounting_versions_sequence BEFORE INSERT ON expense_accounting_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_accounting_versions WHERE org_id=NEW.org_id AND expense_id=NEW.expense_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;

CREATE TABLE IF NOT EXISTS expense_payment_accounting (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 payment_id INTEGER NOT NULL,
 accounting_version_id INTEGER NOT NULL,
 withheld_yen INTEGER NOT NULL CHECK(typeof(withheld_yen)='integer' AND withheld_yen BETWEEN -9007199254740991 AND 9007199254740991),
 cash_account_class_version_id INTEGER,
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 PRIMARY KEY(org_id,payment_id),
 FOREIGN KEY(org_id,payment_id) REFERENCES expense_payments(org_id,id),
 FOREIGN KEY(org_id,accounting_version_id) REFERENCES expense_accounting_versions(org_id,id),
 FOREIGN KEY(org_id,cash_account_class_version_id) REFERENCES gl_account_class_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_payment_accounting_no_update BEFORE UPDATE ON expense_payment_accounting BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_payment_accounting_no_delete BEFORE DELETE ON expense_payment_accounting BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_payment_accounting_accounting_version_id_idx ON expense_payment_accounting(org_id,accounting_version_id);
CREATE INDEX IF NOT EXISTS expense_payment_accounting_cash_account_class_version_id_idx ON expense_payment_accounting(org_id,cash_account_class_version_id);
CREATE INDEX IF NOT EXISTS expense_payment_accounting_author_idx ON expense_payment_accounting(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS expense_class_scope BEFORE INSERT ON gl_account_class_versions
 WHEN NOT EXISTS(SELECT 1 FROM gl_accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.account_id AND ((a.section IN ('asset','liability','equity') AND NEW.balance_class<>'none') OR (a.section NOT IN ('asset','liability','equity') AND NEW.balance_class='none')) AND (NEW.settlement_role IS NULL OR (NEW.settlement_role IN ('cash','receivable','refund_receivable','prepaid','input_tax','wip') AND a.section='asset' AND NEW.normal_side='debit') OR (NEW.settlement_role IN ('payable','card_payable','output_tax','withholding') AND a.section='liability' AND NEW.normal_side='credit')))
 BEGIN SELECT RAISE(ABORT,'account classification mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_category_account_scope BEFORE INSERT ON expense_category_versions
 WHEN NOT EXISTS(SELECT 1 FROM gl_account_class_versions c JOIN gl_accounts a ON a.org_id=c.org_id AND a.id=c.account_id WHERE c.org_id=NEW.org_id AND c.id=NEW.account_class_version_id AND a.section IN ('cogs','sga','non_operating_expense','extraordinary_loss','income_tax'))
 BEGIN SELECT RAISE(ABORT,'expense account required'); END;
CREATE TRIGGER IF NOT EXISTS expense_accounting_withholding BEFORE INSERT ON expense_accounting_versions
 WHEN NEW.withholding_yen>MAX(0,(SELECT actual_inc_tax FROM expenses WHERE org_id=NEW.org_id AND id=NEW.expense_id)) OR (NEW.withholding_yen<>0 AND EXISTS(SELECT 1 FROM expense_withholding_category_versions w WHERE w.org_id=NEW.org_id AND w.id=NEW.withholding_category_version_id AND w.treatment='not_applicable'))
 BEGIN SELECT RAISE(ABORT,'withholding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_accounting_paid_lock BEFORE INSERT ON expense_accounting_versions
 WHEN NEW.version_no>1 AND EXISTS(SELECT 1 FROM expense_payments p WHERE p.org_id=NEW.org_id AND p.expense_id=NEW.expense_id AND p.reverses_id IS NULL AND NOT EXISTS(SELECT 1 FROM expense_payments r WHERE r.org_id=p.org_id AND r.reverses_id=p.id))
 BEGIN SELECT RAISE(ABORT,'paid accounting version locked'); END;
CREATE TRIGGER IF NOT EXISTS expense_payment_scope BEFORE INSERT ON expense_payment_accounting
 WHEN NOT EXISTS(SELECT 1 FROM expense_payments p JOIN expense_accounting_versions a ON a.org_id=p.org_id AND a.expense_id=p.expense_id WHERE p.org_id=NEW.org_id AND p.id=NEW.payment_id AND a.id=NEW.accounting_version_id AND a.withholding_state='confirmed' AND ((p.reverses_id IS NULL AND NEW.withheld_yen>=0) OR (p.reverses_id IS NOT NULL AND EXISTS(SELECT 1 FROM expense_payment_accounting x WHERE x.org_id=p.org_id AND x.payment_id=p.reverses_id AND x.accounting_version_id=NEW.accounting_version_id AND x.withheld_yen=-NEW.withheld_yen AND x.cash_account_class_version_id IS NEW.cash_account_class_version_id))) AND (p.method NOT IN ('cash','transfer') OR EXISTS(SELECT 1 FROM gl_account_class_versions c WHERE c.org_id=NEW.org_id AND c.id=NEW.cash_account_class_version_id AND c.settlement_role='cash')))
 BEGIN SELECT RAISE(ABORT,'payment accounting mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_payment_balance BEFORE INSERT ON expense_payment_accounting
 WHEN EXISTS(SELECT 1 FROM expense_payments p JOIN expenses e ON e.org_id=p.org_id AND e.id=p.expense_id JOIN expense_accounting_versions a ON a.org_id=e.org_id AND a.id=NEW.accounting_version_id WHERE p.org_id=NEW.org_id AND p.id=NEW.payment_id AND ((SELECT COALESCE(SUM(q.amount_yen),0) FROM expense_payments q WHERE q.org_id=e.org_id AND q.expense_id=e.id)+(SELECT COALESCE(SUM(x.withheld_yen),0) FROM expense_payment_accounting x JOIN expense_payments q ON q.org_id=x.org_id AND q.id=x.payment_id WHERE q.org_id=e.org_id AND q.expense_id=e.id)+NEW.withheld_yen>e.actual_inc_tax OR (SELECT COALESCE(SUM(x.withheld_yen),0) FROM expense_payment_accounting x JOIN expense_payments q ON q.org_id=x.org_id AND q.id=x.payment_id WHERE q.org_id=e.org_id AND q.expense_id=e.id)+NEW.withheld_yen>a.withholding_yen OR (SELECT COALESCE(SUM(q.amount_yen),0) FROM expense_payments q WHERE q.org_id=e.org_id AND q.expense_id=e.id)>e.actual_inc_tax-a.withholding_yen))
 BEGIN SELECT RAISE(ABORT,'payment exceeds outstanding balance'); END;

-- 依頼6①b: 決済の事実。取消は取消日から効く。
CREATE TABLE IF NOT EXISTS expense_cards (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL CHECK(length(trim(code)) BETWEEN 1 AND 60),
 UNIQUE(org_id,code),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS expense_cards_no_update BEFORE UPDATE ON expense_cards BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_cards_no_delete BEFORE DELETE ON expense_cards BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_cards_created_by_idx ON expense_cards(org_id,created_by);
CREATE TABLE IF NOT EXISTS expense_card_versions (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 card_id INTEGER NOT NULL,
 version_no INTEGER NOT NULL CHECK(version_no>0),
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 effective_from TEXT NOT NULL CHECK(length(effective_from)=10 AND date(effective_from,'+0 days') IS NOT NULL AND date(effective_from,'+0 days')=effective_from),
 cash_account_class_version_id INTEGER NOT NULL,
 closing_rule TEXT NOT NULL CHECK(closing_rule IN ('day','month_end')),
 closing_day INTEGER,
 payment_rule TEXT NOT NULL CHECK(payment_rule IN ('day','month_end')),
 payment_day INTEGER,
 payment_month_offset INTEGER NOT NULL CHECK(payment_month_offset BETWEEN 0 AND 24),
 UNIQUE(org_id,card_id,version_no),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,card_id) REFERENCES expense_cards(org_id,id),
 FOREIGN KEY(org_id,cash_account_class_version_id) REFERENCES gl_account_class_versions(org_id,id),
 CHECK((closing_rule='day' AND closing_day IS NOT NULL AND closing_day BETWEEN 1 AND 31) OR (closing_rule='month_end' AND closing_day IS NULL)),
 CHECK((payment_rule='day' AND payment_day IS NOT NULL AND payment_day BETWEEN 1 AND 31) OR (payment_rule='month_end' AND payment_day IS NULL))
);
CREATE TRIGGER IF NOT EXISTS expense_card_versions_no_update BEFORE UPDATE ON expense_card_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_card_versions_no_delete BEFORE DELETE ON expense_card_versions BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_card_versions_created_by_idx ON expense_card_versions(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_card_versions_card_id_idx ON expense_card_versions(org_id,card_id);
CREATE INDEX IF NOT EXISTS expense_card_versions_cash_account_class_version_id_idx ON expense_card_versions(org_id,cash_account_class_version_id);
CREATE TRIGGER IF NOT EXISTS expense_card_sequence BEFORE INSERT ON expense_card_versions WHEN NEW.version_no<>(SELECT COALESCE(MAX(version_no),0)+1 FROM expense_card_versions WHERE org_id=NEW.org_id AND card_id=NEW.card_id) BEGIN SELECT RAISE(ABORT,'stale expense version'); END;
CREATE TABLE IF NOT EXISTS expense_credit_links (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 expense_id INTEGER NOT NULL,
 original_expense_id INTEGER NOT NULL,
 original_invoice_id INTEGER NOT NULL,
 PRIMARY KEY(org_id,expense_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,original_expense_id) REFERENCES expenses(org_id,id),
 FOREIGN KEY(org_id,original_invoice_id) REFERENCES expense_invoices(org_id,id),
 CHECK(expense_id<>original_expense_id)
);
CREATE TRIGGER IF NOT EXISTS expense_credit_links_no_update BEFORE UPDATE ON expense_credit_links BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_credit_links_no_delete BEFORE DELETE ON expense_credit_links BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_credit_links_created_by_idx ON expense_credit_links(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_credit_links_expense_id_idx ON expense_credit_links(org_id,expense_id);
CREATE INDEX IF NOT EXISTS expense_credit_links_original_expense_id_idx ON expense_credit_links(org_id,original_expense_id);
CREATE INDEX IF NOT EXISTS expense_credit_links_original_invoice_id_idx ON expense_credit_links(org_id,original_invoice_id);
CREATE TRIGGER IF NOT EXISTS expense_credit_scope BEFORE INSERT ON expense_credit_links WHEN NOT EXISTS(SELECT 1 FROM expenses e JOIN expenses o ON o.org_id=e.org_id AND o.partner_id=e.partner_id AND o.project_id=e.project_id AND o.work_id IS e.work_id JOIN expense_details d ON d.org_id=o.org_id AND d.expense_id=o.id JOIN expense_details cd ON cd.org_id=e.org_id AND cd.expense_id=e.id JOIN expense_invoice_versions v ON v.org_id=cd.org_id AND v.invoice_id=cd.invoice_id WHERE e.org_id=NEW.org_id AND e.id=NEW.expense_id AND o.id=NEW.original_expense_id AND d.invoice_id=NEW.original_invoice_id AND e.actual_inc_tax<0 AND o.actual_inc_tax>0 AND v.document_kind='credit_note') BEGIN SELECT RAISE(ABORT,'credit scope mismatch'); END;
CREATE TABLE IF NOT EXISTS expense_payment_settlements (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 payment_id INTEGER NOT NULL,
 card_version_id INTEGER,
 counter_account_class_version_id INTEGER,
 billing_invoice_id INTEGER,
 billing_receipt_id INTEGER,
 counter_description TEXT CHECK(counter_description IS NULL OR length(trim(counter_description)) BETWEEN 1 AND 1000),
 PRIMARY KEY(org_id,payment_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,payment_id) REFERENCES expense_payments(org_id,id),
 FOREIGN KEY(org_id,card_version_id) REFERENCES expense_card_versions(org_id,id),
 FOREIGN KEY(org_id,counter_account_class_version_id) REFERENCES gl_account_class_versions(org_id,id),
 FOREIGN KEY(org_id,billing_invoice_id) REFERENCES billing_invoices(org_id,id),
 FOREIGN KEY(org_id,billing_receipt_id) REFERENCES billing_receipts(org_id,id),
 UNIQUE(org_id,billing_receipt_id),
 CHECK((card_version_id IS NOT NULL AND counter_account_class_version_id IS NULL AND billing_invoice_id IS NULL AND billing_receipt_id IS NULL) OR (card_version_id IS NULL AND counter_account_class_version_id IS NOT NULL AND counter_description IS NOT NULL AND ((billing_invoice_id IS NULL AND billing_receipt_id IS NULL) OR (billing_invoice_id IS NOT NULL AND billing_receipt_id IS NOT NULL))))
);
CREATE TRIGGER IF NOT EXISTS expense_payment_settlements_no_update BEFORE UPDATE ON expense_payment_settlements BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_payment_settlements_no_delete BEFORE DELETE ON expense_payment_settlements BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_payment_settlements_created_by_idx ON expense_payment_settlements(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_payment_settlements_payment_id_idx ON expense_payment_settlements(org_id,payment_id);
CREATE INDEX IF NOT EXISTS expense_payment_settlements_card_version_id_idx ON expense_payment_settlements(org_id,card_version_id);
CREATE INDEX IF NOT EXISTS expense_payment_settlements_counter_account_class_version_id_idx ON expense_payment_settlements(org_id,counter_account_class_version_id);
CREATE INDEX IF NOT EXISTS expense_payment_settlements_billing_invoice_id_idx ON expense_payment_settlements(org_id,billing_invoice_id);
CREATE INDEX IF NOT EXISTS expense_payment_settlements_billing_receipt_id_idx ON expense_payment_settlements(org_id,billing_receipt_id);
CREATE TRIGGER IF NOT EXISTS expense_settlement_method BEFORE INSERT ON expense_payment_settlements WHEN NOT EXISTS(SELECT 1 FROM expense_payments p WHERE p.org_id=NEW.org_id AND p.id=NEW.payment_id AND p.reverses_id IS NULL AND ((p.method='card' AND NEW.card_version_id IS NOT NULL) OR (p.method='offset' AND NEW.counter_account_class_version_id IS NOT NULL))) BEGIN SELECT RAISE(ABORT,'settlement method mismatch'); END;
CREATE TABLE IF NOT EXISTS expense_withholding_remittances (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL,
 occurred_on TEXT NOT NULL CHECK(length(occurred_on)=10 AND date(occurred_on,'+0 days') IS NOT NULL AND date(occurred_on,'+0 days')=occurred_on),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
 month_from TEXT NOT NULL,
 month_to TEXT NOT NULL,
 cash_account_class_version_id INTEGER NOT NULL,
 UNIQUE(org_id,code),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,cash_account_class_version_id) REFERENCES gl_account_class_versions(org_id,id),
 CHECK(month_from<=month_to AND length(month_from)=7 AND length(month_to)=7)
);
CREATE TRIGGER IF NOT EXISTS expense_withholding_remittances_no_update BEFORE UPDATE ON expense_withholding_remittances BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_withholding_remittances_no_delete BEFORE DELETE ON expense_withholding_remittances BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_withholding_remittances_created_by_idx ON expense_withholding_remittances(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_withholding_remittances_cash_account_class_version_id_idx ON expense_withholding_remittances(org_id,cash_account_class_version_id);
CREATE TABLE IF NOT EXISTS expense_withholding_allocations (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 remittance_id INTEGER NOT NULL,
 payment_month TEXT NOT NULL,
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,remittance_id) REFERENCES expense_withholding_remittances(org_id,id),
 UNIQUE(org_id,remittance_id,payment_month)
);
CREATE TRIGGER IF NOT EXISTS expense_withholding_allocations_no_update BEFORE UPDATE ON expense_withholding_allocations BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_withholding_allocations_no_delete BEFORE DELETE ON expense_withholding_allocations BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_withholding_allocations_created_by_idx ON expense_withholding_allocations(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_withholding_allocations_remittance_id_idx ON expense_withholding_allocations(org_id,remittance_id);
CREATE TABLE IF NOT EXISTS expense_card_debits (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL,
 card_id INTEGER NOT NULL,
 occurred_on TEXT NOT NULL CHECK(length(occurred_on)=10 AND date(occurred_on,'+0 days') IS NOT NULL AND date(occurred_on,'+0 days')=occurred_on),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
 cash_account_class_version_id INTEGER NOT NULL,
 UNIQUE(org_id,code),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,card_id) REFERENCES expense_cards(org_id,id),
 FOREIGN KEY(org_id,cash_account_class_version_id) REFERENCES gl_account_class_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_card_debits_no_update BEFORE UPDATE ON expense_card_debits BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_card_debits_no_delete BEFORE DELETE ON expense_card_debits BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_card_debits_created_by_idx ON expense_card_debits(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_card_debits_card_id_idx ON expense_card_debits(org_id,card_id);
CREATE INDEX IF NOT EXISTS expense_card_debits_cash_account_class_version_id_idx ON expense_card_debits(org_id,cash_account_class_version_id);
CREATE TABLE IF NOT EXISTS expense_refund_receipts (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 id INTEGER PRIMARY KEY,
 code TEXT NOT NULL,
 credit_expense_id INTEGER NOT NULL,
 partner_id INTEGER NOT NULL,
 occurred_on TEXT NOT NULL CHECK(length(occurred_on)=10 AND date(occurred_on,'+0 days') IS NOT NULL AND date(occurred_on,'+0 days')=occurred_on),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 9007199254740991),
 cash_account_class_version_id INTEGER NOT NULL,
 UNIQUE(org_id,code),
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,credit_expense_id) REFERENCES expense_credit_links(org_id,expense_id),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,cash_account_class_version_id) REFERENCES gl_account_class_versions(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_refund_receipts_no_update BEFORE UPDATE ON expense_refund_receipts BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_receipts_no_delete BEFORE DELETE ON expense_refund_receipts BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_refund_receipts_created_by_idx ON expense_refund_receipts(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_refund_receipts_credit_expense_id_idx ON expense_refund_receipts(org_id,credit_expense_id);
CREATE INDEX IF NOT EXISTS expense_refund_receipts_partner_id_idx ON expense_refund_receipts(org_id,partner_id);
CREATE INDEX IF NOT EXISTS expense_refund_receipts_cash_account_class_version_id_idx ON expense_refund_receipts(org_id,cash_account_class_version_id);
CREATE TABLE IF NOT EXISTS expense_withholding_remittances_voids (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 record_id INTEGER NOT NULL,
 voided_on TEXT NOT NULL CHECK(length(voided_on)=10 AND date(voided_on,'+0 days') IS NOT NULL AND date(voided_on,'+0 days')=voided_on),
 PRIMARY KEY(org_id,record_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,record_id) REFERENCES expense_withholding_remittances(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_withholding_remittances_voids_no_update BEFORE UPDATE ON expense_withholding_remittances_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_withholding_remittances_voids_no_delete BEFORE DELETE ON expense_withholding_remittances_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_withholding_remittances_voids_created_by_idx ON expense_withholding_remittances_voids(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_withholding_remittances_voids_record_id_idx ON expense_withholding_remittances_voids(org_id,record_id);
CREATE TRIGGER IF NOT EXISTS expense_withholding_remittances_voids_date BEFORE INSERT ON expense_withholding_remittances_voids WHEN NEW.voided_on<(SELECT occurred_on FROM expense_withholding_remittances WHERE org_id=NEW.org_id AND id=NEW.record_id) BEGIN SELECT RAISE(ABORT,'void date precedes record'); END;
CREATE TRIGGER IF NOT EXISTS expense_withholding_remittances_cash BEFORE INSERT ON expense_withholding_remittances WHEN NOT EXISTS(SELECT 1 FROM gl_account_class_versions c WHERE c.org_id=NEW.org_id AND c.id=NEW.cash_account_class_version_id AND c.settlement_role='cash' AND c.active=1) BEGIN SELECT RAISE(ABORT,'cash account required'); END;
CREATE TABLE IF NOT EXISTS expense_card_debits_voids (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 record_id INTEGER NOT NULL,
 voided_on TEXT NOT NULL CHECK(length(voided_on)=10 AND date(voided_on,'+0 days') IS NOT NULL AND date(voided_on,'+0 days')=voided_on),
 PRIMARY KEY(org_id,record_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,record_id) REFERENCES expense_card_debits(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_card_debits_voids_no_update BEFORE UPDATE ON expense_card_debits_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_card_debits_voids_no_delete BEFORE DELETE ON expense_card_debits_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_card_debits_voids_created_by_idx ON expense_card_debits_voids(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_card_debits_voids_record_id_idx ON expense_card_debits_voids(org_id,record_id);
CREATE TRIGGER IF NOT EXISTS expense_card_debits_voids_date BEFORE INSERT ON expense_card_debits_voids WHEN NEW.voided_on<(SELECT occurred_on FROM expense_card_debits WHERE org_id=NEW.org_id AND id=NEW.record_id) BEGIN SELECT RAISE(ABORT,'void date precedes record'); END;
CREATE TRIGGER IF NOT EXISTS expense_card_debits_cash BEFORE INSERT ON expense_card_debits WHEN NOT EXISTS(SELECT 1 FROM gl_account_class_versions c WHERE c.org_id=NEW.org_id AND c.id=NEW.cash_account_class_version_id AND c.settlement_role='cash' AND c.active=1) BEGIN SELECT RAISE(ABORT,'cash account required'); END;
CREATE TABLE IF NOT EXISTS expense_refund_receipts_voids (
 org_id INTEGER NOT NULL REFERENCES organizations(id), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 record_id INTEGER NOT NULL,
 voided_on TEXT NOT NULL CHECK(length(voided_on)=10 AND date(voided_on,'+0 days') IS NOT NULL AND date(voided_on,'+0 days')=voided_on),
 PRIMARY KEY(org_id,record_id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 FOREIGN KEY(org_id,record_id) REFERENCES expense_refund_receipts(org_id,id)
);
CREATE TRIGGER IF NOT EXISTS expense_refund_receipts_voids_no_update BEFORE UPDATE ON expense_refund_receipts_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_receipts_voids_no_delete BEFORE DELETE ON expense_refund_receipts_voids BEGIN SELECT RAISE(ABORT,'expense record immutable'); END;
CREATE INDEX IF NOT EXISTS expense_refund_receipts_voids_created_by_idx ON expense_refund_receipts_voids(org_id,created_by);
CREATE INDEX IF NOT EXISTS expense_refund_receipts_voids_record_id_idx ON expense_refund_receipts_voids(org_id,record_id);
CREATE TRIGGER IF NOT EXISTS expense_refund_receipts_voids_date BEFORE INSERT ON expense_refund_receipts_voids WHEN NEW.voided_on<(SELECT occurred_on FROM expense_refund_receipts WHERE org_id=NEW.org_id AND id=NEW.record_id) BEGIN SELECT RAISE(ABORT,'void date precedes record'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_receipts_cash BEFORE INSERT ON expense_refund_receipts WHEN NOT EXISTS(SELECT 1 FROM gl_account_class_versions c WHERE c.org_id=NEW.org_id AND c.id=NEW.cash_account_class_version_id AND c.settlement_role='cash' AND c.active=1) BEGIN SELECT RAISE(ABORT,'cash account required'); END;
CREATE TRIGGER IF NOT EXISTS expense_offset_reverse_together BEFORE INSERT ON billing_receipt_reversals WHEN EXISTS(SELECT 1 FROM expense_payment_settlements s WHERE s.org_id=NEW.org_id AND s.billing_receipt_id=NEW.receipt_id AND NOT EXISTS(SELECT 1 FROM expense_payments p WHERE p.org_id=s.org_id AND p.reverses_id=s.payment_id AND p.paid_on=NEW.reversed_on)) BEGIN SELECT RAISE(ABORT,'reverse offset through expense payment'); END;
CREATE TRIGGER IF NOT EXISTS expense_card_cash BEFORE INSERT ON expense_card_versions
 WHEN NOT EXISTS(SELECT 1 FROM gl_account_class_versions c WHERE c.org_id=NEW.org_id AND c.id=NEW.cash_account_class_version_id AND c.settlement_role='cash')
 BEGIN SELECT RAISE(ABORT,'card cash account mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_refund_partner BEFORE INSERT ON expense_refund_receipts
 WHEN NOT EXISTS(SELECT 1 FROM expenses e WHERE e.org_id=NEW.org_id AND e.id=NEW.credit_expense_id AND e.partner_id=NEW.partner_id AND e.actual_inc_tax<0)
 BEGIN SELECT RAISE(ABORT,'refund partner mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_offset_receipt_scope BEFORE INSERT ON expense_payment_settlements
 WHEN NEW.billing_receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM expense_payments p JOIN expenses e ON e.org_id=p.org_id AND e.id=p.expense_id JOIN billing_receipts r ON r.org_id=e.org_id AND r.partner_id=e.partner_id JOIN billing_receipt_allocations a ON a.org_id=r.org_id AND a.receipt_id=r.id JOIN billing_invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id AND i.partner_id=e.partner_id WHERE p.org_id=NEW.org_id AND p.id=NEW.payment_id AND r.id=NEW.billing_receipt_id AND i.id=NEW.billing_invoice_id AND r.amount_yen=p.amount_yen AND a.amount_yen=p.amount_yen AND r.received_on=p.paid_on)
 BEGIN SELECT RAISE(ABORT,'offset receipt mismatch'); END;
CREATE TRIGGER IF NOT EXISTS expense_remittance_month_scope BEFORE INSERT ON expense_withholding_allocations
 WHEN NOT EXISTS(SELECT 1 FROM expense_withholding_remittances r WHERE r.org_id=NEW.org_id AND r.id=NEW.remittance_id AND NEW.payment_month BETWEEN r.month_from AND r.month_to AND NEW.amount_yen+COALESCE((SELECT SUM(a.amount_yen) FROM expense_withholding_allocations a WHERE a.org_id=r.org_id AND a.remittance_id=r.id),0)<=r.amount_yen)
 BEGIN SELECT RAISE(ABORT,'remittance allocation mismatch'); END;
