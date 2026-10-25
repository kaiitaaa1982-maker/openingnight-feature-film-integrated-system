export const WORK_PAGES=['フォルダ一覧','ホーム','調達','作品・商品マスタ','業務データ編集','企画・作品','企画','予算書','プロデュース管理','調達・権利','製造','プリプロ','制作','台本・香盤','撮影の記録','ポスプロ','取引先','宣伝'];
// 営業基幹（2026-09-25 に業務基幹の「営業」グループから移した。ページIDは変えない）
export const EIGYO_PAGES=['全作品のウィンドウ','提案資料','営業作品一覧','取引先別リスト','番販・放送','商品・営業','営業資料'];
export const SALES_PAGES=['売上','経費集計シート','売上集計シート','デモ資料','売上データ編集','原本取り込み','フォルダ','報告書マッピング','請求・入金','入出金','税ルール・台帳','MG契約・台帳','MG 買付','権利先・MG帳票','月別消込','帳票センター','分析・Lightdash','経費','収支','権利・分配','製作委員会','ロイヤリティフォルダ','ロイヤリティ作成','ロイヤリティ集計','ロイヤリティ報告書','ロイヤリティ契約','委員会月次収支','委員会の台帳','PL・BS','シナリオの比較','予実管理'];
export const SHARED_PAGES=['設計・定義','設計キャンバス','ER','拡張項目','チーム','データ一覧','取込履歴'];
export const pageArea=page=>SALES_PAGES.includes(page)?'sales':EIGYO_PAGES.includes(page)?'eigyo':WORK_PAGES.includes(page)?'work':null;
export const normalizePage=page=>page==='流通マスタ'?'売上':[...WORK_PAGES,...EIGYO_PAGES,...SALES_PAGES,...SHARED_PAGES].includes(page)?page:'ホーム';
