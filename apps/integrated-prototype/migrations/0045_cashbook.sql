-- 会計の最初の組: 口座・銀行の明細の取込・仕訳・入出金の履歴（会社ルートの plans/2026-10-22-folder-cashflow.md の「最優先」と「2026-10-23 の方向転換」）。
-- 足すだけの移行: 5表と、その表だけのトリガーを作る。既存の表の列・制約・トリガーは変えない。調整役の番号は 0045。
--
-- bank_accounts: 口座。普通預金などの現預金の科目（gl_accounts）の補助。口座番号は下4桁だけ持つ（全桁は持たない）。
-- bank_statement_imports: 取り込んだ明細の1通（CSV の原本の文字・ハッシュ・読み取り器の版）。同じ明細の二重の取込は組織×ハッシュの一意で止める。
--   原本は共通の原本の表（source_documents）が入ったらそちらへ寄せる。
-- bank_statement_lines: 明細の行。期間の重なる明細を二重に数えないため、口座の中で同じ取引（日・向き・額・取引後の残高・同じ組の何番目か）は1行だけ。
-- journal_entries・journal_lines: 仕訳。行の数を見出しに持ち、行がそろった時点で借方計＝貸方計を DB が確かめる（消込の allocation_count と同じ型）。
--   取消は逆の仕訳を足す（reverses_entry_id。1つの仕訳に取消は1回）。明細の行から作る仕訳は、有効なもの（取り消されていないもの）が1行に1本だけ。
--   入出金の履歴は、現預金の科目で口座（bank_account_id）を持つ仕訳の行を日付の順に並べて導く（履歴の表は持たない）。
--
-- トリガーの本体に CASE を書かない（本番の wrangler d1 migrations apply --remote が「incomplete input」で落とす）。
-- 決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。手元の SQLite（src/db.mjs）は作るだけの文なので毎回当てる。

CREATE TABLE IF NOT EXISTS bank_accounts (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 label TEXT NOT NULL CHECK(length(trim(label)) BETWEEN 1 AND 60),
 bank_name TEXT CHECK(bank_name IS NULL OR length(trim(bank_name)) BETWEEN 1 AND 60),
 last4 TEXT CHECK(last4 IS NULL OR (length(last4)=4 AND ltrim(last4,'0123456789')='')),
 gl_account_id INTEGER NOT NULL,
 opened_on TEXT NOT NULL CHECK(length(opened_on)=10 AND substr(opened_on,5,1)='-' AND substr(opened_on,8,1)='-'
  AND ltrim(substr(opened_on,1,4)||substr(opened_on,6,2)||substr(opened_on,9,2),'0123456789')=''),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,label),
 FOREIGN KEY(org_id,gl_account_id) REFERENCES gl_accounts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS bank_accounts_no_update BEFORE UPDATE ON bank_accounts BEGIN SELECT RAISE(ABORT,'bank account immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_accounts_no_delete BEFORE DELETE ON bank_accounts BEGIN SELECT RAISE(ABORT,'bank account immutable'); END;
CREATE INDEX IF NOT EXISTS bank_accounts_gl_idx ON bank_accounts(org_id,gl_account_id);
CREATE INDEX IF NOT EXISTS bank_accounts_author_idx ON bank_accounts(org_id,created_by);

CREATE TABLE IF NOT EXISTS bank_statement_imports (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 bank_account_id INTEGER NOT NULL,
 raw_sha256 TEXT NOT NULL CHECK(length(raw_sha256)=64 AND ltrim(raw_sha256,'0123456789abcdef')=''),
 file_name TEXT NOT NULL CHECK(length(trim(file_name)) BETWEEN 1 AND 240),
 parser TEXT NOT NULL CHECK(length(trim(parser)) BETWEEN 1 AND 60),
 original_text TEXT NOT NULL CHECK(length(original_text) BETWEEN 1 AND 4000000),
 line_count INTEGER NOT NULL CHECK(typeof(line_count)='integer' AND line_count BETWEEN 0 AND 100000),
 new_line_count INTEGER NOT NULL CHECK(typeof(new_line_count)='integer' AND new_line_count BETWEEN 0 AND line_count),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id), UNIQUE(org_id,raw_sha256), UNIQUE(org_id,bank_account_id,id),
 FOREIGN KEY(org_id,bank_account_id) REFERENCES bank_accounts(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS bank_statement_imports_no_update BEFORE UPDATE ON bank_statement_imports BEGIN SELECT RAISE(ABORT,'bank statement immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_statement_imports_no_delete BEFORE DELETE ON bank_statement_imports BEGIN SELECT RAISE(ABORT,'bank statement immutable'); END;
CREATE INDEX IF NOT EXISTS bank_statement_imports_author_idx ON bank_statement_imports(org_id,created_by);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 bank_account_id INTEGER NOT NULL,
 import_id INTEGER NOT NULL,
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 100000),
 value_date TEXT NOT NULL CHECK(length(value_date)=10 AND substr(value_date,5,1)='-' AND substr(value_date,8,1)='-'
  AND ltrim(substr(value_date,1,4)||substr(value_date,6,2)||substr(value_date,9,2),'0123456789')=''),
 direction TEXT NOT NULL CHECK(direction IN ('in','out')),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 1000000000000),
 balance_after_yen INTEGER CHECK(balance_after_yen IS NULL OR (typeof(balance_after_yen)='integer' AND balance_after_yen BETWEEN -1000000000000 AND 1000000000000)),
 description TEXT CHECK(description IS NULL OR length(description) BETWEEN 1 AND 300),
 dedupe_key TEXT NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 200),
 UNIQUE(org_id,id), UNIQUE(org_id,bank_account_id,dedupe_key), UNIQUE(org_id,bank_account_id,id),
 FOREIGN KEY(org_id,bank_account_id,import_id) REFERENCES bank_statement_imports(org_id,bank_account_id,id)
);
CREATE TRIGGER IF NOT EXISTS bank_statement_lines_no_update BEFORE UPDATE ON bank_statement_lines BEGIN SELECT RAISE(ABORT,'bank statement immutable'); END;
CREATE TRIGGER IF NOT EXISTS bank_statement_lines_no_delete BEFORE DELETE ON bank_statement_lines BEGIN SELECT RAISE(ABORT,'bank statement immutable'); END;
CREATE INDEX IF NOT EXISTS bank_statement_lines_by_date ON bank_statement_lines(org_id,bank_account_id,value_date);

CREATE TABLE IF NOT EXISTS journal_entries (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 entry_date TEXT NOT NULL CHECK(length(entry_date)=10 AND substr(entry_date,5,1)='-' AND substr(entry_date,8,1)='-'
  AND ltrim(substr(entry_date,1,4)||substr(entry_date,6,2)||substr(entry_date,9,2),'0123456789')=''),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('opening','bank_line','manual')),
 bank_statement_line_id INTEGER,
 reverses_entry_id INTEGER,
 line_count INTEGER NOT NULL CHECK(typeof(line_count)='integer' AND line_count BETWEEN 2 AND 50),
 memo TEXT CHECK(memo IS NULL OR length(memo) BETWEEN 1 AND 300),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 CHECK((source_kind='bank_line' AND bank_statement_line_id IS NOT NULL) OR (source_kind<>'bank_line' AND bank_statement_line_id IS NULL)),
 CHECK(reverses_entry_id IS NULL OR reverses_entry_id<>id),
 FOREIGN KEY(org_id,bank_statement_line_id) REFERENCES bank_statement_lines(org_id,id),
 FOREIGN KEY(org_id,reverses_entry_id) REFERENCES journal_entries(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_one_reversal ON journal_entries(org_id,reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_entries_by_line ON journal_entries(org_id,bank_statement_line_id);
CREATE INDEX IF NOT EXISTS journal_entries_by_date ON journal_entries(org_id,entry_date);
CREATE INDEX IF NOT EXISTS journal_entries_author_idx ON journal_entries(org_id,created_by);
CREATE TRIGGER IF NOT EXISTS journal_entries_no_update BEFORE UPDATE ON journal_entries BEGIN SELECT RAISE(ABORT,'journal immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_entries_no_delete BEFORE DELETE ON journal_entries BEGIN SELECT RAISE(ABORT,'journal immutable'); END;
-- 取消の仕訳は、元の仕訳と同じ出どころ（種類と明細の行）を持つ
CREATE TRIGGER IF NOT EXISTS journal_entries_reversal_scope BEFORE INSERT ON journal_entries
 WHEN NEW.reverses_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM journal_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.reverses_entry_id
  AND e.reverses_entry_id IS NULL AND e.source_kind=NEW.source_kind AND COALESCE(e.bank_statement_line_id,0)=COALESCE(NEW.bank_statement_line_id,0))
 BEGIN SELECT RAISE(ABORT,'journal reversal must match the original'); END;
-- 明細の行から作る有効な仕訳は1行に1本（取り消してから作り直す）
CREATE TRIGGER IF NOT EXISTS journal_entries_one_active_per_line BEFORE INSERT ON journal_entries
 WHEN NEW.source_kind='bank_line' AND NEW.reverses_entry_id IS NULL AND EXISTS(SELECT 1 FROM journal_entries e WHERE e.org_id=NEW.org_id
  AND e.bank_statement_line_id=NEW.bank_statement_line_id AND e.reverses_entry_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM journal_entries r WHERE r.org_id=e.org_id AND r.reverses_entry_id=e.id))
 BEGIN SELECT RAISE(ABORT,'bank line already has a journal'); END;

CREATE TABLE IF NOT EXISTS journal_lines (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 entry_id INTEGER NOT NULL,
 line_no INTEGER NOT NULL CHECK(typeof(line_no)='integer' AND line_no BETWEEN 1 AND 50),
 account_id INTEGER NOT NULL,
 side TEXT NOT NULL CHECK(side IN ('debit','credit')),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN 1 AND 1000000000000),
 bank_account_id INTEGER,
 memo TEXT CHECK(memo IS NULL OR length(memo) BETWEEN 1 AND 300),
 UNIQUE(org_id,id), UNIQUE(org_id,entry_id,line_no),
 FOREIGN KEY(org_id,entry_id) REFERENCES journal_entries(org_id,id),
 FOREIGN KEY(org_id,account_id) REFERENCES gl_accounts(org_id,id),
 FOREIGN KEY(org_id,bank_account_id) REFERENCES bank_accounts(org_id,id)
);
CREATE INDEX IF NOT EXISTS journal_lines_by_bank ON journal_lines(org_id,bank_account_id);
CREATE INDEX IF NOT EXISTS journal_lines_by_account ON journal_lines(org_id,account_id);
CREATE TRIGGER IF NOT EXISTS journal_lines_no_update BEFORE UPDATE ON journal_lines BEGIN SELECT RAISE(ABORT,'journal immutable'); END;
CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete BEFORE DELETE ON journal_lines BEGIN SELECT RAISE(ABORT,'journal immutable'); END;
-- 口座を持つ行は、その口座の科目でなければならない
CREATE TRIGGER IF NOT EXISTS journal_lines_bank_account_scope BEFORE INSERT ON journal_lines
 WHEN NEW.bank_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bank_accounts b WHERE b.org_id=NEW.org_id AND b.id=NEW.bank_account_id AND b.gl_account_id=NEW.account_id)
 BEGIN SELECT RAISE(ABORT,'journal line bank account must match its account'); END;
-- 行の数は見出しの数まで
CREATE TRIGGER IF NOT EXISTS journal_lines_count BEFORE INSERT ON journal_lines
 WHEN (SELECT COUNT(*) FROM journal_lines l WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.entry_id)>=(SELECT e.line_count FROM journal_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.entry_id)
 BEGIN SELECT RAISE(ABORT,'journal has too many lines'); END;
-- 行がそろったら、借方計＝貸方計
CREATE TRIGGER IF NOT EXISTS journal_lines_balanced AFTER INSERT ON journal_lines
 WHEN (SELECT COUNT(*) FROM journal_lines l WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.entry_id)=(SELECT e.line_count FROM journal_entries e WHERE e.org_id=NEW.org_id AND e.id=NEW.entry_id)
  AND (SELECT COALESCE(SUM(l.amount_yen),0) FROM journal_lines l WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.entry_id AND l.side='debit')
   <>(SELECT COALESCE(SUM(l.amount_yen),0) FROM journal_lines l WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.entry_id AND l.side='credit')
 BEGIN SELECT RAISE(ABORT,'journal debit and credit differ'); END;
