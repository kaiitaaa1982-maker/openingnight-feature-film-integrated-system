-- Explicit totals transcribed from a source report. Missing metrics remain unverified.
-- Each metric is one immutable fact; a correction is a new report_imports version.
CREATE TABLE IF NOT EXISTS report_source_controls (
  org_id INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('report','channel')),
  channel TEXT NOT NULL DEFAULT '',
  metric TEXT NOT NULL CHECK(metric IN ('row_count','amount_ex_tax','tax_amount','amount_inc_tax')),
  expected_value INTEGER NOT NULL CHECK(expected_value BETWEEN -9007199254740991 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(org_id,report_id,scope_kind,channel,metric),
  FOREIGN KEY(org_id,report_id) REFERENCES report_imports(org_id,id),
  CHECK((scope_kind='report' AND channel='') OR
        (scope_kind='channel' AND channel IN ('theatrical','digital','package','broadcast','other'))),
  CHECK(metric<>'row_count' OR expected_value>=0)
);

CREATE TRIGGER IF NOT EXISTS report_source_control_channel_scope BEFORE INSERT ON report_source_controls
WHEN NEW.scope_kind='channel'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM report_imports r
    WHERE r.org_id=NEW.org_id AND r.id=NEW.report_id AND r.kind=NEW.channel
  ) THEN RAISE(ABORT,'source control channel must match report kind') END;
END;

CREATE TRIGGER IF NOT EXISTS report_source_control_matches_sealed_report BEFORE INSERT ON report_source_controls
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM report_channel_fact_seals f WHERE f.org_id=NEW.org_id AND f.report_id=NEW.report_id
  ) THEN RAISE(ABORT,'source control requires sealed report') END;
  SELECT CASE WHEN NEW.expected_value <> CASE NEW.metric
    WHEN 'row_count' THEN
      (SELECT COUNT(*) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
      + (SELECT COUNT(DISTINCT o.source_row) FROM package_report_observations o
         WHERE o.org_id=NEW.org_id AND o.report_id=NEW.report_id
           AND NOT EXISTS (SELECT 1 FROM sale_lines s
             WHERE s.org_id=o.org_id AND s.report_id=o.report_id AND s.source_row=o.source_row))
    WHEN 'amount_ex_tax' THEN
      (SELECT COALESCE(SUM(s.amount_ex_tax),0) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
    WHEN 'tax_amount' THEN
      (SELECT COALESCE(SUM(s.tax_amount),0) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
    WHEN 'amount_inc_tax' THEN
      (SELECT COALESCE(SUM(s.amount_inc_tax),0) FROM sale_lines s WHERE s.org_id=NEW.org_id AND s.report_id=NEW.report_id)
  END THEN RAISE(ABORT,'source control does not match sealed report') END;
END;

CREATE TRIGGER IF NOT EXISTS report_source_control_immutable_update BEFORE UPDATE ON report_source_controls
BEGIN SELECT RAISE(ABORT,'source control is immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_source_control_immutable_delete BEFORE DELETE ON report_source_controls
BEGIN SELECT RAISE(ABORT,'source control is immutable'); END;

-- Controls are checked after all report rows are inserted in the same transaction.
-- Freeze those rows thereafter so the persisted reconciliation remains true.
CREATE TRIGGER IF NOT EXISTS report_source_control_sale_insert BEFORE INSERT ON sale_lines
WHEN NEW.report_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled sale is immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_source_control_sale_update BEFORE UPDATE ON sale_lines
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
) OR EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled sale is immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_source_control_sale_delete BEFORE DELETE ON sale_lines
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled sale is immutable'); END;

CREATE TRIGGER IF NOT EXISTS report_source_control_observation_insert BEFORE INSERT ON package_report_observations
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled observation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_source_control_observation_update BEFORE UPDATE ON package_report_observations
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
) OR EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=NEW.org_id AND c.report_id=NEW.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled observation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS report_source_control_observation_delete BEFORE DELETE ON package_report_observations
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.report_id
)
BEGIN SELECT RAISE(ABORT,'source-controlled observation is immutable'); END;

CREATE TRIGGER IF NOT EXISTS report_source_control_report_identity_update
BEFORE UPDATE OF org_id,report_key,content_hash,kind ON report_imports
WHEN EXISTS (
  SELECT 1 FROM report_source_controls c WHERE c.org_id=OLD.org_id AND c.report_id=OLD.id
)
BEGIN SELECT RAISE(ABORT,'source-controlled report identity is immutable'); END;
