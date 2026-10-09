CREATE TABLE IF NOT EXISTS tax_rule_versions (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, scope_type TEXT NOT NULL CHECK(scope_type IN ('default','partner')),
  partner_id INTEGER, version INTEGER NOT NULL CHECK(version>0), base_version INTEGER NOT NULL CHECK(base_version>=0),
  effective_from TEXT NOT NULL, effective_to TEXT,
  basis TEXT NOT NULL CHECK(basis IN ('exclusive','inclusive')),
  grouping_mode TEXT NOT NULL CHECK(grouping_mode IN ('invoice','voucher')),
  rounding_mode TEXT NOT NULL CHECK(rounding_mode IN ('truncate','half_up','ceil')),
  precision INTEGER NOT NULL CHECK(precision BETWEEN 0 AND 4), reason TEXT NOT NULL, evidence TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,scope_type,partner_id,version),
  CHECK((scope_type='default' AND partner_id IS NULL) OR (scope_type='partner' AND partner_id IS NOT NULL)),
  CHECK(effective_to IS NULL OR effective_to>=effective_from),
  CHECK(length(trim(reason)) BETWEEN 1 AND 1000), CHECK(length(trim(evidence)) BETWEEN 1 AND 4000),
  FOREIGN KEY(org_id) REFERENCES organizations(id), FOREIGN KEY(org_id,partner_id) REFERENCES partners(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE INDEX IF NOT EXISTS tax_rules_resolve_idx ON tax_rule_versions(org_id,scope_type,partner_id,effective_from,effective_to,version);
CREATE UNIQUE INDEX IF NOT EXISTS tax_rule_scope_version_uq ON tax_rule_versions(org_id,scope_type,IFNULL(partner_id,0),version);
CREATE UNIQUE INDEX IF NOT EXISTS tax_rule_scope_start_uq ON tax_rule_versions(org_id,scope_type,IFNULL(partner_id,0),effective_from);

CREATE TABLE IF NOT EXISTS tax_calculation_snapshots (
  id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, invoice_id INTEGER, preview_hash TEXT NOT NULL,
  rule_version_id INTEGER NOT NULL, invoice_date TEXT NOT NULL, source_period_from TEXT NOT NULL, source_period_to TEXT NOT NULL,
  calculation_json TEXT NOT NULL, amount_ex_tax INTEGER NOT NULL, source_tax INTEGER NOT NULL,
  billed_tax INTEGER NOT NULL, delta INTEGER NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id,id), UNIQUE(org_id,invoice_id),
  CHECK(delta=billed_tax-source_tax), CHECK(source_period_to>=source_period_from),
  FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,rule_version_id) REFERENCES tax_rule_versions(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);
CREATE INDEX IF NOT EXISTS tax_snapshot_month_idx ON tax_calculation_snapshots(org_id,invoice_date,invoice_id);

CREATE TABLE IF NOT EXISTS tax_calculation_lines (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL, sale_id INTEGER NOT NULL, report_id INTEGER NOT NULL,
  voucher_id TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('standard','reduced','zero','exempt','non_taxable')),
  rate_bps INTEGER NOT NULL CHECK(rate_bps IN (0,800,1000)), amount_ex_tax INTEGER NOT NULL,
  source_tax INTEGER NOT NULL, amount_inc_tax INTEGER NOT NULL, exact_numerator TEXT NOT NULL, exact_denominator TEXT NOT NULL,
  reference_tax_scaled INTEGER NOT NULL, reference_precision INTEGER NOT NULL CHECK(reference_precision BETWEEN 0 AND 4),
  PRIMARY KEY(org_id,snapshot_id,sale_id),
  CHECK((category='standard' AND rate_bps=1000) OR (category='reduced' AND rate_bps=800) OR (category IN ('zero','exempt','non_taxable') AND rate_bps=0)),
  FOREIGN KEY(org_id,snapshot_id) REFERENCES tax_calculation_snapshots(org_id,id),
  FOREIGN KEY(org_id,sale_id) REFERENCES sale_lines(org_id,id), FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id)
);

CREATE TABLE IF NOT EXISTS tax_invoice_rate_totals (
  org_id INTEGER NOT NULL, snapshot_id INTEGER NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('standard','reduced','zero','exempt','non_taxable')),
  rate_bps INTEGER NOT NULL CHECK(rate_bps IN (0,800,1000)), amount_ex_tax INTEGER NOT NULL,
  exact_numerator TEXT NOT NULL, exact_denominator TEXT NOT NULL, billed_tax INTEGER NOT NULL, source_tax INTEGER NOT NULL, delta INTEGER NOT NULL,
  PRIMARY KEY(org_id,snapshot_id,category,rate_bps), CHECK(delta=billed_tax-source_tax),
  FOREIGN KEY(org_id,snapshot_id) REFERENCES tax_calculation_snapshots(org_id,id)
);

CREATE TABLE IF NOT EXISTS tax_invoice_links (
  org_id INTEGER NOT NULL, invoice_id INTEGER NOT NULL, prior_invoice_id INTEGER NOT NULL, reason TEXT NOT NULL,
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,invoice_id), CHECK(invoice_id<>prior_invoice_id), CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
  FOREIGN KEY(org_id,invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,prior_invoice_id) REFERENCES billing_invoices(org_id,id),
  FOREIGN KEY(org_id,created_by) REFERENCES memberships(org_id,user_id)
);

CREATE TRIGGER IF NOT EXISTS tax_rule_immutable BEFORE UPDATE ON tax_rule_versions BEGIN SELECT RAISE(ABORT,'tax rule versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_rule_no_delete BEFORE DELETE ON tax_rule_versions BEGIN SELECT RAISE(ABORT,'tax rule versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_snapshot_immutable BEFORE UPDATE ON tax_calculation_snapshots BEGIN SELECT RAISE(ABORT,'tax calculation snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_snapshot_no_delete BEFORE DELETE ON tax_calculation_snapshots BEGIN SELECT RAISE(ABORT,'tax calculation snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_line_immutable BEFORE UPDATE ON tax_calculation_lines BEGIN SELECT RAISE(ABORT,'tax calculation lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_line_no_delete BEFORE DELETE ON tax_calculation_lines BEGIN SELECT RAISE(ABORT,'tax calculation lines are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_total_immutable BEFORE UPDATE ON tax_invoice_rate_totals BEGIN SELECT RAISE(ABORT,'tax rate totals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_total_no_delete BEFORE DELETE ON tax_invoice_rate_totals BEGIN SELECT RAISE(ABORT,'tax rate totals are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_link_immutable BEFORE UPDATE ON tax_invoice_links BEGIN SELECT RAISE(ABORT,'tax invoice links are immutable'); END;
CREATE TRIGGER IF NOT EXISTS tax_link_no_delete BEFORE DELETE ON tax_invoice_links BEGIN SELECT RAISE(ABORT,'tax invoice links are immutable'); END;
