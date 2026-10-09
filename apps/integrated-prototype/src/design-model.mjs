import {MASTER_TABLE_LABELS,MASTER_TABLE_MEANINGS} from './master-extensions/master-definitions.mjs';
import {EXPENSE_TABLE_LABELS,EXPENSE_TABLE_MEANINGS} from './expense-sheet/expense-definitions.mjs';
export const objects = [
 {id:'expense_accounting',label:'経費・請求書・会計の確認',meaning:Object.values(EXPENSE_TABLE_MEANINGS).join(' '),tables:Object.keys(EXPENSE_TABLE_LABELS),screens:['経費集計シート','PL・BS']},
 {id:'master_extensions',label:'作品・商品マスタの契約・費用・仕様',meaning:Object.values(MASTER_TABLE_MEANINGS).join(' '),tables:Object.keys(MASTER_TABLE_LABELS),screens:['作品・商品マスタ']},
 {id:'workbench',label:'表編集・加工・承認',meaning:'共通DBの表を下書きで直接編集し、保存した加工手順を段階ごとに確認します。原本・手順版・差分・承認対象版を固定し、競合と権限を再検証してまとめて反映します。確定済み計算の直接上書きは行いません。',tables:['workbench_source_artifacts','workbench_snapshots','workbench_drafts','workbench_recipes','workbench_recipe_versions','workbench_validations','workbench_change_sets','workbench_applications','workbench_lineage','workbench_analysis_snapshots'],screens:['業務データ編集','売上データ編集']},
 {id:'rights_reporting',label:'権利先収支・MG現況の帳票',meaning:'保存済みの委員会下書きを当時の条件版のまま前回まで・当期・累計で参照します。MGは作品・商品別の実績と契約全体の残高を分離し、現在有効な訂正を集計。帳票生成は精算への充当・承認・送金を行いません。',tables:['committee_contracts','committee_term_versions','committee_term_members','committee_term_windows','committee_schedule_phases','committee_report_snapshots','committee_snapshot_reports','committee_snapshot_expenses','committee_snapshot_lines','committee_snapshot_member_amounts','mg_incoming_contracts','mg_outgoing_contracts','mg_term_versions','mg_version_products','mg_ledger_entries','product_works','works'],screens:['権利先・MG帳票']},
 {id:'mg',label:'受取MG・支払MG',meaning:'顧客と仕入先は独立IDで管理。受取・支払契約を分け、条件版に商品評価と締め・報告予定・支払予定を結びます。分配金は当期の消化対象で、権利元への分配とは別。両方向は明示した関連だけを持ち、回収条件をコピーしません。',tables:['mg_suppliers','mg_incoming_contracts','mg_outgoing_contracts','mg_term_versions','mg_version_products','mg_version_phases','mg_contract_links','mg_ledger_entries'],screens:['MG契約・台帳']},
 {id:'tax',label:'税ルール・計算履歴',meaning:'売上の事実と税の計算方法を分離します。取引先・標準ルールの版、元伝票の参考計算、請求税率別の確定計算を記録し、月次台帳で根拠と差額を追跡します。確定後の改訂は旧計算を変更しません。',tables:['tax_rule_versions','tax_calculation_snapshots','tax_calculation_lines','tax_invoice_rate_totals','tax_invoice_links'],screens:['税ルール・台帳','請求・入金']},
 {id:'work',label:'企画・作品',meaning:'企画に属する作品を、制作・営業・収支が共通のIDで参照します。商品との対応は配賦表で管理します。',production:true,tables:['works','projects','products','product_works','catalog_profiles','catalog_credits','catalog_editions','catalog_edition_tags','catalog_product_editions'],screens:['作品・商品マスタ','企画・作品']},
 {id:'production',label:'台本・撮影現場',meaning:'台本の原本と確認履歴からシーン・撮影日へつなぎ、現場の準備と進行を管理します。',production:true,tables:['scenes','workflow_raw_artifacts','workflow_script_reviews','workflow_schedule_previews','workflow_script_commits','workflow_script_commit_scenes','workflow_script_commit_days','shooting_days','day_scene_assignments','prep_tasks','production_revisions','production_characters','production_locations','production_location_plans','production_scene_details','production_appearances','production_looks','production_scene_looks','production_day_slots','production_calls'],screens:['台本・香盤','制作']},
 {id:'rights_sales',label:'調達・権利・営業',meaning:'契約の対象範囲と販売条件を作品・商品に結び、営業先への提案資料を作成します。',tables:['catalog_product_windows','sales_availability_versions','rights_intake_cases','rights_intake_documents','rights_intake_scopes','sales_agreements','sales_agreement_term_versions','sales_material_snapshots','sales_opportunities','broadcast_slots','broadcast_slot_versions','broadcast_airings','broadcast_sale_links','rights_intake_participants','intake_settlement_links','sales_activities','sales_deliverables','sales_report_links','broadcast_availability_rates','broadcast_availability_previews','broadcast_import_previews','broadcast_station_type_versions','broadcast_entry_term_versions','broadcast_proposal_drafts','broadcast_proposal_draft_deletions'],screens:['番販・放送','営業作品一覧','調達・権利','商品・営業','営業資料']},
 {id:'release_windows',label:'全作品のウィンドウ（営業基幹）',meaning:'作品ごとの劇場公開・パッケージ・配信（先行・通常）・放送・海外の日付を、作品×種別×地域の系列に版で積みます。種別は行で持ち、1行足すと画面の列と Excel の見出しが増えます。日付はこの表だけが持ち、流通別の販売条件へは写さず、対応する流通IDで期間外を警告します。月まで・年まで・時期の原文を持ち、仮の日付は作りません。',tables:['release_window_types','release_window_type_versions','release_window_type_fields','release_window_type_distributions','work_release_windows','work_release_window_versions','work_release_window_field_values','release_window_import_previews'],screens:['全作品のウィンドウ','番販・放送']},
 {id:'release_proposals',label:'提案資料（営業基幹）',meaning:'PVOD・TVOD・TVOD先行・EST先行・EST の基準のウィンドウが対象月に解禁する作品を、全作品のウィンドウの最新の版と作品カタログ・提案用の作品情報・権利範囲からそのつど組み立て、中立の列の形で Excel・CSV に出します。SVOD は提案先×提案期間で継続・新規・注意に分け、月額単価×月数の提案金額を計算します。提案資料そのものは保存せず、提案用の作品情報（フリガナ・英題・ジャンル・コピーライト・注意事項・イントロダクション・作品情報URL・画像の参照）だけを作品ごとの版で持ちます。',tables:['work_proposal_profiles'],screens:['提案資料','作品・商品マスタ']},
 {id:'partner_lists',label:'取引先別の配信・販売リスト（営業基幹）',meaning:'取引先ごとのリスト（配信リスト・販売リスト）に、作品×流通ID×地域の契約期間を明細として版で積みます。状態は基準日から計算し、再契約は新しい明細で前の明細を指します。追加の列は定義と状態の版で増やし、全取引先で同じ4シートのExcelテンプレートで取り込みます。独占どうしの重なり・再契約の空白・終了間近・当社は売れるのに契約中の取引先が無い流通・期間外の売上は、止めずに確認として出します。',tables:['partner_list_kinds','partner_lists','partner_list_entries','partner_list_entry_versions','partner_list_field_definitions','partner_list_field_states','partner_list_field_values','partner_list_import_batches','partner_list_import_previews'],screens:['取引先別リスト','取引先']},
 {id:'sales_sheet',label:'売上集計シート（83列）',meaning:'売上明細1件を1行に、定型業務の83列と同じ意味の列を中立の見出しで並べます。列は組織ごとの列カタログ（版）で持ち、値は登録済みの表から許可リストのキーで結合・導出するか、置き場所の無い列は拡張属性（1売上×1列×版）と型で守る2表（外貨・ロイヤリティ計上の基準）に積みます。SQL の文字列は保存せず、計算列は四則演算と丸めの式だけ。集計は金額・件数を合計、在庫・残高を期末の値、単価・料率・回転率を分子と分母から再計算し、列セット7つ・保存した形・Excel と83列の CSV で出します。',tables:['sales_sheet_column_versions','sale_attribute_values','sale_currency_versions','sale_royalty_basis_versions','sales_sheet_views','sales_sheet_view_versions'],screens:['売上集計シート','帳票センター','売上']},
 {id:'distribution',label:'流通区分マスタ',meaning:'支給された流通ID・名称・取引方法・販売種別で販売を分類します。金額・符号の集計規則とは別に管理します。',tables:['distribution_master','distribution_types'],screens:['帳票センター','営業作品一覧']},
 {id:'report',label:'売上報告の取り込み',meaning:'受領原本を保存し、マッピングと人の確認を経て売上明細へ登録します。原本の明示集計値とビデオグラムの非売上観測値は売上額と分け、報告確定時に明細を封印します。販売月・受領月・計上基準を区別します。',tables:['report_imports','report_source_controls','report_channel_fact_seals','package_report_observations','package_observation_products','workflow_raw_artifacts','workflow_report_selections','workflow_report_commits','sales_source_files','sales_source_selections','sales_source_bindings','sales_source_partitions','sales_source_commits','report_mapping_profiles','report_mapping_versions','mapping_import_provenance','report_recognition','recognition_bases'],screens:['原本取り込み','報告書マッピング','売上データ編集','売上']},
 {id:'sales',label:'売上・帳票',meaning:'商品・作品・取引先・流通・計上月を関連付け、同じ売上明細から各管理表を集計します。配給・ビデオグラム・配信の詳細は明細IDに従属し、別売上として合算しません。',tables:['sale_lines','theatrical_sale_details','package_sale_details','digital_sale_details','sale_distribution_versions','report_imports','report_recognition','recognition_bases','partners','partner_profile_versions','product_works','works','distribution_master','distribution_types','report_sale_dimensions_versions'],screens:['帳票センター','売上','取引先']},
 {id:'billing',label:'請求・入金',meaning:'報告済みの売上を請求明細に結び、入金と消込、入金予定月の変更申請・承認を履歴で保持します。',tables:['billing_invoices','billing_invoice_lines','billing_invoice_line_works','billing_receipts','billing_receipt_allocations','billing_receipt_reversals','receipt_plan_requests','receipt_plan_decisions','billing_invoice_voids','billing_sale_claims','billing_invoice_sequences'],screens:['月別消込','請求・入金']},
 {id:'income',label:'収支・権利分配',meaning:'売上と経費から収支を確認し、契約の版に基づいてMG回収・手数料・製作委員会の分配を計算します。',tables:['expenses','sale_lines','settlement_contracts','settlement_term_versions','settlement_report_links','committee_contracts','committee_term_versions','committee_report_snapshots','committee_term_members','committee_term_windows','committee_term_investments','committee_term_funding','committee_schedule_phases','committee_report_previews','committee_snapshot_deductions','joint_committee_contracts','joint_committee_members','joint_committee_windows','joint_committee_periods','joint_committee_sales','joint_committee_costs','joint_committee_snapshots','joint_funding_events','joint_production_milestones','joint_business_holidays','rights_payment_events'],screens:['収支','経費','権利・分配','製作委員会']},
 {id:'report_center',label:'帳票の発行・受領の進み',meaning:'帳票センターで出した帳票の発行記録と取消、届くはずの報告（取引先×流通×頻度）と受領の照合、会計年度の設定を持ちます。帳票の数字は売上明細から毎回集計し、発行記録は出したときの条件と照合値を残します。',tables:['report_issuances','report_issuance_voids','expected_reports','expected_report_closures','fiscal_settings'],screens:['帳票センター']},
 {id:'pl_bs',label:'PL・BS（管理会計の試算）',meaning:'作品別と会社のPL・BSを、売上明細・経費・ロイヤリティの発生額・製作委員会の月次収支（自社の取り分だけ）から毎回計算します。システムに無い全社費用・営業外・特別・法人税等・期首残高・借入金・資本金は勘定科目×月の手入力で補い、経費の出金日と委員会への出資の払込日で現預金と未払を出します。複式の仕訳は持たず、最後に説明のつかない差額を必ず出します。決算書ではありません。',tables:['org_profile_versions','gl_accounts','gl_manual_amounts','expense_payments','committee_investment_payments','fiscal_settings','expenses','committee_term_investments'],screens:['PL・BS','経費']},
 {id:'royalty',label:'ロイヤリティ（監督料・脚本料・音楽・原作料）',meaning:'作品×権利者×種別の契約に、条件（料率・基礎・対象流通・前払金・下限）とサイクル（締め方・報告と支払の期限）を版で持ちます。売上は計上月で発生させ、締め月ごとに権利者の報告書（確定版）へまとめます。報告後の修正は差額で次の報告書へ入れ、イレギュラー・実額・報告と支払は取消の行で直します。',tables:['royalty_agreements','royalty_term_versions','royalty_term_channels','royalty_term_expense_categories','royalty_schedule_versions','royalty_schedule_phases','royalty_manual_accruals','royalty_irregular_entries','royalty_statements','royalty_statement_voids','royalty_statement_lines','royalty_statement_events','royalty_statement_calculation_parts'],screens:['ロイヤリティ作成','ロイヤリティ集計','ロイヤリティ報告書','ロイヤリティ契約']},
 {id:'bulk',label:'Excel一括登録',meaning:'取引先・案件・作品・商品・経費をExcelでまとめて登録します。新しい行は確かめてから追加し、既存の作品・商品・取引先の変更は表編集の変更セット（承認申請）として起票します。同じ行の二重登録は照合値で止めます。',tables:['bulk_import_batches','bulk_import_previews'],screens:['作品・商品マスタ','取引先','企画・作品','経費']},
 {id:'publicity',label:'宣伝・追加項目',meaning:'作品ごとの宣伝施策・露出と、指標の観測値を記録します。記録したい指標は日本語の提案から型・単位・集計方法を決め、管理者が採用すると宣伝の入力・取込・分析で使えるようになります。観測は売上との因果を確定しません。',tables:['campaigns','exposures','observations','metric_definitions','change_proposals','schema_meta'],screens:['宣伝','拡張項目']},
 {id:'team',label:'チーム・権限',meaning:'利用者の組織への所属と、案件ごとの閲覧・編集の権限、招待を持ちます。制作担当は金額を見ず、編集担当は権限のある案件だけを扱います。試作の招待は架空のメールだけで、外部へ送りません。',tables:['users','memberships','project_memberships','invitations'],screens:['チーム']},
];
export const relations=[
 {from:'work',to:'workbench',label:'権限内のマスタを表で修正'},
 {from:'workbench',to:'report',label:'保存手順で加工して承認取込'},
 {from:'workbench',to:'sales',label:'検証済みの変更セットを反映'},
 {from:'income',to:'rights_reporting',label:'当時の条件版と保存済み下書きから集計'},
 {from:'mg',to:'rights_reporting',label:'有効な当期報告と商品評価を参照'},
 {from:'work',to:'rights_reporting',label:'商品から作品への配賦を参照'},
 {from:'rights_sales',to:'mg',label:'商品と契約条件を登録'},
 {from:'mg',to:'income',label:'計上・分配条件の確認対象（自動転記は未接続）'},
 {from:'sales',to:'tax',label:'元売上を計算対象として参照'},
 {from:'tax',to:'billing',label:'ルール版と税率別計算を固定保存'},
 {from:'work',to:'production',label:'作品の制作を進める'},
 {from:'work',to:'rights_sales',label:'権利・販売条件を定める'},
 {from:'distribution',to:'rights_sales',label:'流通別の販売条件'},
 {from:'sales',to:'sales_sheet',label:'売上明細1件＝1行（83列）'},
 {from:'distribution',to:'sales_sheet',label:'流通IDで当社売上の列（定額・MG・RS・RSS・視聴連動）を分ける'},
 {from:'billing',to:'sales_sheet',label:'請求番号・請求日・入金期日・入金日'},
 {from:'report',to:'sales_sheet',label:'取込で拡張属性（attr_…）に値を入れる・監査の列'},
 {from:'work',to:'release_windows',label:'作品ごとのウィンドウ（1行1作品）'},
 {from:'distribution',to:'release_windows',label:'種別と流通IDの対応'},
 {from:'rights_sales',to:'release_windows',label:'販売条件・権利期間・放送枠の期間外を警告'},
 {from:'work',to:'partner_lists',label:'取引先×作品の契約期間（明細）'},
 {from:'distribution',to:'partner_lists',label:'流通IDで販売種別・取引方法を引く'},
 {from:'rights_sales',to:'partner_lists',label:'当社の販売条件と照合（契約中の取引先が無い流通）'},
 {from:'sales',to:'partner_lists',label:'売上の取引先・作品配賦・流通・販売期間で期間外を照合'},
 {from:'rights_sales',to:'report',label:'販売後の報告を受領'},
 {from:'report',to:'sales',label:'確認済み明細を集計'},
 {from:'distribution',to:'sales',label:'流通IDで分類'},
 {from:'sales',to:'billing',label:'売上から請求・消込'},
 {from:'sales',to:'income',label:'収支・分配の計算元'},
 {from:'work',to:'income',label:'作品別の収支'},
 {from:'sales',to:'report_center',label:'同じ明細から帳票を出し、発行を記録'},
 {from:'report',to:'report_center',label:'届くはずの報告と受領を照合'},
 {from:'bulk',to:'work',label:'新しい行を確かめて追加'},
 {from:'bulk',to:'workbench',label:'既存行の変更を承認申請として起票'},
 {from:'work',to:'publicity',label:'作品ごとの施策・露出・指標'},
 {from:'team',to:'work',label:'案件ごとの閲覧・編集の権限'},
];
// 画面ごとのコード。先頭が画面の本体、続きがその画面で使う部品・取込の道具（設計キャンバスの「この画面のコード」に出す）。
const SCREEN_FILES={
 'ホーム':['HomeQueue.jsx'],
 '作品・商品マスタ':['WorkCatalog.jsx','bulk/BulkImportPanel.jsx','work/ProposalProfileForm.jsx','master-extensions/WorkMasterFields.jsx','master-extensions/ProductMasterFields.jsx','master-extensions/MasterVersionForm.jsx'],
 '取引先':['partners/PartnersPage.jsx','main.jsx'],
 '企画・作品':['main.jsx','bulk/BulkImportPanel.jsx'],
 '商品・営業':['sales-ops/PipelineBoard.jsx','main.jsx'],
 '番販・放送':['BroadcastWorkspace.jsx','broadcast/BroadcastHistory.jsx','broadcast/AvailsListPanel.jsx','broadcast/WindowProposals.jsx','broadcast/BroadcastTerms.jsx','broadcast/BroadcastApprovals.jsx','broadcast/BroadcastExcel.jsx','sales-ops/ReleaseWindowGrid.jsx','broadcast/broadcast-history-model.mjs','broadcast/window-proposal-model.mjs','broadcast/avails-list-model.mjs','broadcast/broadcast-windows-routes.mjs'],
 '全作品のウィンドウ':['sales-ops/ReleaseWindowsPage.jsx','sales-ops/ReleaseWindowGrid.jsx','sales-ops/release-window-model.mjs','sales-ops/release-window-routes.mjs'],
 '提案資料':['sales-ops/ProposalsPage.jsx','sales-ops/release-proposal-model.mjs','sales-ops/release-proposal-routes.mjs','work/ProposalProfileForm.jsx'],
 '取引先別リスト':['sales-ops/PartnerListsPage.jsx','sales-ops/partner-list-model.mjs','sales-ops/partner-list-routes.mjs'],
 '営業作品一覧':['ReportCenter.jsx','sales/ReleaseMonthView.jsx'],
 '営業資料':['SalesMaterials.jsx'],
 '制作':['ProductionWorkspace.jsx','FieldOperations.jsx'],
 '台本・香盤':['Workflow.jsx'],
 '調達・権利':['RightsIntake.jsx'],
 '宣伝':['main.jsx'],
 '業務データ編集':['Workbench.jsx'],
 '売上':['sales/SalesPage.jsx','main.jsx','sales-sheet/SalesSheet.jsx'],
 '原本取り込み':['import/SalesImportWizard.jsx'],
 '売上データ編集':['Workbench.jsx'],
 '報告書マッピング':['ReportMapping.jsx'],
 '請求・入金':['Billing.jsx','billing/ReceiptForm.jsx'],
 '月別消込':['ReportCenter.jsx','billing/ReceiptForm.jsx'],
 '税ルール・台帳':['TaxLedger.jsx'],
 '経費集計シート':['expense-sheet/ExpenseSheet.jsx','expense-sheet/sheet-model.mjs','expense-sheet/sheet-routes.mjs'],
 '売上集計シート':['sales-sheet/SalesSheet.jsx','sales-sheet/sheet-view-model.mjs','sales-sheet/sales-sheet-routes.mjs'],
 '帳票センター':['reports/ReportCatalog.jsx','reports/AnnualDashboard.jsx','reports/WorkPnlReport.jsx','reports/IssuePanel.jsx','reports/ProgressMatrix.jsx','sales-sheet/SalesSheet.jsx'],
 '収支':['IncomeDashboard.jsx','main.jsx'],
 'PL・BS':['pl-bs/PlBsPage.jsx','pl-bs/PlBsManual.jsx','pl-bs/ExpensePayments.jsx','pl-bs/pl-bs-view.mjs','reports/pl-bs-model.mjs','pl-bs/pl-bs-routes.mjs','pl-bs/pl-bs-data.mjs'],
 '分析・Lightdash':['AnalyticsWorkspace.jsx'],
 'MG契約・台帳':['MgLedger.jsx','mg-ledger-import.mjs'],
 '権利先・MG帳票':['RightsReports.jsx'],
 '権利・分配':['Settlement.jsx'],
 '製作委員会':['Committee.jsx','JointCommittee.jsx'],
 'ロイヤリティ作成':['royalty/RoyaltyPeriodsPage.jsx','royalty/royalty-routes.mjs'],
 'ロイヤリティ集計':['royalty/RoyaltyLedgerPage.jsx','royalty/royalty-routes.mjs'],
 'ロイヤリティ報告書':['royalty/RoyaltyStatementsPage.jsx','royalty/royalty-routes.mjs'],
 'ロイヤリティ契約':['royalty/RoyaltyAgreementsPage.jsx','royalty/royalty-routes.mjs'],
 '委員会月次収支':['committee/CommitteeMonthlyPage.jsx','committee/committee-monthly-routes.mjs'],
 '経費':['main.jsx','bulk/BulkImportPanel.jsx','work/ExpensesPage.jsx','pl-bs/ExpensePayments.jsx'],
 'デモ資料':['DemoSamples.jsx'],
 '設計・定義':['Definitions.jsx'],
 '設計キャンバス':['DesignCanvas.jsx','design-model.mjs'],
 'ER':['admin/ErPage.jsx'],
 '拡張項目':['admin/ExtensionsPage.jsx'],
 'チーム':['admin/TeamPage.jsx'],
 'データ一覧':['admin/DataBrowser.jsx'],
 '取込履歴':['admin/ImportHistory.jsx'],
};
export const screenFiles=Object.freeze(Object.fromEntries(Object.entries(SCREEN_FILES).map(([page,files])=>[page,Object.freeze(files.map(file=>`src/${file}`))])));
export const screenSources=Object.fromEntries(Object.entries(screenFiles).map(([page,files])=>[page,files[0]]));
export function selectObject(state,id,allowed=objects){
 const object=allowed.find(o=>o.id===id);if(!object)return state;
 return {objectId:id,table:object.tables.includes(state.table)?state.table:object.tables[0],page:object.screens.includes(state.page)?state.page:object.screens[0],notice:''};
}
export function selectTable(state,table,allowed=objects){
 const object=allowed.find(o=>o.id===state.objectId&&o.tables.includes(table))||allowed.find(o=>o.tables.includes(table));
 if(!object)return {objectId:null,table,page:null,notice:'この表はDBにありますが、業務のまとまり・画面との対応は未定義です。'};
 return {...selectObject(state,object.id,allowed),table,notice:state.objectId!==object.id?`「${object.label}」の表へ移りました。`:''};
}
export function selectScreen(state,page,allowed=objects){
 const object=allowed.find(o=>o.id===state.objectId&&o.screens.includes(page))||allowed.find(o=>o.screens.includes(page));
 if(!object)return state;
 return {...selectObject(state,object.id,allowed),page,notice:state.objectId!==object.id?`この画面に対応する「${object.label}」を選びました。`:''};
}
export function foreignKeys(tables){
 return tables.flatMap(table=>{
  const groups=new Map();for(const fk of table.foreignKeys||[]){const key=`${table.name}:${fk.id}`;if(!groups.has(key))groups.set(key,{key,from:table.name,to:fk.table,columns:[]});groups.get(key).columns.push(fk)}
  return [...groups.values()].map(edge=>({...edge,columns:edge.columns.sort((a,b)=>a.seq-b.seq)}));
 });
}
// The correspondence is explicit. Neither a shared name nor an FK invents a business meaning.
export function impactForObject(id,allowed=objects){
 const object=allowed.find(item=>item.id===id);
 if(!object)return {tables:[],screens:[]};
 return {tables:[...object.tables],screens:[...object.screens]};
}
export function canvasTableScope(tables,edges,selectedTable,objectTables=[],scope='core'){
 const existing=new Set(tables.map(table=>table.name));
 if(scope==='all')return tables;
 const direct=new Set([selectedTable,...edges.filter(edge=>edge.from===selectedTable||edge.to===selectedTable).flatMap(edge=>[edge.from,edge.to])]);
 const wanted=scope==='related'?direct:new Set([selectedTable,...objectTables]);
 return tables.filter(table=>existing.has(table.name)&&wanted.has(table.name));
}
export function validateModel(model,tables,screens){
 const issues=[],ids=new Set(),names=new Set(tables.map(t=>t.name));
 for(const object of model){
  if(ids.has(object.id))issues.push(`重複ID ${object.id}`);ids.add(object.id);
  if(!object.tables.length||!object.screens.length)issues.push(`対応なし ${object.id}`);
  for(const name of object.tables)if(!names.has(name))issues.push(`表なし ${object.id}:${name}`);
  for(const page of object.screens)if(!screens.includes(page)||!screenSources[page])issues.push(`画面なし ${object.id}:${page}`);
 }
 return issues;
}

