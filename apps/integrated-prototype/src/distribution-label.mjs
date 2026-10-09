// 流通の表示名（画面・帳票・Excel で同じ形にそろえる）。Worker でも動くよう node:* を import しない。
// ・流通マスタの流通ID: 「流通ID｜流通名｜取引方法｜販売種別」（販売種別が空なら省く）。例「D004｜配信｜RS｜TVOD」
//   流通名だけだと D004〜D006 がどれも「配信」、A001・A003 が「海外」、S001・S002 が「セル」になり、金額の違う行が同じ名前で並ぶ。
//   R001・R002・R004 は流通名も販売種別も「レンタル_RSS」で同じなので、取引方法（LF・MG・RS）も入れて区別する。
// ・旧区分（流通マスタに無いコード。theatrical・package_unknown など）: 区分の表示名（distribution_types.label）
// 正本はこの SQL 片で、/api/distribution-types（reporting.mjs の distributionTypes）も同じ片で作る。
export const DISTRIBUTION_TYPE_LABEL_SQL = "CASE WHEN m.code IS NULL THEN t.label ELSE m.code || '｜' || m.distribution_name || '｜' || m.transaction_method || CASE WHEN m.sales_type<>'' THEN '｜' || m.sales_type ELSE '' END END";

// 流通の区分すべての {code, label}（t: distribution_types、m: distribution_master）
export const DISTRIBUTION_TYPE_LABELS_SQL = `SELECT t.code, ${DISTRIBUTION_TYPE_LABEL_SQL} AS label FROM distribution_types t LEFT JOIN distribution_master m ON m.code=t.code`;

// 流通の区分のコード → 表示名
export async function distributionTypeLabels(db) {
  return new Map((await db.all(DISTRIBUTION_TYPE_LABELS_SQL)).map((row) => [row.code, row.label]));
}
