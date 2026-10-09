// 表の構造（ER）画面と設計キャンバスで使う純関数。表・列の和名、業務のまとまりごとの分類、参照の向き。
// DB の表名・列名は識別のために残すが、画面の主表示は和名にする（和名が無いものは「和名未登録」と書く）。
import {columnLabel} from '../ui/labels.mjs';
import {foreignKeys} from '../design-model.mjs';
import {EXPENSE_TABLE_LABELS,EXPENSE_COLUMN_LABELS,EXPENSE_COLUMN_MEANINGS} from '../expense-sheet/expense-definitions.mjs';
import {MASTER_TABLE_LABELS,MASTER_COLUMN_LABELS,MASTER_COLUMN_MEANINGS} from '../master-extensions/master-definitions.mjs';

// 表の和名。DB の CREATE TABLE（src/*.sql）の用途から付けた。ここに無い表は tableLabel() が null を返す。
export const TABLE_LABELS = Object.freeze({
  ...MASTER_TABLE_LABELS,...EXPENSE_TABLE_LABELS,
  organizations: '組織', users: '利用者', memberships: '組織の所属', project_memberships: '案件の権限', invitations: '招待',
  sessions: 'ログイン中の接続', org_switch_events: '組織の切替の記録', audit_log: '操作の記録', transaction_guards: '同時更新の防止（内部）', schema_meta: '項目定義の版',
  ai_usage: 'AIの利用回数', fiscal_settings: '会計年度の設定',
  // 分析の写しのジョブ（src/cloud-analytics.mjs。migrations/ の外でアプリが作る表。本番の D1 と pg/schema.sql にある）
  cloud_analytics_state: '分析の写しの状態', cloud_analytics_jobs: '分析の写しの実行記録',
  org_profile_versions: '会社の法人情報（版）', gl_accounts: '勘定科目', gl_manual_amounts: 'PL・BSの手入力の額',
  expense_payments: '経費の出金', committee_investment_payments: '委員会への出資の払込',
  projects: '案件', works: '作品', products: '商品', product_works: '商品の作品配賦', partners: '取引先',
  partner_profile_versions: '取引先の請求・連絡先（版）', distribution_master: '流通区分マスタ', distribution_types: '流通の種類',
  catalog_profiles: '作品の基本情報', catalog_credits: 'クレジット', catalog_editions: '作品の版（エディション）',
  catalog_edition_tags: '版の属性（国・言語など）', catalog_product_editions: '商品と版の対応', catalog_product_windows: '商品の販売ウィンドウ',
  sale_lines: '売上明細', report_imports: '売上報告', theatrical_sale_details: '劇場売上の詳細', digital_sale_details: '配信売上の詳細',
  package_sale_details: 'ビデオグラム売上の詳細', package_report_observations: 'ビデオグラム報告の観測値', package_observation_products: 'ビデオグラム観測の対象商品',
  sale_distribution_versions: '売上の流通区分（版）', report_sale_dimensions_versions: '売上の分類（版）', recognition_bases: '計上基準',
  report_recognition: '報告の計上根拠', report_source_controls: '報告の管理値（行数・合計）', report_channel_fact_seals: '報告の流通別の封印',
  report_mapping_profiles: '取引先別の列対応', report_mapping_versions: '列対応の版', mapping_import_provenance: '取込の変換根拠',
  import_previews: '取込の確認（旧方式）', expected_reports: '届くはずの報告', expected_report_closures: '届くはずの報告の締め',
  report_issuances: '帳票の発行記録', report_issuance_voids: '帳票発行の取消',
  bulk_import_batches: 'Excel一括登録の記録', bulk_import_previews: 'Excel一括登録（確認中）',
  billing_invoices: '請求書', billing_invoice_lines: '請求明細', billing_invoice_line_works: '請求明細の作品配賦',
  billing_invoice_sequences: '請求番号の採番', billing_invoice_voids: '請求の取消', billing_sale_claims: '請求済みの売上',
  billing_receipts: '入金', billing_receipt_allocations: '入金の消込', billing_receipt_reversals: '入金の取消',
  receipt_plan_requests: '入金予定の変更申請', receipt_plan_decisions: '入金予定の変更判断',
  tax_rule_versions: '税ルールの版', tax_calculation_snapshots: '税計算の記録', tax_calculation_lines: '税計算の明細',
  tax_invoice_rate_totals: '請求の税率別合計', tax_invoice_links: '税計算と請求の対応',
  expenses: '経費', campaigns: '宣伝施策', exposures: '露出', observations: '指標の観測値', metric_definitions: '指標の定義',
  change_proposals: '追加項目の提案',
  sales_opportunities: '営業案件', sales_activities: '営業の活動記録', sales_agreements: '販売契約',
  sales_agreement_term_versions: '販売契約の条件版', sales_deliverables: '納品物', sales_report_links: '販売契約と売上報告の対応',
  sales_availability_versions: '流通別の販売条件（版）', sales_material_snapshots: '営業資料の版',
  broadcast_slots: '放送枠', broadcast_slot_versions: '放送枠の版', broadcast_airings: '放送実績', broadcast_sale_links: '放送と売上の対応',
  broadcast_availability_rates: '番販の販売条件（料金）', broadcast_availability_previews: '番販の販売条件（取込の確認）',
  broadcast_import_previews: '放送枠（取込の確認）',
  rights_intake_cases: '権利の調達案件', rights_intake_documents: '調達の契約書類', rights_intake_scopes: '調達した権利の範囲',
  rights_intake_participants: '調達の参加者', intake_settlement_links: '調達と権利契約の対応', rights_payment_events: '権利料の支払',
  settlement_contracts: '権利契約', settlement_term_versions: '権利契約の条件版', settlement_report_links: '権利契約と報告の対応',
  committee_contracts: '製作委員会の契約', committee_term_versions: '委員会の条件版', committee_term_members: '委員会の参加者（条件版）',
  committee_term_windows: '委員会の窓口（流通別）', committee_term_investments: '委員会の出資額', committee_term_funding: '委員会の出資の形', committee_term_window_fee_shares: '委員会の窓口手数料の取り分', committee_term_version_effective: '委員会の条件版の適用開始月',
  committee_schedule_phases: '委員会の報告・支払日程', committee_report_previews: '委員会報告（作成中）', committee_report_snapshots: '委員会報告の下書き',
  committee_snapshot_reports: '委員会報告に含めた売上報告', committee_snapshot_expenses: '委員会報告の経費', committee_snapshot_deductions: '委員会報告の控除',
  committee_snapshot_lines: '委員会報告の明細', committee_snapshot_member_amounts: '委員会報告の分配額',
  joint_committee_contracts: '共同製作の契約', joint_committee_members: '共同製作の参加者', joint_committee_windows: '共同製作の窓口',
  joint_committee_periods: '共同製作の報告期間', joint_committee_sales: '共同製作の売上', joint_committee_costs: '共同製作の費用',
  joint_committee_snapshots: '共同製作の報告', joint_funding_events: '共同製作の出資', joint_production_milestones: '共同製作の制作段階',
  joint_business_holidays: '共同製作の休業日',
  royalty_agreements: 'ロイヤリティ契約', royalty_term_versions: 'ロイヤリティ契約の条件版', royalty_term_channels: 'ロイヤリティ条件版の対象流通',
  royalty_term_expense_categories: 'ロイヤリティ条件版の控除する経費の費目', royalty_schedule_versions: 'ロイヤリティのサイクルの版', royalty_schedule_phases: 'ロイヤリティのサイクルのフェーズ',
  royalty_manual_accruals: 'ロイヤリティの実額の計上', royalty_irregular_entries: 'ロイヤリティのイレギュラーの台帳', royalty_statements: 'ロイヤリティ報告書（確定版）',
  royalty_statement_voids: 'ロイヤリティ報告書の取消', royalty_statement_lines: 'ロイヤリティ報告書の明細', royalty_statement_events: 'ロイヤリティの報告・支払の記録', royalty_statement_calculation_parts: 'ロイヤリティ報告書の計算の内容（分割保存）',
  mg_suppliers: 'MGの仕入先', mg_incoming_contracts: '受取MGの契約', mg_outgoing_contracts: '支払MGの契約', mg_term_versions: 'MG契約の条件版',
  mg_version_products: 'MG条件版の対象商品', mg_version_phases: 'MG条件版の日程', mg_contract_links: 'MG契約の対応', mg_ledger_entries: 'MG台帳の記帳',
  scenes: 'シーン', shooting_days: '撮影日', day_scene_assignments: '撮影日ごとのシーン', prep_tasks: '撮影準備の作業',
  production_revisions: '制作情報の改訂', production_characters: '役', production_locations: 'ロケ地', production_location_plans: 'ロケ地の見取り図',
  production_scene_details: 'シーンの詳細', production_appearances: '出演（シーン×役）', production_looks: '衣装・メイク',
  production_scene_looks: 'シーンの衣装・メイク', production_day_slots: '撮影日の時間割', production_calls: '集合・呼び出し',
  workflow_raw_artifacts: '受領した原本', workflow_script_reviews: '台本の確認', workflow_schedule_previews: '香盤の確認',
  workflow_script_commits: '台本の登録確定', workflow_script_commit_scenes: '台本登録のシーン', workflow_script_commit_days: '台本登録の撮影日',
  workflow_report_selections: '報告の取込範囲', workflow_report_commits: '報告の登録確定',
  sales_source_files: '受領した売上原本（作品と切り離し）', sales_source_selections: '売上原本の取込範囲（版）', sales_source_bindings: '売上原本の作品への割り当て（版）',
  sales_source_partitions: '売上原本の作品ごとの分割', sales_source_commits: '売上原本の分割の登録確定',
  workbench_source_artifacts: '表編集の原本', workbench_snapshots: '表編集の元データ', workbench_drafts: '表編集の下書き',
  workbench_recipes: '加工手順', workbench_recipe_versions: '加工手順の版', workbench_validations: '表編集の検証',
  workbench_change_sets: '表編集の変更セット', workbench_applications: '表編集の反映', workbench_lineage: '表編集の変更経路',
  workbench_analysis_snapshots: '分析用の読取記録',
  release_window_types: 'ウィンドウの種別', release_window_type_versions: 'ウィンドウの種別の版', release_window_type_fields: 'ウィンドウの種別の追加項目',
  release_window_type_distributions: 'ウィンドウの種別と流通IDの対応', work_release_windows: '作品のウィンドウ（作品×種別×地域）',
  work_release_window_versions: '作品のウィンドウの版', work_release_window_field_values: '作品のウィンドウの追加項目の値', release_window_import_previews: 'ウィンドウのExcel取込（確認中）',
  work_proposal_profiles: '提案資料に出す作品情報（版）',
  broadcast_station_type_versions: '放送局の種別（取引先ごとの版）', broadcast_entry_term_versions: '放送の許諾回数とホールドバック（取引先リストの明細ごとの版）',
  broadcast_proposal_drafts: '放送ウィンドウ提案から作った放送枠の下書き', broadcast_proposal_draft_deletions: '提案の下書きの削除（合意に至らず）',
  partner_list_kinds: '取引先リストの種類', partner_lists: '取引先別の配信・販売リスト', partner_list_entries: '取引先リストの明細（取引先×作品の契約）',
  partner_list_entry_versions: '取引先リストの明細の版', partner_list_field_definitions: '取引先リストの追加の列', partner_list_field_states: '取引先リストの追加の列の状態（版）',
  partner_list_field_values: '取引先リストの追加の列の値', partner_list_import_batches: '取引先リストのExcel取込の記録', partner_list_import_previews: '取引先リストのExcel取込（確認中）',
  sales_sheet_column_versions: '売上集計シートの列の定義（版）', sale_attribute_values: '売上の拡張属性（1売上×1列×版）', sale_currency_versions: '売上の外貨（版）',
  sale_royalty_basis_versions: '売上のロイヤリティ計上の基準（版）', sales_sheet_views: '売上集計シートの保存した形', sales_sheet_view_versions: '売上集計シートの保存した形の版',
});

// labels.mjs の列名辞書に無い、表の構造でよく出る列。
const EXTRA_COLUMN_LABELS = Object.freeze({
  ...MASTER_COLUMN_LABELS,...EXPENSE_COLUMN_LABELS,
  org_id: '組織', user_id: '利用者', requested_by: '依頼者', invoice_id: '請求書', receipt_id: '入金', contract_id: '契約',
  customer_id: '取引先', supplier_id: '仕入先', import_id: '取込', preview_id: '確認中の取込', batch_id: '一括登録',
  snapshot_id: '報告の下書き', member_id: '参加者', window_id: '窓口', phase_id: '日程', slot_id: '放送枠', location_id: 'ロケ地',
  character_id: '役', look_id: '衣装・メイク', change_set_id: '変更セット', recipe_id: '加工手順', draft_id: '下書き',
  source_artifact_id: '原本', proposal_hash: '提案の照合値', base_schema_version: '元の項目定義の版', sample_header: '報告書の見出し',
  meaning_reason: '意味・理由', affected_apps_json: '影響先', unit: '単位', at: '日時', action: '操作', entity_type: '対象の種類',
  entity_id: '対象', detail_json: '詳細', version_hash: '版の照合値', id_hash: '接続の照合値', fiscal_start_month: '期首月',
  confirmed: '確定', calls: '呼出回数',
  // 売上・報告
  year_month: '年月', source_amount_basis: '元の金額の基準', sales_count: '販売数', view_count: '視聴回数', view_seconds: '視聴秒数',
  unit_price_ex_tax: '単価（税抜）', contract_amount_ex_tax: '契約額（税抜）', contract_period_from: '契約期間（開始）', contract_period_to: '契約期間（終了）',
  reported_actual_ex_tax: '報告の実績額（税抜）', reported_recognized_ex_tax: '報告の計上額（税抜）', calculated_actual_ex_tax: '計算した実績額（税抜）',
  transaction_method: '取引方法', sales_type: '販売種別', service_code: 'サービスの区分', service_name: 'サービス名', report_kind: '報告の種類',
  admissions_count: '動員数', gross_box_office_ex_tax: '興行収入（税抜）', ticket_type_code: '券種', purchase_channel: '購入経路',
  turns_count: '回転数', average_rental_price_ex_tax: '平均レンタル単価（税抜）', row_count: '行数', file_name: 'ファイル名',
  // 請求・入金・税
  last_number: '最後の番号', reversed_on: '取消日', allocation_count: '消込件数', claimed_at: '請求に使った日時', allocated_amount_ex_tax: '配賦額（税抜）',
  previous_due_date: '変更前の入金予定日', proposed_due_date: '変更後の入金予定日', decision: '判断', effective_on: '適用日',
  billed_tax: '請求した税額', delta: '差額', prior_invoice_id: '元の請求書', rule_version_id: '税ルールの版', rounding_mode: '端数処理', grouping_mode: '税額のまとめ方',
  precision: '精度', source_tax: '元の税額', source_period_from: '元の期間（開始）', source_period_to: '元の期間（終了）', voucher_id: '伝票',
  // 契約・MG・委員会
  contract_date: '契約日', rationale: '根拠', mg_amount_yen: 'MG額', reported_eligible_yen: '消化対象', applied_recoup_yen: '実充当',
  reported_overage_yen: '超過報告', recognized_yen: '計上', evaluation_yen: '商品評価額', recoup_basis: '回収の基準', overage_enabled: '超過の扱い',
  incoming_contract_id: '受取MGの契約', outgoing_contract_id: '支払MGの契約', special_unverified: '特殊条件（未確認）', reverses_entry_id: '取り消す記帳',
  close_on: '締め日', report_on: '報告日', payment_on: '支払日', close_day: '締めの日', report_day: '報告の日', payment_day: '支払の日',
  interval_months: '間隔（月）', report_offset_months: '報告までの月数', payment_offset_months: '支払までの月数', first_close_on: '最初の締め日', phase_order: '順番',
  window_partner_id: '窓口の取引先', manager_partner_id: '幹事の取引先', window_fee_bps: '窓口手数料率', manager_fee_bps: '幹事手数料率',
  production_cost_yen: '製作費', member_order: '参加者の順番', explicit_share_bps: '持分', contribution_inc_tax_yen: '出資額（税込）',
  settlement_contract_id: '権利契約', committee_snapshot_id: '委員会報告', intake_case_id: '調達案件', document_id: '契約書類', source_case_id: '元の調達案件',
  party_kind: '参加の種類', paid_on: '支払日', amount_inc_tax_yen: '金額（税込）', fee_bps: '手数料率', reported_on: '報告日',
  // ロイヤリティ
  agreement_code: '契約コード', document_reference: '契約書の参照先', calc_method: '計算方法', base_kind: '料率をかける基礎', fixed_amount_yen: '毎月の定額',
  advance_yen: '前払金', min_payment_yen: '支払の下限', clause_reference: '根拠の条項', channel_group: '流通の区分', schedule_version_id: 'サイクルの版',
  statements_from: '報告書を作り始める締め月', starts_month: '開始月', ends_month: '終了月', cycle_kind: 'サイクル', anchor_month: '締め月の基準',
  custom_close_months: '列挙した締め月', first_close_immediate: '初月即締', accrual_month: '計上月', close_month: '締め月', statement_id: '報告書',
  line_no: '行番号', line_kind: '明細の種類', irregular_entry_id: 'イレギュラーの記録', sales_yen: '売上', window_fee_yen: '窓口手数料', expense_yen: '経費',
  committee_income_yen: '本委員会収入', base_yen: '基礎', event_kind: '記録の種類', occurred_on: '実施日', reverses_event_id: '取り消す記録',
  report_due_on: '報告期限', payment_due_on: '支払期限', previous_statement_id: '前の報告書', calculation_version: '計算の版', as_of: '基準日',
  input_hash: '入力の照合値', calculation_json: '計算の内容', royalty_yen: '当期の発生額', adjustment_yen: '調整', advance_recouped_yen: '前払金の充当',
  carried_in_yen: '前期繰越', payable_yen: '支払予定額', carried_out_yen: '翌期繰越', hold_count: '保留の件数', line_count: '明細の行数',
  // 放送・営業
  aired_on: '放送日', broadcast_month: '放送月', station_name: '放送局', customer_partner_id: '取引先（顧客）', agency_partner_id: '取引先（代理店）',
  planned_on: '予定日', planned_runs: '予定回数', run_count: '回数', rate_bps: '料率', availability_version_id: '販売条件の版', pitch: '提案の要点',
  proposal_key: '同じ提案の目印', station_partner_id: '放送局（取引先）', run_kind: '初回／再放送', proposal_from: '提案する期間（開始）', proposal_to: '提案する期間（終了）',
  basis_text: '提案の根拠', memo: 'メモ', deleted_by: '削除した人', deleted_at: '削除した日時',
  // 作品・カタログ
  synopsis_long: 'あらすじ（長）', synopsis_short: 'あらすじ（短）', catch_long: 'キャッチコピー（長）', catch_short: 'キャッチコピー（短）',
  production_year: '製作年', creation_year: '制作年', runtime_seconds: '上映時間（秒）', aspect_ratio: '画面比', rating_authority: '審査機関', rating_code: 'レーティング',
  edition_key: '版のキー', window_key: 'ウィンドウのキー', short_name: '略称',
  // 取引先
  invoice_registration_number: 'インボイス登録番号', postal_code: '郵便番号', address: '住所', phone: '電話番号', contact_name: '担当者名',
  contact_email: '担当者のメール', billing_note: '請求の備考', effective_from: '適用開始', effective_to: '適用終了', roles_json: '取引の区分',
  // 帳票・受領
  issuance_id: '発行記録', voided_by: '取消した人', voided_at: '取消日時', conditions_json: '出力条件', conditions_hash: '出力条件の照合値',
  recipient_type: '宛先の種類', recipient_id: '宛先', recipient_name: '宛先名', headline_yen: '見出しの金額', issued_on: '発行日', issued_by: '発行した人', issued_at: '発行日時',
  previous_issuance_id: '前の発行記録', expected_report_id: '届くはずの報告', frequency: '頻度', due_day: '期限の日', active_from: '有効開始', last_month: '最終月',
  // 制作
  character_key: '役のキー', day_id: '撮影日', call_time: '集合時刻', ready_time: '準備完了時刻', actor_name: '出演者名', location_key: 'ロケ地のキー',
  page_eighths: 'ページ数（1/8単位）', estimated_minutes: '想定分数', look_key: '衣装・メイクのキー', makeup: 'メイク', props: '小道具', shoes: '靴', accessories: '装飾品',
  parking: '駐車場', green_room: '控室', facilities: '設備', floor: '階', contact: '連絡先',
  // 取込・表編集
  dataset: 'データの種類', idempotency_key: '二重登録防止のキー', inserted_count: '追加件数', updated_count: '更新件数', unchanged_count: '変更なし件数',
  approval_count: '承認申請件数', fingerprint: '照合値', sheet_name: 'シート名', header_row: '見出しの行', committed_by: '確定した人', committed_at: '確定日時',
  submitted_by: '申請した人', approved_by: '承認した人', approved_at: '承認日時', applied_by: '反映した人', applied_at: '反映日時', reviewed_by: '確認した人', reviewed_at: '確認日時',
  byte_length: 'ファイルの大きさ', media_type: 'ファイルの種類', extraction_status: '読み取りの状態', sort_order: '並び順', sequence: '順番', position: '位置',
  recorded_at: '記録日時', changed_by: '変更した人', updated_by: '更新した人', observed_on: '観測日', metric: '指標', count: '件数', scope: '範囲', basis: '基準',
  value: '値', detail: '詳細', key: 'キー', mode: '方式', model: '方式', route: '経路', entity: '対象', revision: '改訂番号', token: '接続の識別子（内部）', used_at: '使用日時', consumed: '使用済み',
});

export const COLUMN_TYPE_LABELS = Object.freeze({INTEGER: '整数', TEXT: '文字', REAL: '小数', NUMERIC: '数値', BLOB: 'バイナリ', '': '指定なし'});

export const OTHER_GROUP_ID = '_other';
export const OTHER_GROUP_LABEL = '業務の区分がない表';

export function tableLabel(name) {
  return Object.hasOwn(TABLE_LABELS, name) ? TABLE_LABELS[name] : null;
}

// 画面の主表示に出す表の名前。和名が無いときは「和名未登録」を返し、DB 名は副表示に回す。
export function tableTitle(name) {
  return tableLabel(name) || '和名未登録の表';
}

export function columnDisplayName(key) {
  const known = columnLabel(key);
  if (known) return known;
  if (Object.hasOwn(EXTRA_COLUMN_LABELS, key)) return EXTRA_COLUMN_LABELS[key];
  return null;
}

export function columnTypeLabel(type) {
  const key = String(type ?? '').toUpperCase();
  return Object.hasOwn(COLUMN_TYPE_LABELS, key) ? COLUMN_TYPE_LABELS[key] : `その他（${type}）`;
}

export function columnDescription(table, column) {
  if(Object.hasOwn(EXPENSE_TABLE_LABELS,table)) return EXPENSE_COLUMN_MEANINGS[column] || null;
  return Object.hasOwn(MASTER_TABLE_LABELS, table) ? MASTER_COLUMN_MEANINGS[column] || null : null;
}

export function normalizeQuery(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().trim();
}

// 表名（英字）と和名のどちらでも探せる。空の検索は全件。
export function searchTables(tables, query) {
  const q = normalizeQuery(query);
  const list = Array.isArray(tables) ? tables : [];
  if (!q) return list;
  return list.filter((table) => normalizeQuery(table.name).includes(q) || normalizeQuery(tableLabel(table.name) || '').includes(q));
}

// 表が属する業務のまとまり（design-model の objects）。1つの表が複数に属することがある。
export function conceptsOf(name, objects = []) {
  return objects.filter((object) => object.tables.includes(name)).map((object) => ({id: object.id, label: object.label}));
}

// 業務のまとまりごとに表を並べる。各表は最初に現れたまとまりにだけ置き、どこにも無い表は最後の「その他」へ。
export function groupTablesByConcept(tables, objects = []) {
  const list = Array.isArray(tables) ? tables : [];
  const placed = new Set();
  const groups = [];
  for (const object of objects) {
    const members = list.filter((table) => object.tables.includes(table.name) && !placed.has(table.name));
    members.forEach((table) => placed.add(table.name));
    if (members.length) groups.push({id: object.id, label: object.label, tables: members});
  }
  const rest = list.filter((table) => !placed.has(table.name));
  if (rest.length) groups.push({id: OTHER_GROUP_ID, label: OTHER_GROUP_LABEL, tables: rest});
  return groups;
}

// 制作担当は制作に関わる業務のまとまり（production:true）の表だけを見る（設計キャンバスと同じ範囲）。
export function tablesForRole(tables, role, objects = []) {
  const list = Array.isArray(tables) ? tables : [];
  if (role !== 'production') return list;
  const allowed = new Set(objects.filter((object) => object.production).flatMap((object) => object.tables));
  return list.filter((table) => allowed.has(table.name));
}

// この表が参照する表（外向き）と、この表を参照する表（内向き）。見えている表どうしの参照だけを返す。
export function tableLinks(tables, name) {
  const list = Array.isArray(tables) ? tables : [];
  const names = new Set(list.map((table) => table.name));
  const edges = foreignKeys(list).filter((edge) => names.has(edge.from) && names.has(edge.to));
  return {
    outgoing: edges.filter((edge) => edge.from === name),
    incoming: edges.filter((edge) => edge.to === name && edge.from !== name),
  };
}

// 参照1件の説明文。「作品（work_id → id）」のように、どの列でつながっているかを添える。
export function linkText(edge, direction = 'outgoing') {
  const other = direction === 'outgoing' ? edge.to : edge.from;
  const pairs = edge.columns.map((column) => `${column.from} → ${column.to}`).join('、');
  return {title: tableTitle(other), table: other, pairs, known: Boolean(tableLabel(other))};
}

// 列の一覧表の行。表示用の和名・型・制約（主キー・必須・空欄可）を付ける。
export function columnRows(table) {
  const pkCount = (table?.columns || []).filter((c) => c.pk).length;
  return (table?.columns || []).map((column) => ({
    key: column.name,
    name: column.name,
    label: columnDisplayName(column.name),
    description: columnDescription(table.name, column.name),
    type: columnTypeLabel(column.type),
    constraint: column.pk ? (pkCount > 1 ? '主キー（複合）' : '主キー') : column.notnull ? '必須' : '空欄可',
  }));
}
