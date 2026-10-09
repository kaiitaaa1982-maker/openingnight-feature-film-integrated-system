import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {DOMAINS, labelOf, optionsOf, columnLabel, columnSpecFor, VERBS, isKnownCode} from '../src/ui/labels.mjs';

// DB の CHECK 制約（src/*.sql）にあるコード値を、表.列ごとに拾う。
function checkEnumerations() {
  const dir = new URL('../src/', import.meta.url);
  const out = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    const tables = [...text.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)\s*\(/gi)].map((m) => ({name: m[1], at: m.index}));
    for (const m of text.matchAll(/CHECK\s*\(\s*([a-z_]+)\s+IN\s*\(([^)]*)\)\s*\)/gi)) {
      if (!m[2].includes("'")) continue;
      const table = tables.filter((t) => t.at < m.index).at(-1)?.name;
      out.set(`${table}.${m[1]}`, m[2].split(',').map((value) => value.trim().replace(/^'|'$/g, '')));
    }
  }
  return out;
}

const COVERAGE = {
  'projects.status': 'projectStatus', 'products.channel': 'productChannel', 'partners.kind': 'partnerKind',
  'sales_opportunities.stage': 'opportunityStage', 'scenes.status': 'sceneStatus', 'report_imports.kind': 'reportKind',
  'report_imports.status': 'reportStatus', 'memberships.role': 'role', 'invitations.role': 'role', 'invitations.status': 'invitationStatus',
  'project_memberships.permission': 'projectPermission', 'sales_activities.activity_type': 'activityType',
  'sales_deliverables.status': 'deliverableStatus', 'prep_tasks.status': 'prepTaskStatus', 'broadcast_slot_versions.status': 'broadcastStatus',
  'sales_availability_versions.status': 'availabilityStatus', 'catalog_product_windows.status': 'availabilityStatus',
  'sales_availability_versions.exclusivity': 'exclusivity', 'sale_distribution_versions.settlement_method': 'dealType',
  'digital_sale_details.model': 'digitalModel', 'package_sale_details.model': 'packageModel', 'theatrical_sale_details.model': 'theatricalModel',
  'package_report_observations.metric': 'packageMetric', 'observations.granularity': 'granularity', 'observations.verification': 'verification',
  'tax_calculation_lines.category': 'taxCategory', 'tax_invoice_rate_totals.category': 'taxCategory', 'tax_rule_versions.basis': 'taxBasis',
  'tax_rule_versions.rounding_mode': 'roundingMode', 'tax_rule_versions.grouping_mode': 'taxGrouping', 'tax_rule_versions.scope_type': 'taxScope',
  'receipt_plan_decisions.decision': 'receiptDecision', 'billing_invoices.status': 'invoiceRecordStatus',
  'settlement_contracts.contract_type': 'contractType', 'rights_intake_cases.intake_type': 'intakeType',
  'rights_intake_participants.party_kind': 'partyKind', 'committee_snapshot_reports.report_basis': 'reportBasis',
  'settlement_report_links.report_basis': 'reportBasis', 'committee_term_windows.route': 'route', 'committee_snapshot_member_amounts.route': 'route',
  'committee_term_windows.fee_order': 'feeOrder', 'committee_term_windows.window_fee_basis': 'feeBasis',
  'committee_term_windows.manager_fee_basis': 'feeBasis', 'committee_term_windows.kind': 'committeeWindowKind',
  'committee_schedule_phases.reference_type': 'referenceType', 'committee_snapshot_deductions.category': 'deductionCategory',
  'committee_report_snapshots.period_date_basis': 'periodDateBasis', 'joint_committee_costs.kind': 'jointCostKind',
  'joint_committee_costs.tax_basis': 'taxAmountBasis', 'joint_funding_events.kind': 'fundingKind',
  'joint_production_milestones.stage': 'milestoneStage', 'mg_term_versions.mode': 'mgMode', 'mg_ledger_entries.status': 'mgLedgerStatus',
  'day_scene_assignments.outcome': 'sceneOutcome', 'production_day_slots.kind': 'daySlotKind', 'catalog_credits.role': 'creditRole',
  'catalog_edition_tags.kind': 'editionTagKind', 'change_proposals.status': 'proposalStatus', 'change_proposals.source': 'proposalSource',
  'workflow_report_selections.suggestion_source': 'suggestionSource', 'workflow_raw_artifacts.kind': 'rawArtifactKind',
  'workflow_raw_artifacts.extraction_status': 'extractionStatus', 'report_source_controls.metric': 'controlMetric',
  'report_source_controls.scope_kind': 'controlScope', 'metric_definitions.aggregation': 'metricAggregation',
  'metric_definitions.value_type': 'valueType', 'sales_agreement_term_versions.channel': 'channel',
  'report_mapping_profiles.kind': 'reportKind', 'mapping_import_provenance.kind': 'reportKind',
  'sales_source_files.storage': 'sourceStorage', 'sales_source_files.extraction_status': 'extractionStatus',
  'sales_source_selections.suggestion_source': 'suggestionSource', 'sales_source_bindings.mode': 'sourceBindingMode',
};

test('DB の CHECK 制約にあるコード値は、すべて辞書で日本語になる', () => {
  const enums = checkEnumerations();
  for (const [column, domain] of Object.entries(COVERAGE)) {
    assert.ok(DOMAINS[domain], `辞書がありません: ${domain}`);
    assert.ok(enums.has(column), `CHECK 制約が見つかりません: ${column}`);
    for (const code of enums.get(column)) {
      assert.ok(isKnownCode(domain, code), `${column} の ${code} が ${domain} にありません`);
      assert.doesNotMatch(labelOf(domain, code), /未登録の値/);
    }
  }
});

test('画面の選択肢に出ていたコード値（昼夜・広告区分・形式・招待の役割）も網羅する', () => {
  assert.equal(labelOf('dayNight', 'D'), '昼');
  assert.equal(labelOf('dayNight', 'N'), '夜');
  assert.equal(labelOf('dayNight', 'DN'), '薄暮');
  assert.deepEqual(optionsOf('paidOrganic').map((o) => o.value), ['unknown', 'paid', 'organic', 'mixed']);
  assert.equal(labelOf('workFormat', 'film'), '映画');
  assert.equal(labelOf('workFormat', 'series'), 'シリーズ');
  assert.equal(labelOf('mgDirection', 'incoming'), '受取MG（販売先）');
  assert.equal(labelOf('changeSetStatus', 'submitted'), '承認申請中');
  assert.equal(labelOf('invoiceStatus', 'partially_paid'), '一部入金');
});

test('未知のコードは推測で訳さず「未登録の値（code）」、空は「未確認」', () => {
  assert.equal(labelOf('projectStatus', 'planning'), '企画中');
  assert.equal(labelOf('productChannel', 'xyz'), '未登録の値（xyz）');
  assert.equal(labelOf('辞書なし', 'abc'), '未登録の値（abc）');
  assert.equal(labelOf('projectStatus', null), '未確認');
  assert.equal(labelOf('projectStatus', ''), '未確認');
  assert.equal(labelOf('dealType', 'MG'), 'MG');
  assert.equal(labelOf('projectStatus', 'toString'), '未登録の値（toString）');
  assert.deepEqual(optionsOf('opportunityStage')[0], {value: 'lead', label: '見込'});
  assert.equal(optionsOf('opportunityStage').length, 5);
  assert.deepEqual(optionsOf('存在しない'), []);
});

test('列の和名は main.jsx の LABELS を引き継ぎ、未知の列は null', () => {
  const inherited = {id: 'ID', code: 'コード', budget_yen: '予算', amount_ex_tax: '税抜', amount_inc_tax: '税込', tax_amount: '税額',
    day_night: '昼夜', paid_organic: '広告区分', allocation_bps: '配賦率', resolved_month: '基準から算出した月', accounting_month: '実計上月'};
  for (const [key, label] of Object.entries(inherited)) assert.equal(columnLabel(key), label, key);
  assert.equal(columnLabel('report_id'), '売上報告');
  assert.equal(columnLabel('source_row'), '原本の行');
  assert.equal(columnLabel('mystery_column'), null);
  assert.equal(columnLabel('constructor'), null);
});

test('列名から型・辞書・既定の非表示を推し量る', () => {
  assert.deepEqual(columnSpecFor('amount_ex_tax'), {key: 'amount_ex_tax', label: '税抜', type: 'yen', total: 'sum'});
  assert.equal(columnSpecFor('status', {resource: 'projects'}).domain, 'projectStatus');
  assert.equal(columnSpecFor('status', {resource: 'scenes'}).domain, 'sceneStatus');
  assert.equal(columnSpecFor('day_night').domain, 'dayNight');
  assert.equal(columnSpecFor('org_id').hidden, true);
  assert.equal(columnSpecFor('created_at').hidden, true);
  assert.equal(columnSpecFor('mystery').hidden, true);
  assert.equal(columnSpecFor('work_id').type, 'id');
  assert.equal(columnSpecFor('incurred_on').type, 'date');
  assert.equal(columnSpecFor('accounting_month').type, 'month');
  assert.equal(columnSpecFor('synopsis').wrap, true);
  const bps = columnSpecFor('allocation_bps');
  assert.equal(bps.type, 'rate');
  assert.equal(bps.value({allocation_bps: 2500}), 0.25);
});

test('ボタンの動詞は辞書から選ぶ', () => {
  assert.equal(VERBS.edit, '修正');
  assert.equal(VERBS.newVersion, '新しい版を作る');
  assert.equal(VERBS.void, '取り消す');
  assert.equal(VERBS.close, '閉じる');
  assert.equal(VERBS.sendBack, '差し戻す');
  assert.equal(VERBS.excel, 'Excel');
  assert.ok(Object.isFrozen(VERBS));
  assert.ok(Object.isFrozen(DOMAINS.projectStatus));
});
