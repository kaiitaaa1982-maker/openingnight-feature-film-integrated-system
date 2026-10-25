-- 製作委員会の収支の台帳（要件 docs/requirements/settlement/committee.md の FR-SETL-COMM-015〜019。会社ルートの plans/2026-10-23-committee-terms-ledger.md の C）。
-- 足すだけの移行: 1表と、その表だけのトリガーを作る。既存の表は変えない。番号 0044 は調整役から受け取った。
--
-- committee_ledger_entries: 委員会の収支を、回（契約×段×締め日）×事業化権利×区分×項目×相手の行として追加だけで積む。
--   累計の列は持たない。収支報告書（前回まで累計・今回・累計、A〜E）と、当事者・著作権者・成功報酬の受取人・業務担当者ごとの累計は、
--   いつも行の和で導く（src/committee/ledger/committee-ledger-model.mjs）。配分金・A・D は区分の和から導くので行にしない。
--   出どころ: computed（自社が幹事として計算した回）／received（幹事から届いた収支報告書を全行入れた回）／manual（人が入れた行）。
--   直しは削除しない。取り消す行を指す負の行（reverses_id・理由必須・同じ契約・段・回・区分で額が符号違い）を足す。1行は1回だけ取り消せる。
--   金額は税抜の円。消費税の列は持たない（報告書がインボイスを兼ねるときの扱いは要件の要確認4）。
--
-- トリガーの本体に CASE を書かない。決まりごとに WHEN 句のトリガーを1本ずつ作る。形の CHECK は GLOB を使わない。

CREATE TABLE IF NOT EXISTS committee_ledger_entries (
 id INTEGER PRIMARY KEY,
 org_id INTEGER NOT NULL,
 contract_id INTEGER NOT NULL,
 tier TEXT NOT NULL CHECK(tier IN ('to_manager','to_members')),
 close_on TEXT NOT NULL CHECK(length(close_on)=10 AND substr(close_on,5,1)='-' AND substr(close_on,8,1)='-'
  AND ltrim(substr(close_on,1,4)||substr(close_on,6,2)||substr(close_on,9,2),'0123456789')=''
  AND substr(close_on,6,2) BETWEEN '01' AND '12' AND substr(close_on,9,2) BETWEEN '01' AND '31'),
 business_code TEXT CHECK(business_code IS NULL OR business_code IN ('theatrical','program','non_theatrical','home_video','commercial_video','internet','tv','ancillary','publishing','merchandising','overseas','music_master','music_publishing','other')),
 section TEXT NOT NULL CHECK(section IN ('income','expense','secondary_royalty','agent_fee','other_income','overhead','manager_fee','success_fee','member_distribution')),
 item TEXT CHECK(item IS NULL OR length(trim(item)) BETWEEN 1 AND 200),
 counterparty_partner_id INTEGER,
 holder_role TEXT CHECK(holder_role IS NULL OR holder_role IN ('original','director','screenplay','music','other')),
 amount_yen INTEGER NOT NULL CHECK(typeof(amount_yen)='integer' AND amount_yen BETWEEN -9007199254740991 AND 9007199254740991),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('computed','received','manual')),
 source_reference TEXT CHECK(source_reference IS NULL OR length(trim(source_reference)) BETWEEN 1 AND 200),
 reverses_id INTEGER,
 reason TEXT CHECK(reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(org_id,id),
 FOREIGN KEY(org_id,contract_id) REFERENCES committee_contracts(org_id,id),
 FOREIGN KEY(org_id,counterparty_partner_id) REFERENCES partners(org_id,id),
 FOREIGN KEY(org_id,reverses_id) REFERENCES committee_ledger_entries(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),
 CHECK((section IN ('income','expense','secondary_royalty','agent_fee') AND business_code IS NOT NULL)
  OR (section NOT IN ('income','expense','secondary_royalty','agent_fee') AND business_code IS NULL)),
 CHECK(holder_role IS NULL OR section='secondary_royalty'),
 CHECK(section<>'member_distribution' OR counterparty_partner_id IS NOT NULL),
 CHECK((reverses_id IS NULL AND reason IS NULL) OR (reverses_id IS NOT NULL AND reason IS NOT NULL AND reverses_id<>id))
);
-- 取消の行は、取り消す行と同じ契約・段・回・事業・区分・相手・役で、額が符号違い
CREATE TRIGGER IF NOT EXISTS committee_ledger_entries_reversal BEFORE INSERT ON committee_ledger_entries
 WHEN NEW.reverses_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committee_ledger_entries o WHERE o.org_id=NEW.org_id AND o.id=NEW.reverses_id
  AND o.reverses_id IS NULL AND o.contract_id=NEW.contract_id AND o.tier=NEW.tier AND o.close_on=NEW.close_on
  AND COALESCE(o.business_code,'')=COALESCE(NEW.business_code,'') AND o.section=NEW.section
  AND COALESCE(o.counterparty_partner_id,0)=COALESCE(NEW.counterparty_partner_id,0) AND COALESCE(o.holder_role,'')=COALESCE(NEW.holder_role,'')
  AND o.amount_yen=-NEW.amount_yen)
 BEGIN SELECT RAISE(ABORT,'committee ledger reversal mismatch'); END;
-- 1行は1回だけ取り消せる（取消の行の決まりに当たらないものだけを見る）
CREATE TRIGGER IF NOT EXISTS committee_ledger_entries_reverse_once BEFORE INSERT ON committee_ledger_entries
 WHEN NEW.reverses_id IS NOT NULL AND EXISTS (SELECT 1 FROM committee_ledger_entries r WHERE r.org_id=NEW.org_id AND r.reverses_id=NEW.reverses_id)
 BEGIN SELECT RAISE(ABORT,'committee ledger entry already reversed'); END;
CREATE TRIGGER IF NOT EXISTS committee_ledger_entries_no_update BEFORE UPDATE ON committee_ledger_entries BEGIN SELECT RAISE(ABORT,'committee ledger immutable'); END;
CREATE TRIGGER IF NOT EXISTS committee_ledger_entries_no_delete BEFORE DELETE ON committee_ledger_entries BEGIN SELECT RAISE(ABORT,'committee ledger immutable'); END;
CREATE INDEX IF NOT EXISTS committee_ledger_entries_round_idx ON committee_ledger_entries(org_id,contract_id,tier,close_on);
CREATE INDEX IF NOT EXISTS committee_ledger_entries_party_idx ON committee_ledger_entries(org_id,counterparty_partner_id,section);
