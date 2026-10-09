// 業務の言葉の辞書。コード値の日本語名・列の和名・ボタンの動詞をここ1か所で決める。
// 辞書の値は DB の CHECK 制約と現行画面で使われているコード値から拾った（schema.sql ほか *.sql、main.jsx 等）。
// 未知のコードは推測で訳さず「未登録の値（code）」と表示する。

import {UNKNOWN_TEXT} from './format.mjs';

const freezeAll = (object) => Object.freeze(Object.fromEntries(Object.entries(object).map(([key, value]) => [key, Object.freeze(value)])));

export const DOMAINS = freezeAll({
  // 企画・作品
  projectStatus: {planning: '企画中', active: '進行中', complete: '完了', paused: '休止中'},
  workFormat: {film: '映画', series: 'シリーズ'},
  // 商品・流通
  productChannel: {theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', license: 'ライセンス', other: 'その他'},
  channel: {theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', license: 'ライセンス', other: 'その他', publicity: '宣伝'},
  reportKind: {theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', other: 'その他', publicity: '宣伝'},
  reportStatus: {active: '有効', superseded: '訂正版あり', void: '取消済み'},
  committeeWindowKind: {theatrical: '配給', digital: '配信', package: 'ビデオグラム', broadcast: '放送', other: 'その他'},
  digitalModel: {est: 'EST（購入）', tvod: 'TVOD（都度課金）', svod: 'SVOD（定額見放題）', avod: 'AVOD（広告付き無料）', flat: 'FLAT（定額）', mg: 'MG（最低保証）'},
  packageModel: {rental: 'レンタル', sell_through: 'セル', license: 'ライセンス'},
  theatricalModel: {theatrical_rs: '劇場・歩合', theatrical_flat: '劇場・定額', non_theatrical_rs: '非劇場・歩合', non_theatrical_flat: '非劇場・定額'},
  packageMetric: {delivered: '出荷', active: '稼働', inventory: '在庫', returned: '返品'},
  // 取引先・営業
  partnerKind: {cinema: '劇場', platform: '配信事業者', retailer: '販売店', agency: '代理店', vendor: '委託先', other: 'その他'},
  opportunityStage: {lead: '見込', proposal: '提案', negotiation: '交渉', won: '受注', lost: '失注'},
  activityType: {contact: '連絡', proposal: '提案', negotiation: '交渉', note: 'メモ'},
  deliverableStatus: {pending: '未提出', submitted: '提出済み', accepted: '受領済み', blocked: '保留'},
  dealType: {unverified: '未確認', royalty: 'ロイヤリティ', MG: 'MG', FLAT: 'FLAT（定額）', other: 'その他'},
  availabilityStatus: {draft: '条件未確定', confirmed: '条件確認済み', withdrawn: '取り下げ'},
  exclusivity: {exclusive: '独占', nonexclusive: '非独占', unknown: '未確認'},
  stationType: {terrestrial: '地上波', bs: 'BS', cs: 'CS', catv: 'CATV', streaming: '配信', other: 'その他'},
  broadcastStatus: {draft: '下書き', pending_first: '一次承認待ち', tentative: '仮押さえ', pending_final: '最終承認待ち', confirmed: '確定', rejected: '差し戻し', cancelled: '中止'},
  // 請求・入金・税
  invoiceStatus: {future: '請求日前', issued: '未入金', overdue: '期限超過', partially_paid: '一部入金', paid: '入金済み', void: '取消済み'},
  invoiceRecordStatus: {issued: '発行済み', void: '取消済み'},
  taxCategory: {standard: '課税 10%', reduced: '軽減 8%', zero: '免税 0%', exempt: '非課税', non_taxable: '不課税'},
  taxBasis: {exclusive: '税抜起点', inclusive: '税込起点'},
  taxAmountBasis: {ex_tax: '税抜', inc_tax: '税込'},
  roundingMode: {truncate: '切り捨て', half_up: '四捨五入', ceil: '切り上げ'},
  taxGrouping: {invoice: '請求書単位', voucher: '伝票単位'},
  taxScope: {default: '既定', partner: '取引先別'},
  receiptDecision: {approved: '承認', rejected: '却下'},
  // 計上
  recognitionBasis: {sales_month: '販売月', report_received_on: '報告受領日', contract_start_on: '契約開始日', license_start_on: '利用開始日', broadcast_on: '放送日'},
  accountingStatus: {unverified: '未確認', verified: '確認済み', reviewed: '確認済み'},
  periodDateBasis: {sales_period: '販売期間', report_received: '報告受領日'},
  // 権利・精算・委員会・MG
  contractType: {commission: '手数料型', mg: 'MG調達型', self_owned: '自社権利型'},
  intakeType: {committee: '製作委員会', sole_owned: '単独保有', entrusted: '権利受託'},
  partyKind: {current_org: '当社', partner: '取引先'},
  reportBasis: {gross: '控除前', net: '控除後'},
  route: {direct: '直接', via_manager: '幹事経由'},
  feeOrder: {window_first: '窓口手数料を先に控除', manager_first: '幹事手数料を先に控除'},
  feeBasis: {platform_net: 'PF控除後', after_window: '窓口手数料控除後', after_manager: '幹事手数料控除後'},
  referenceType: {release: '公開日', first_sales: '初回売上', first_report: '初回報告', contract_specific: '契約個別'},
  deductionCategory: {royalty: '権利処理費', production_recoup: '製作費回収'},
  jointCostKind: {window_direct: '直接経費', music_window_paid: '音楽使用料', rights_manager: '権利処理費', master_management: '原盤管理費', bank_advance: '立替返済'},
  fundingKind: {cash_contribution: '現金出資', production_payment_credit: '制作費支払の充当'},
  milestoneStage: {schedule_approved: '全体・日々スケジュール承認', shooting_complete: '撮影終了', delivery_accepted: '納品物の検収合格'},
  mgDirection: {incoming: '受取MG（販売先）', outgoing: '支払MG（仕入先）'},
  mgMode: {single: '単品', cross: 'クロスリクープ', special: '特殊条件・要確認'},
  mgLedgerStatus: {unverified: '未確認', reviewed: '確認済み'},
  snapshotStatus: {draft: '下書き', confirmed: '確定', withdrawn: '取り下げ'},
  // ロイヤリティ（監督料・脚本料など。royalty/royalty.sql）
  royaltyCategory: {director: '監督料', screenplay: '脚本料', music: '音楽著作権料', original: '原作料', creator: 'クリエーター報酬', other: 'その他'},
  royaltyCalcMethod: {rate: '料率', fixed_monthly: '毎月定額', manual: '実額入力'},
  royaltyBaseKind: {gross_sales: '売上', after_window_fee: '売上−窓口手数料', after_window_fee_and_expenses: '売上−窓口手数料−経費',
    committee_income: '本委員会収入', committee_income_after_expenses: '本委員会収入−経費'},
  royaltyCycleKind: {monthly: '毎月', quarterly: '四半期', semiannual: '半年', annual: '1年', custom: '特殊（締め月を列挙）', manual: '別途協議', none: 'ロイヤリティ計上無し'},
  royaltyChannel: {theatrical: '劇場', rental: 'ビデオグラム（レンタル）', sell: 'ビデオグラム（セル）', digital: '配信', broadcast: '放送', overseas: '海外', other: 'その他'},
  royaltyIrregularKind: {adjust_amount: '金額の調整', move_period: '締め月の変更', hold: '保留にする', release: '保留を解く', note: '記録だけ'},
  royaltyEventKind: {reported: '報告', paid: '支払'},
  royaltyLineKind: {accrual: '当期の計上', revision: '報告後の修正・遅れて締めた分', adjustment: '調整（イレギュラー）', advance_recoup: '前払金の充当'},
  royaltyPeriodStatus: {open: '受付中', pending: '作成待ち', overdue: '期限超過', created: '作成済', reported: '報告済', paid: '支払済', merged: '後の報告書に含める'},
  // 制作
  sceneStatus: {draft: '下書き', ready: '撮影準備済み', shot: '撮影済み'},
  dayNight: {D: '昼', N: '夜', DN: '薄暮'},
  sceneOutcome: {planned: '予定', partial: '一部撮影', shot: '撮影済み', not_shot: '未撮影'},
  daySlotKind: {move: '移動', meal: '食事', wrap: '撤収', prep: '準備', other: 'その他'},
  prepTaskStatus: {pending: '未準備', ready: '準備済み', blocked: '保留'},
  creditRole: {director: '監督', writer: '脚本', cast: '出演者', staff: 'スタッフ'},
  editionTagKind: {country: '国', language: '言語', music_society: '音楽著作権団体'},
  // 宣伝・指標
  granularity: {day: '日', week: '週', month: '月', event: '露出単位', unknown: '未確認'},
  verification: {verified: '確認済み', unverified: '未確認'},
  paidOrganic: {unknown: '未確認', paid: '広告', organic: '自然', mixed: '混在'},
  metricAggregation: {sum: '合計', average: '平均', latest: '最新', none: '集計しない'},
  valueType: {integer: '整数', decimal: '小数', text: '文字', boolean: 'はい・いいえ'},
  // 取込・承認・ワークフロー
  changeSetStatus: {draft: '下書き', submitted: '承認申請中', approved: '承認済み', rejected: '差し戻し', applied: '反映済み'},
  proposalStatus: {pending: '確認待ち', adopted: '採用', rejected: '不採用'},
  proposalSource: {'offline-rule': '規則', 'ai-json': 'AI（JSON取込）', 'workers-ai': 'AI', service: '外部サービス'},
  suggestionSource: {'rule-based': '規則', 'imported-ai': 'AI（取込）', 'configured-ai': 'AI'},
  rawArtifactKind: {script: '台本', sales_report: '売上報告'},
  extractionStatus: {extracted: '抽出済み', ocr_pending: '文字認識待ち'},
  sourceStorage: {inline: 'この原本の中身を保存', legacy_artifact: '旧方式の原本を参照'},
  sourceBindingMode: {single_work: '1つの作品', by_product: '商品コードの列で分ける', by_work_column: '作品コードの列で分ける'},
  controlMetric: {row_count: '行数', amount_ex_tax: '税抜額', tax_amount: '税額', amount_inc_tax: '税込額'},
  controlScope: {report: '報告単位', channel: '流通単位'},
  checkStatus: {pass: '一致', fail: '不一致', unverified: '未確認', blocked: '停止'},
  importDiff: {append: '追加', revise: '改訂', unchanged: '変更なし'},
  // 権限・招待
  role: {admin: '管理者', editor: '編集担当', production: '制作担当'},
  projectPermission: {edit: '編集', production: '制作'},
  invitationStatus: {pending: '招待中', accepted: '参加済み', revoked: '取消済み', expired: '期限切れ'},
});

// 画面（リソース）ごとの列→辞書。同じ列名でも表によって意味が違うものはここで分ける。
export const RESOURCE_DOMAINS = freezeAll({
  projects: {status: 'projectStatus'},
  works: {format: 'workFormat'},
  products: {channel: 'productChannel'},
  partners: {kind: 'partnerKind'},
  opportunities: {stage: 'opportunityStage'},
  scenes: {status: 'sceneStatus', day_night: 'dayNight'},
  reports: {kind: 'reportKind', status: 'reportStatus'},
  observations: {granularity: 'granularity', verification: 'verification', paid_organic: 'paidOrganic'},
  memberships: {role: 'role'},
  invitations: {role: 'role', status: 'invitationStatus'},
  activities: {activity_type: 'activityType'},
  deliverables: {status: 'deliverableStatus'},
  prepTasks: {status: 'prepTaskStatus'},
  invoices: {status: 'invoiceStatus'},
  broadcastSlots: {status: 'broadcastStatus'},
  availability: {status: 'availabilityStatus', exclusivity: 'exclusivity'},
});

// 表を問わず意味が1つに決まる列→辞書。
export const KEY_DOMAINS = Object.freeze({
  day_night: 'dayNight', paid_organic: 'paidOrganic', granularity: 'granularity', exclusivity: 'exclusivity',
  activity_type: 'activityType', contract_type: 'contractType', intake_type: 'intakeType', party_kind: 'partyKind',
  report_basis: 'reportBasis', period_date_basis: 'periodDateBasis', settlement_method: 'dealType', deal_type: 'dealType',
  accounting_status: 'accountingStatus', recognition_basis_code: 'recognitionBasis', tax_basis: 'taxAmountBasis',
  rounding_mode: 'roundingMode', grouping_mode: 'taxGrouping', direction: 'mgDirection', digital_model: 'digitalModel',
  package_model: 'packageModel', theatrical_model: 'theatricalModel', verification: 'verification', permission: 'projectPermission',
});

export function labelOf(domain, code) {
  if (code === null || code === undefined || code === '') return UNKNOWN_TEXT;
  const dictionary = DOMAINS[domain];
  const key = String(code);
  if (dictionary && Object.hasOwn(dictionary, key)) return dictionary[key];
  return `未登録の値（${key}）`;
}

export function isKnownCode(domain, code) {
  return code !== null && code !== undefined && Object.hasOwn(DOMAINS[domain] || {}, String(code));
}

export function optionsOf(domain) {
  return Object.entries(DOMAINS[domain] || {}).map(([value, label]) => ({value, label}));
}

// 列の和名。main.jsx の LABELS を移し、画面に出る列を補った。未知の列は null（呼び出し側は既定で隠す）。
export const COLUMN_LABELS = Object.freeze({
  id: 'ID', code: 'コード', title: '名称', status: '状態', version: '版', project_id: '案件', work_id: '作品', product_id: '商品',
  partner_id: '取引先', campaign_id: '施策', exposure_id: '露出', metric_definition_id: '指標', scene_no: 'シーン', day_night: '昼夜',
  location: '場所', synopsis: '内容', format: '形式', budget_yen: '予算', forecast_yen: '売上見込', sku: 'SKU', name: '名称',
  channel: '流通', kind: '区分', region: '地域', stage: '段階', expected_yen: '見込', close_date: '予定日', incurred_on: '発生日',
  accounting_month: '実計上月', category: '費目', description: '内容', actual_ex_tax: '実績税抜', tax_amount: '税額',
  actual_inc_tax: '実績税込', starts_on: '開始日', ends_on: '終了日', objective: '目的', audience_hypothesis: '対象仮説',
  target_region: '対象地域', target_channel: '対象流通', medium: '媒体', asset_version: '素材版', scheduled_at: '予定日時',
  happened_at: '実施日時', source_url: '出典', period_from: '期間開始', period_to: '期間終了', granularity: '粒度',
  value_number: '数値', value_text: '文字値', verification: '確認状態', acquired_at: '取得日時', paid_organic: '広告区分',
  source: '出典', report_key: '報告キー', content_hash: '原文ハッシュ', raw_text: '原文', amount_ex_tax: '税抜',
  amount_inc_tax: '税込', quantity: '数量', sales_period_from: '販売期間開始', sales_period_to: '販売期間終了',
  created_by: '登録者', supersedes_id: '訂正元', allocation_bps: '配賦率', sale_id: '売上明細', allocated_work_id: '配賦先作品',
  recognition_basis_id: '計上基準ID', recognition_basis_code: '計上基準コード', recognition_basis_name: '計上基準',
  sales_month: '販売月', report_received_on: '報告受領日', contract_start_on: '契約開始日', license_start_on: '利用開始日',
  broadcast_on: '放送日', basis_reason: '計上根拠', accounting_status: '会計確認状態', resolved_month: '基準から算出した月',
  // 補った列
  report_id: '売上報告', source_row: '原本の行', partner_name: '取引先名', work_title: '作品名', product_name: '商品名',
  project_title: '案件名', email: 'メール', display_name: '表示名', role: '役割', active: '有効', expires_at: '期限',
  permission: '権限', invoice_number: '請求番号', invoice_date: '請求日', due_date: '支払期日', received_on: '入金日',
  amount_yen: '金額', reference: '参照番号', note: '備考', notes: '備考', reason: '理由', voided_on: '取消日',
  contract_code: '契約コード', contract_type: '契約種別', holder_partner_id: '権利元', mg_contract_yen: 'MG契約額',
  mg_paid_yen: 'MG支払済額', case_code: '案件コード', intake_type: '権利の受け方', territory: '地域', exclusivity: '独占',
  rights_start: '権利開始日', rights_end: '権利終了日', investment_yen: '出資額', share_bps: '持分', opportunity_id: '営業案件',
  occurred_on: '実施日', activity_type: '活動', summary: '要約', next_action: '次の行動', next_due_on: '次の期限',
  agreement_id: '契約', term_version_id: '条件版', version_no: '版', version_label: '版の名称', license_start: '利用開始日',
  license_end: '利用終了日', expected_amount_yen: '見込額', due_on: '期限', submitted_on: '提出日', accepted_on: '受領日',
  shoot_date: '撮影日', unit: '班', label: '名称', owner_label: '担当', shooting_day_id: '撮影日', scene_id: 'シーン',
  planned_start: '予定開始', planned_end: '予定終了', actual_start: '実開始', actual_end: '実終了', outcome: '撮影結果',
  sequence_order: '順番', field_key: '項目キー', value_type: '値の型', aggregation: '集計方法', request_text: '依頼内容',
  decided_at: '判断日時', decided_by: '判断者', created_at: '登録日時', updated_at: '更新日時', release_on: '発売・配信開始日',
  sales_end_on: '販売終了日', terms_text: '条件', source_reference: '根拠', distribution_code: '流通コード',
  distribution_name: '流通', settlement_method: '取引方法', deal_type: '取引方法', direction: 'MGの向き',
  platform_rate_bps: 'PF料率', agency_fee_bps: '手数料率', overage_rate_bps: '超過料率', report_basis: '報告の基準',
  period_date_basis: '期間の基準', received_month: '受領月', report_received_month: '報告受領月',
});

export function columnLabel(key) {
  return Object.hasOwn(COLUMN_LABELS, key) ? COLUMN_LABELS[key] : null;
}

// 既定で隠す列（識別・監査用。画面の主表示に出さない）。
export const DEFAULT_HIDDEN_COLUMNS = Object.freeze(['org_id', 'created_at', 'updated_at', 'created_by', 'version', 'content_hash', 'raw_text']);

const WRAP_COLUMNS = new Set(['synopsis', 'description', 'note', 'notes', 'summary', 'terms_text', 'raw_text', 'basis_reason', 'objective',
  'audience_hypothesis', 'request_text', 'next_action', 'reason', 'source_reference', 'pitch']);
const CODE_COLUMNS = new Set(['code', 'sku', 'report_key', 'contract_code', 'case_code', 'invoice_number', 'distribution_code', 'reference', 'field_key']);

// 列名から ColumnSpec の既定を推し量る（汎用一覧の DataTable 置換用）。resource を渡すと表ごとの辞書を使う。
export function columnSpecFor(key, {resource, domains = {}} = {}) {
  // 行の鍵がすでに表示用の日本語（例: 「売上明細」「指標」）なら、そのまま見出しにして表示する
  const displayKey = /[^\x00-\x7f]/.test(key);
  const label = displayKey ? key : columnLabel(key);
  const domain = domains[key] || RESOURCE_DOMAINS[resource]?.[key] || KEY_DOMAINS[key];
  const spec = {key, label: label ?? key};
  if (label === null || DEFAULT_HIDDEN_COLUMNS.includes(key)) spec.hidden = true;
  if (displayKey) return {...spec, type: 'text'};
  if (domain) return {...spec, type: 'status', domain};
  if (key === 'id' || /_id$/.test(key)) return {...spec, type: 'id', hidden: true};
  if (/_bps$/.test(key)) return {...spec, type: 'rate', digits: 2, value: (row) => (row[key] == null ? null : Number(row[key]) / 10000), total: 'none'};
  if (/(_yen|^amount_(ex|inc)_tax|^tax_amount|^actual_(ex|inc)_tax)$/.test(key)) return {...spec, type: 'yen', total: 'sum'};
  if (key === 'quantity' || /_count$/.test(key)) return {...spec, type: 'int', total: 'sum'};
  if (key === 'version' || key === 'version_no' || key === 'source_row' || key === 'sequence_order') return {...spec, type: 'int', total: 'none'};
  if (/_month$/.test(key)) return {...spec, type: 'month'};
  if (/(_at)$/.test(key)) return {...spec, type: 'datetime'};
  if (/(_on|_date|^period_(from|to)|^sales_period_(from|to)|_start$|_end$)$/.test(key) && !/^(planned|actual)_/.test(key)) return {...spec, type: 'date'};
  if (CODE_COLUMNS.has(key)) return {...spec, type: 'code'};
  if (WRAP_COLUMNS.has(key)) return {...spec, type: 'text', wrap: true};
  return {...spec, type: 'text'};
}

// ボタン・操作の語彙。画面ごとに「編集／改訂／修正」などが揺れないよう、ここから選ぶ。
export const VERBS = Object.freeze({
  save: '保存',
  register: '登録',
  add: '追加',
  edit: '修正',
  newVersion: '新しい版を作る',
  void: '取り消す',
  close: '閉じる',
  approve: '承認',
  sendBack: '差し戻す',
  submit: '承認を申請',
  apply: '反映',
  export: '出力',
  import: '取り込む',
  preview: '内容を確認',
  commit: '登録を確定',
  reload: '再読込',
  retry: '再試行',
  search: '検索',
  clearFilters: '絞込を解除',
  discardAndLeave: '破棄して移動',
  stay: 'この画面に戻る',
  download: 'ダウンロード',
  open: '開く',
  select: '選択',
  undo: '元に戻す',
  excel: 'Excel',
  csv: 'CSV',
  print: '印刷・PDF',
  printHtml: '印刷用HTML',
});
