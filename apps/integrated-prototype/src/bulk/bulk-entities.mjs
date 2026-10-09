// Excel一括登録の対象と列。見出しは日本語（テンプレートの1行目）。キー列は変更できない。
// type: code（文字のコード）/ text / yen（整数円）/ int / date / month / select（domain の日本語）/ lookup（別の表のコード）/ percent
// update: 'direct'（この画面で更新する）/ 'approval'（業務データ編集で承認して反映する。この画面では反映しない）/ 'none'
export const BULK_ENTITIES = Object.freeze({
  partners: {
    label: '取引先', table: 'partners', key: 'code', update: 'approval', approvalPage: '業務データ編集',
    columns: [
      {key: 'code', header: '取引先コード', type: 'code', required: true, example: 'PT-EXAMPLE', hint: '会社で決めたコード。登録後は変更できません'},
      {key: 'name', header: '名称', type: 'text', required: true, max: 200, example: '架空配信サービス'},
      {key: 'kind', header: '区分', type: 'select', domain: 'partnerKind', required: true, example: '配信事業者', hint: '劇場・配信事業者・販売店・代理店・委託先・その他から選択'},
      {key: 'region', header: '地域', type: 'text', max: 100, example: '全国'},
    ],
  },
  projects: {
    label: '案件', table: 'projects', key: 'code', update: 'none',
    columns: [
      {key: 'code', header: '案件コード', type: 'code', required: true, example: 'PRJ-EXAMPLE', hint: '登録後は変更できません'},
      {key: 'title', header: '案件名', type: 'text', required: true, max: 200, example: '架空の新作映画'},
      {key: 'status', header: '状態', type: 'select', domain: 'projectStatus', required: true, example: '企画中'},
      {key: 'budget_yen', header: '予算（円）', type: 'yen', min: 0, example: '12000000', hint: '空欄可。カンマ・円・全角数字も読めます', finance: true},
    ],
  },
  works: {
    label: '作品', table: 'works', key: 'code', update: 'approval', approvalPage: '業務データ編集',
    columns: [
      {key: 'code', header: '作品コード', type: 'code', required: true, example: 'WRK-EXAMPLE', hint: '登録後は変更できません'},
      {key: 'project_id', header: '案件コード', type: 'lookup', lookup: 'projects', required: true, example: 'PRJ-DEMO', hint: '登録済みの案件コード'},
      {key: 'title', header: '作品名', type: 'text', required: true, max: 200, example: '架空の新作映画'},
      {key: 'format', header: '形式', type: 'select', domain: 'workFormat', required: true, example: '映画'},
      {key: 'forecast_yen', header: '売上見込（円）', type: 'yen', min: 0, example: '18000000', finance: true},
    ],
  },
  products: {
    label: '商品', table: 'products', key: 'sku', update: 'approval', approvalPage: '業務データ編集',
    columns: [
      {key: 'sku', header: '商品SKU', type: 'code', required: true, example: 'SKU-EXAMPLE', hint: '登録後は変更できません'},
      {key: 'name', header: '商品名', type: 'text', required: true, max: 200, example: '架空の配信版'},
      {key: 'channel', header: '流通', type: 'select', domain: 'productChannel', required: true, example: '配信'},
      {key: 'alloc_work_1', header: '配賦先作品コード1', type: 'lookup', lookup: 'works', example: 'WRK-DEMO', hint: '新規の商品だけ。空欄なら後で配賦画面で設定', allocation: 1},
      {key: 'alloc_rate_1', header: '配賦率1（%）', type: 'percent', example: '100', allocation: 1},
      {key: 'alloc_work_2', header: '配賦先作品コード2', type: 'lookup', lookup: 'works', allocation: 2},
      {key: 'alloc_rate_2', header: '配賦率2（%）', type: 'percent', allocation: 2},
      {key: 'alloc_work_3', header: '配賦先作品コード3', type: 'lookup', lookup: 'works', allocation: 3},
      {key: 'alloc_rate_3', header: '配賦率3（%）', type: 'percent', allocation: 3},
    ],
  },
  expenses: {
    label: '経費', table: 'expenses', key: 'id', update: 'direct', finance: true,
    columns: [
      {key: 'id', header: '経費ID', type: 'int', example: '', hint: '空欄は新規。出力したファイルのIDを残すと、その行の修正になります'},
      {key: 'project_id', header: '案件コード', type: 'lookup', lookup: 'projects', required: true, example: 'PRJ-DEMO'},
      {key: 'work_id', header: '作品コード', type: 'lookup', lookup: 'works', example: 'WRK-DEMO', hint: '空欄は案件共通の経費'},
      {key: 'partner_id', header: '取引先コード', type: 'lookup', lookup: 'partners', example: 'PT-STORE'},
      {key: 'incurred_on', header: '発生日', type: 'date', required: true, example: '2026-09-01'},
      {key: 'accounting_month', header: '計上月', type: 'month', example: '2026-09', hint: '空欄なら発生日の月'},
      {key: 'category', header: '費目', type: 'text', required: true, max: 100, example: '宣伝費', hint: '科目と費用にする時期は会計の設定の費用区分で確認する'},
      {key: 'description', header: '内容', type: 'text', required: true, max: 1000, example: '架空の予告編制作'},
      {key: 'budget_yen', header: '予算（円）', type: 'yen', min: 0, example: '300000'},
      {key: 'actual_ex_tax', header: '実績税抜（円）', type: 'yen', required: true, allowNegative: true, example: '250000'},
      {key: 'tax_amount', header: '税額（円）', type: 'yen', required: true, allowNegative: true, example: '25000'},
      {key: 'actual_inc_tax', header: '実績税込（円）', type: 'yen', allowNegative: true, example: '275000', hint: '空欄なら税抜＋税額。入れた場合は一致を確認します'},
    ],
  },
});

export const BULK_ENTITY_ORDER = Object.freeze(['partners', 'projects', 'works', 'products', 'expenses']);
export const TEMPLATE_VERSION = '2026-09-24.1';
export const REFERENCE_PREFIX = '参考_';

export function entityDef(entity) {
  const def = BULK_ENTITIES[entity];
  if (!def) throw new Error('一括登録できない種類です');
  return def;
}
