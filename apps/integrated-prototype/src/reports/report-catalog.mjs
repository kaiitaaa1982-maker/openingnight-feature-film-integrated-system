// 帳票センターのカタログ。帳票は「選ぶ→条件→画面で確認→同じ数字でExcel」の順に1画面で扱う。
// component: 'annual'（年間売上） / 'legacy'（従来の帳票パネルを mode で表示） / 'link'（専用画面へ移る） / その他は registry.jsx の部品名
export const REPORT_CATEGORIES = Object.freeze([
  {id: 'sales', label: '売上'},
  {id: 'mg', label: 'MG（最低保証）'},
  {id: 'royalty', label: 'ロイヤリティ・権利者'},
  {id: 'pnl', label: '収支'},
  {id: 'committee', label: '製作委員会'},
  {id: 'billing', label: '請求・入金・税'},
]);

export const REPORT_CATALOG = Object.freeze([
  {id: 'annual-sales', category: 'sales', label: '年間売上（月別推移）', featured: true, component: 'annual', axis: 'total',
    description: '年度の月別売上を、四半期・上期下期・年度計・構成比・前年比つきで。作品・取引先・流通・商品で切り替え', formats: ['Excel', 'CSV', '印刷']},
  {id: 'mg-sales', category: 'mg', label: 'MG売上報告（台帳ベース）', featured: true, component: 'mg-sales', legacyMode: 'mg-portfolio',
    description: 'MG契約ごとの基準月時点の充当・未消化残高・超過計上と、取引先別の集計', formats: ['Excel', '印刷']},
  {id: 'royalty', category: 'royalty', label: '配給委託の精算報告書', featured: true, component: 'royalty', legacyMode: 'royalty',
    description: '配給委託の契約（手数料型・MG型）で、権利元ごと・期間ごとの前回まで／当期／累計と、支払済・未払残。算定できない明細は保留（HOLD）', formats: ['Excel', '印刷']},
  {id: 'royalty-ledger', category: 'royalty', label: 'ロイヤリティ集計シート（権利者×月・累計）', featured: true, component: 'royalty-ledger',
    description: '監督料・脚本料・音楽著作権料・原作料を、権利者×種別×月の発生額・累計・支払・未払と、イレギュラーの記録つきで', formats: ['Excel', '印刷']},
  {id: 'royalty-cycle', category: 'royalty', label: 'ロイヤリティ報告書（権利者×締め月）', component: 'royalty-cycle',
    description: '契約のサイクルで締めた期間ごとの報告書。前回まで・当期・累計、経費の控除、前払金の充当と繰越、報告と支払の記録', formats: ['Excel', '印刷']},
  {id: 'progress', category: 'sales', label: '月次の受領進捗', component: 'progress',
    description: '届くはずの報告（取引先×報告の種類×頻度）ごとに、月の未受領・取込済・請求済・入金済。欄から取込へ', formats: ['Excel', '印刷']},
  {id: 'sales-sheet', category: 'sales', label: '売上集計シート（83列）', featured: true, component: 'sales-sheet',
    description: '売上明細1件を1行に、旧の83列と同じ意味の列で。列セット7つ・切り口の集計（合計・期末・比率の再計算）・保存した形・拡張属性の入力', formats: ['Excel', 'CSV']},
  {id: 'distribution-master', category: 'sales', label: '流通区分マスタ（流通ID・取引方法・販売種別）', component: 'distribution-master',
    description: '売上・販売条件・放送で選ぶ流通区分の一覧（読み取り専用）。流通ID・流通名・取引方法・販売種別・備考', formats: ['Excel', 'CSV']},
  {id: 'annual-dashboard', category: 'billing', label: '年間推移ダッシュボード（売上・請求・入金）', component: 'annual-dashboard',
    description: '売上（計上月・販売月）・請求・入金を月ごとに並べ、月末の未請求残・未入金残と前年比。税込', formats: ['Excel', 'CSV', '印刷']},
  {id: 'sales-by-work', category: 'sales', label: '作品別売上', component: 'annual', axis: 'work',
    description: '作品ごとの月別売上と年度計', formats: ['Excel', 'CSV']},
  {id: 'sales-by-partner', category: 'sales', label: '取引先別売上', component: 'annual', axis: 'partner',
    description: '取引先ごとの月別売上と年度計', formats: ['Excel', 'CSV']},
  {id: 'sales-by-distribution', category: 'sales', label: '流通別売上', component: 'annual', axis: 'distribution',
    description: '流通区分ごとの月別売上と年度計', formats: ['Excel', 'CSV']},
  {id: 'sales-by-product', category: 'sales', label: '商品別売上', component: 'annual', axis: 'product',
    description: '商品（SKU）ごとの月別売上と年度計', formats: ['Excel', 'CSV']},
  {id: 'banpan', category: 'sales', label: '年間番販集計', component: 'legacy', legacyMode: 'banpan',
    description: '番組販売の部署・取引先・サービス別の年間集計', formats: ['Excel', 'CSV', '印刷']},
  {id: 'mg-work', category: 'mg', label: 'MG作品別現況', component: 'legacy', legacyMode: 'mg',
    description: '作品ごとのMG契約の消化・回収の現況', formats: ['Excel', '印刷']},
  {id: 'royalty-payments', category: 'royalty', label: 'ロイヤリティ試算と支払記録', component: 'legacy', legacyMode: 'royalty',
    description: '作品単位の分配試算と、支払実績の記録', formats: ['Excel', '印刷']},
  {id: 'work-pnl', category: 'pnl', label: '作品別収支', component: 'work-pnl', legacyMode: 'pnl',
    description: '作品と期間を選び、作品計・流通別・月別の売上と経費。制作費の経費は計上月で差し引く（作品別PLは公開月に一括）。作品の決まっていない経費は別表（差し引かない）', formats: ['Excel', 'CSV', '印刷']},
  {id: 'work-pl', category: 'pnl', label: '作品別PL（管理会計の試算）', component: 'work-pl',
    description: '自社作品は売上−ロイヤリティ−作品の経費−制作費（公開月に一括）。委員会作品は自社の取り分だけ。期間と累計', formats: ['Excel', 'CSV', '印刷']},
  {id: 'company-pl', category: 'pnl', label: '会社PL（月次・管理会計の試算）', component: 'company-pl',
    description: '作品別PLの合計に、全社費用・営業外・特別・法人税等の手入力を足した月次のPL。決算書ではありません', formats: ['Excel', 'CSV', '印刷']},
  {id: 'company-bs', category: 'pnl', label: '会社BS（簡易・管理会計の試算）', component: 'company-bs',
    description: '期首残高に入出金と発生額を足した月末のBS。最後に説明のつかない差額を必ず出す', formats: ['Excel', 'CSV', '印刷']},
  {id: 'joint', category: 'pnl', label: '共同製作・入金基準の収支', component: 'legacy', legacyMode: 'joint',
    description: '共同製作契約の入金基準の保存済み収支', formats: ['Excel', '印刷']},
  {id: 'committee-monthly', category: 'committee', label: '製作委員会の月次収支（作品別）', featured: true, component: 'committee-monthly',
    description: '作品ごとに、月次の売上（流通別）・手数料・本委員会収入・経費・権利処理費・分配原資と、出資者別の分配・取得額・回収率', formats: ['Excel', '印刷']},
  {id: 'committee', category: 'committee', label: '製作委員会収支報告', component: 'legacy', legacyMode: 'committee',
    description: '委員会の収支・出資者分配・損益収支経緯・権利処理費', formats: ['Excel', '印刷']},
  {id: 'partner-balance', category: 'billing', label: '取引先別の売掛残高推移', component: 'partner-balance',
    description: '前月残＋当月売上−当月入金＝当月残。請求していない売上も残高に出る', formats: ['Excel', '印刷']},
  {id: 'receivables', category: 'billing', label: '売掛金の一覧（請求書ごと）', component: 'receivables',
    description: '基準日時点の入金済・残高・期日超過・経過区分', formats: ['Excel', 'CSV']},
  {id: 'receipts', category: 'billing', label: '月別入金表', component: 'link', page: '月別消込',
    description: '取引先×月の入金予定と消込（専用画面で開きます）', formats: []},
  {id: 'tax-ledger', category: 'billing', label: '税計算台帳', component: 'link', page: '税ルール・台帳',
    description: '税計算のルールと計算結果（専用画面で開きます）', formats: []},
]);

export const DEFAULT_REPORT = 'annual-sales';

export function reportById(id) {
  return REPORT_CATALOG.find((entry) => entry.id === id) || REPORT_CATALOG.find((entry) => entry.id === DEFAULT_REPORT);
}

export function reportsByCategory(catalog = REPORT_CATALOG) {
  return REPORT_CATEGORIES.map((category) => ({...category, reports: catalog.filter((entry) => entry.category === category.id)}))
    .filter((category) => category.reports.length > 0);
}

export function featuredReports(catalog = REPORT_CATALOG) {
  return catalog.filter((entry) => entry.featured);
}
