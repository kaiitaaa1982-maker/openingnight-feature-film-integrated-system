export const EXPENSE_COLUMN_VERSION='req6-v1';
export const LEGACY_EXPENSE_COLUMNS=Object.freeze(['ID','流通名','統一作品ID','商品ID','品番','商品名','計上日（YYYY/MM/DD）','取引先名','仕様','請求項目','数量','単価','金額(税別)','消費税(自動)','源泉徴収税額','金額(税込)','発注先','請求日','メモ','仕入先ID','勘定科目','費用区分']);
export const EXPENSE_COLUMN_SETS=Object.freeze({legacy:LEGACY_EXPENSE_COLUMNS,basic:Object.freeze([...LEGACY_EXPENSE_COLUMNS,'締め日','出金予定日','出金日']),accounting:Object.freeze(['ID','費用区分','勘定科目','税区分','源泉区分','源泉徴収税額','整備状態']),payout:Object.freeze(['仕入先ID','取引先名','締め日','出金予定日','出金日','支払残額'])});
