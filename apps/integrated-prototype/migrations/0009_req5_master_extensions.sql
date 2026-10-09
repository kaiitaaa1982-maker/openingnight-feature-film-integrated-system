-- 依頼5：作品・商品マスタの追加表。master-extensions/work-master.sql・master-extensions/product-master.sql を連結。
-- scripts/build-ux-migration.mjs で生成。0008 の後に適用。本番には自動適用しない。

-- 作品マスタの追記型の版。既存表を変更しない。金額の正本・参照を分離する。
CREATE TABLE IF NOT EXISTS work_master_profile_versions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 series TEXT,
 label TEXT,
 production_category TEXT,
 registration_state TEXT NOT NULL CHECK(registration_state IN ('unconfirmed','provisional','confirmed')),
 work_kind TEXT NOT NULL CHECK(work_kind IN ('work','aggregate','unresolved')),
 internal_notes TEXT,
 other1 TEXT,
 other2 TEXT,
 lead_distribution_class TEXT,
 cycle_boundary_date TEXT,
 active_flag TEXT,
 overseas_sales_rights TEXT,
 distribution_rights TEXT,
 primary_use TEXT,
 secondary_use TEXT,
 copyright_royalty_notes TEXT,
 director_copyright_royalty_status TEXT,
 screenplay_copyright_royalty_status TEXT,
 original_work_copyright_royalty_status TEXT,
 music_copyright_royalty_status TEXT,
 producer_royalty_status TEXT,
 video_quality_subtitle_dubbing TEXT,
 dubbing_availability TEXT,
 music_copyright_society_registration TEXT,
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,work_id,revision), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS work_master_profile_versions_sequence BEFORE INSERT ON work_master_profile_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(revision),0)+1 FROM work_master_profile_versions WHERE org_id=NEW.org_id AND work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'stale master revision'); END;
CREATE TRIGGER IF NOT EXISTS work_master_profile_versions_no_update BEFORE UPDATE ON work_master_profile_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_master_profile_versions_no_delete BEFORE DELETE ON work_master_profile_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TABLE IF NOT EXISTS work_finance_versions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 committee_term_version_id INTEGER, self_partner_id INTEGER,
 production_cost_yen INTEGER CHECK(production_cost_yen BETWEEN 0 AND 1000000000000),
 production_cost_tax_basis TEXT NOT NULL CHECK(production_cost_tax_basis IN ('unknown','ex_tax','inc_tax')),
 production_cost_status TEXT NOT NULL CHECK(production_cost_status IN ('unknown','estimated','confirmed')),
 production_cost_as_of TEXT, production_cost_evidence TEXT,

 promotion_budget_yen INTEGER CHECK(promotion_budget_yen BETWEEN 0 AND 1000000000000),
 promotion_budget_tax_basis TEXT NOT NULL CHECK(promotion_budget_tax_basis IN ('unknown','ex_tax','inc_tax')),
 promotion_budget_status TEXT NOT NULL CHECK(promotion_budget_status IN ('unknown','estimated','confirmed')),
 promotion_budget_as_of TEXT, promotion_budget_evidence TEXT,

 own_investment_yen INTEGER CHECK(own_investment_yen BETWEEN 0 AND 1000000000000),
 own_investment_tax_basis TEXT NOT NULL CHECK(own_investment_tax_basis IN ('unknown','ex_tax','inc_tax')) CHECK(own_investment_tax_basis='ex_tax'),
 own_investment_status TEXT NOT NULL CHECK(own_investment_status IN ('unknown','estimated','confirmed')),
 own_investment_as_of TEXT, own_investment_evidence TEXT,

 sales_rights_purchase_yen INTEGER CHECK(sales_rights_purchase_yen BETWEEN 0 AND 1000000000000),
 sales_rights_purchase_tax_basis TEXT NOT NULL CHECK(sales_rights_purchase_tax_basis IN ('unknown','ex_tax','inc_tax')),
 sales_rights_purchase_status TEXT NOT NULL CHECK(sales_rights_purchase_status IN ('unknown','estimated','confirmed')),
 sales_rights_purchase_as_of TEXT, sales_rights_purchase_evidence TEXT,

 source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,work_id,revision), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),CHECK((production_cost_yen IS NULL AND production_cost_status='unknown') OR (production_cost_yen IS NOT NULL AND production_cost_status<>'unknown' AND production_cost_as_of IS NOT NULL AND production_cost_evidence IS NOT NULL AND length(trim(production_cost_evidence))>0)),CHECK((promotion_budget_yen IS NULL AND promotion_budget_status='unknown') OR (promotion_budget_yen IS NOT NULL AND promotion_budget_status<>'unknown' AND promotion_budget_as_of IS NOT NULL AND promotion_budget_evidence IS NOT NULL AND length(trim(promotion_budget_evidence))>0)),CHECK((own_investment_yen IS NULL AND own_investment_status='unknown') OR (own_investment_yen IS NOT NULL AND own_investment_status<>'unknown' AND own_investment_as_of IS NOT NULL AND own_investment_evidence IS NOT NULL AND length(trim(own_investment_evidence))>0)),CHECK((sales_rights_purchase_yen IS NULL AND sales_rights_purchase_status='unknown') OR (sales_rights_purchase_yen IS NOT NULL AND sales_rights_purchase_status<>'unknown' AND sales_rights_purchase_as_of IS NOT NULL AND sales_rights_purchase_evidence IS NOT NULL AND length(trim(sales_rights_purchase_evidence))>0)), FOREIGN KEY(org_id,committee_term_version_id) REFERENCES committee_term_versions(org_id,id),
 FOREIGN KEY(org_id,self_partner_id) REFERENCES partners(org_id,id),
 CHECK(committee_term_version_id IS NULL OR (production_cost_yen IS NULL AND own_investment_yen IS NULL))
);
CREATE TRIGGER IF NOT EXISTS work_finance_versions_sequence BEFORE INSERT ON work_finance_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(revision),0)+1 FROM work_finance_versions WHERE org_id=NEW.org_id AND work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'stale master revision'); END;
CREATE TRIGGER IF NOT EXISTS work_finance_versions_no_update BEFORE UPDATE ON work_finance_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_finance_versions_no_delete BEFORE DELETE ON work_finance_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_finance_committee_work BEFORE INSERT ON work_finance_versions
 WHEN NEW.committee_term_version_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM committee_term_versions v JOIN committee_contracts c ON c.org_id=v.org_id AND c.id=v.contract_id
 WHERE v.org_id=NEW.org_id AND v.id=NEW.committee_term_version_id AND c.work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'committee work mismatch'); END;
CREATE TABLE IF NOT EXISTS work_contract_set_versions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,work_id,revision), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS work_contract_set_versions_sequence BEFORE INSERT ON work_contract_set_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(revision),0)+1 FROM work_contract_set_versions WHERE org_id=NEW.org_id AND work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'stale master revision'); END;
CREATE TRIGGER IF NOT EXISTS work_contract_set_versions_no_update BEFORE UPDATE ON work_contract_set_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_contract_set_versions_no_delete BEFORE DELETE ON work_contract_set_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TABLE IF NOT EXISTS work_contracts (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, contract_key TEXT NOT NULL,
 PRIMARY KEY(org_id,work_id,contract_key), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id)
);
CREATE TABLE IF NOT EXISTS work_contract_versions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, contract_key TEXT NOT NULL,
 position INTEGER NOT NULL CHECK(position>=0), title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('acquisition','investment','production','distribution','other')),
 signed_on TEXT, starts_on TEXT, ends_on TEXT, partner_id INTEGER NOT NULL, document_reference TEXT NOT NULL CHECK(length(trim(document_reference))>0),
 PRIMARY KEY(org_id,work_id,revision,contract_key), UNIQUE(org_id,work_id,revision,position),
 FOREIGN KEY(org_id,work_id,revision) REFERENCES work_contract_set_versions(org_id,work_id,revision),
 FOREIGN KEY(org_id,work_id,contract_key) REFERENCES work_contracts(org_id,work_id,contract_key),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id), CHECK(starts_on IS NULL OR ends_on IS NULL OR starts_on<=ends_on)
);
CREATE TRIGGER IF NOT EXISTS work_contracts_no_update BEFORE UPDATE ON work_contracts BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_contracts_no_delete BEFORE DELETE ON work_contracts BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_contract_versions_no_update BEFORE UPDATE ON work_contract_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_contract_versions_no_delete BEFORE DELETE ON work_contract_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TABLE IF NOT EXISTS work_rights_versions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 
 source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,work_id,revision), FOREIGN KEY(org_id,work_id) REFERENCES works(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE TRIGGER IF NOT EXISTS work_rights_versions_sequence BEFORE INSERT ON work_rights_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(revision),0)+1 FROM work_rights_versions WHERE org_id=NEW.org_id AND work_id=NEW.work_id)
 BEGIN SELECT RAISE(ABORT,'stale master revision'); END;
CREATE TRIGGER IF NOT EXISTS work_rights_versions_no_update BEFORE UPDATE ON work_rights_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_rights_versions_no_delete BEFORE DELETE ON work_rights_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TABLE IF NOT EXISTS work_rights_party_versions (
 org_id INTEGER NOT NULL, work_id INTEGER NOT NULL, revision INTEGER NOT NULL, position INTEGER NOT NULL CHECK(position>=0),
 partner_id INTEGER, name TEXT, role TEXT NOT NULL CHECK(length(trim(role))>0), rights_scope TEXT, notes TEXT, evidence TEXT NOT NULL CHECK(length(trim(evidence))>0),
 PRIMARY KEY(org_id,work_id,revision,position),
 FOREIGN KEY(org_id,work_id,revision) REFERENCES work_rights_versions(org_id,work_id,revision),
 FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id), CHECK(partner_id IS NOT NULL OR (name IS NOT NULL AND length(trim(name))>0))
);
CREATE TRIGGER IF NOT EXISTS work_rights_party_versions_no_update BEFORE UPDATE ON work_rights_party_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS work_rights_party_versions_no_delete BEFORE DELETE ON work_rights_party_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;

-- 商品固有の仕様の版。products と product_works は変更しない。
CREATE TABLE IF NOT EXISTS product_master_profile_versions (
 org_id INTEGER NOT NULL, product_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 product_number TEXT,
 jan_code TEXT,
 product_type TEXT,
 media TEXT,
 release_on TEXT,
 sales_end_on TEXT,
 publisher_partner_id INTEGER,
 distributor_partner_id INTEGER,
 label TEXT,
 series TEXT,
 sales_class TEXT,
 disc_count INTEGER CHECK(disc_count>=0),
 disc_layer TEXT,
 case_color TEXT,
 pressing_company TEXT,
 audio TEXT,
 subtitles TEXT,
 video_quality TEXT,
 runtime_minutes INTEGER CHECK(runtime_minutes>=0),
 design TEXT,
 video_production_company TEXT,
 rights_holder TEXT,
 original_rights_holder TEXT,
 system_product_name TEXT,
 notes TEXT,
 other1 TEXT,
 other2 TEXT,
 price_yen INTEGER CHECK(price_yen BETWEEN 0 AND 1000000000000),
 price_tax_basis TEXT NOT NULL CHECK(price_tax_basis IN ('unknown','ex_tax','inc_tax')),
 price_status TEXT NOT NULL CHECK(price_status IN ('unknown','estimated','confirmed')),
 price_as_of TEXT, price_evidence TEXT,

 price_ex_tax_yen INTEGER CHECK(price_ex_tax_yen BETWEEN 0 AND 1000000000000),
 price_ex_tax_tax_basis TEXT NOT NULL CHECK(price_ex_tax_tax_basis IN ('unknown','ex_tax','inc_tax')) CHECK(price_ex_tax_tax_basis='ex_tax'),
 price_ex_tax_status TEXT NOT NULL CHECK(price_ex_tax_status IN ('unknown','estimated','confirmed')),
 price_ex_tax_as_of TEXT, price_ex_tax_evidence TEXT,

 price_inc_tax_yen INTEGER CHECK(price_inc_tax_yen BETWEEN 0 AND 1000000000000),
 price_inc_tax_tax_basis TEXT NOT NULL CHECK(price_inc_tax_tax_basis IN ('unknown','ex_tax','inc_tax')) CHECK(price_inc_tax_tax_basis='inc_tax'),
 price_inc_tax_status TEXT NOT NULL CHECK(price_inc_tax_status IN ('unknown','estimated','confirmed')),
 price_inc_tax_as_of TEXT, price_inc_tax_evidence TEXT,

 source_reference TEXT NOT NULL CHECK(length(trim(source_reference)) BETWEEN 1 AND 1000),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000), created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(org_id,product_id,revision), FOREIGN KEY(org_id,product_id) REFERENCES products(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id),CHECK((price_yen IS NULL AND price_status='unknown') OR (price_yen IS NOT NULL AND price_status<>'unknown' AND price_as_of IS NOT NULL AND price_evidence IS NOT NULL AND length(trim(price_evidence))>0)),CHECK((price_ex_tax_yen IS NULL AND price_ex_tax_status='unknown') OR (price_ex_tax_yen IS NOT NULL AND price_ex_tax_status<>'unknown' AND price_ex_tax_as_of IS NOT NULL AND price_ex_tax_evidence IS NOT NULL AND length(trim(price_ex_tax_evidence))>0)),CHECK((price_inc_tax_yen IS NULL AND price_inc_tax_status='unknown') OR (price_inc_tax_yen IS NOT NULL AND price_inc_tax_status<>'unknown' AND price_inc_tax_as_of IS NOT NULL AND price_inc_tax_evidence IS NOT NULL AND length(trim(price_inc_tax_evidence))>0)),
 FOREIGN KEY(org_id,publisher_partner_id) REFERENCES partners(org_id,id), FOREIGN KEY(org_id,distributor_partner_id) REFERENCES partners(org_id,id),
 CHECK(jan_code IS NULL OR (length(jan_code) IN (8,13) AND jan_code NOT GLOB '*[^0-9]*')),
 CHECK(release_on IS NULL OR sales_end_on IS NULL OR release_on<=sales_end_on)
);
CREATE TRIGGER IF NOT EXISTS product_master_profile_versions_sequence BEFORE INSERT ON product_master_profile_versions
 WHEN NEW.revision<>(SELECT COALESCE(MAX(revision),0)+1 FROM product_master_profile_versions WHERE org_id=NEW.org_id AND product_id=NEW.product_id)
 BEGIN SELECT RAISE(ABORT,'stale master revision'); END;
CREATE TRIGGER IF NOT EXISTS product_master_profile_versions_no_update BEFORE UPDATE ON product_master_profile_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
CREATE TRIGGER IF NOT EXISTS product_master_profile_versions_no_delete BEFORE DELETE ON product_master_profile_versions BEGIN SELECT RAISE(ABORT,'master version immutable'); END;
