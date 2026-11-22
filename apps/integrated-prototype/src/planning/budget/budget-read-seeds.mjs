// 予算書の読み取りの定義の初期値（種）。データだけを置く（会社ルートの plans/2026-11-12-ingest-definitions.md の論点6。要件 FR-PLAN-BUDGET-035〜041）。
// 2つの書式（「科目・金額(税抜)」の区画と、Code・Detail・Description）を、それまでコードに直書きしていた語と同じ中身で写した。
// 組織ごとの定義の版は DB（移行 0066 の budget_read_*）が正本で、ここは次の3か所の元になる:
//   - 移行 0067 の INSERT（既存の組織に、初期値として承認済みの版1を入れる。定義の JSON と指紋は test/budget-read-definitions.test.mjs がここと照合する）
//   - 定義を1つも持たない組織（移行のあとに作った組織）に、受け口が初めて読むときに入れる初期値（budget-routes.mjs）
//   - DB を使わずに読む入口（readBudgetFile の既定。core の scripts/ops/budget-split.mjs）
// 語は正規表現ではなく、ただの文字として当てる（決定1）。当て方（equals・prefix・contains・words）と区分の行き先の語彙は budget-read-model.mjs が決める。
// 書き換えるときは、新しい移行で版を足す（ここを変えても、既に入った組織の定義は変わらない）。架空の値・実名を入れない。

const SUMMARY = [
  {to: 'estimate', equals: ['制作費見積', '制作費見積り', '制作費見積税抜', '制作費見積税抜き', '制作費見積り税抜', '制作費見積り税抜き']},
  {to: 'tax', prefix: ['消費税']},
  {to: 'totalIncTax', equals: ['合計金額', '合計金額税込']},
];
const HEADER_FIELDS = [{to: 'createdOn', equals: ['作成日']}];
const NOTES = {contains: ['準備期間', '撮影日数', '完成', '人数', 'スタッフ数']};
const CONFIRMED_FILLS = ['FFFF00'];

const deepFreeze = (value) => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

export const BUDGET_READ_SEEDS = deepFreeze([
  {
    name: '科目・金額(税抜)の区画',
    reason: '初期値: コードに直書きしていた「科目・金額(税抜)」の区画の書式を写した',
    definition: {
      kind: 'budget',
      name: '科目・金額(税抜)の区画',
      read: {layout: 'category_blocks', subtotal: 'marker_row', category: 'letter_prefix_then_order'},
      header: {roles: {name: ['科目', '費目'], unitPrice: ['単価'], qty: ['数量'], unit: ['単位'], amount: ['金額(税抜)', '金額', '税抜'],
        amountIncTax: ['金額(税込)'], actual: ['実費']}},
      subtotalMarkers: ['小計'],
      totals: [
        {to: 'direct', equals: ['直接制作費', '直接制作費合計', '直接制作費小計', '直接制作費計']},
        {to: 'managementFee', equals: ['制作管理費']},
        {to: 'contingency', equals: ['予備費']},
        {to: 'total', equals: ['総合計', '総合計税抜', '総合計税抜き']},
        {to: 'subtotalWithFee', equals: ['小計']},
      ],
      summary: SUMMARY,
      headerFields: HEADER_FIELDS,
      notes: NOTES,
      ignore: [{to: 'cast_table', contains: ['役名', '役者名', '所属']}],
      confirmedFills: CONFIRMED_FILLS,
      breakdown: {amountHeader: {contains: ['金額', '合計']}, label: {contains: ['役名', '名目', '氏名', '項目', '内容']},
        qty: {prefix: ['数量', '日数', '人数']}, unitPrice: {prefix: ['単価', '日額']}},
    },
  },
  {
    name: 'Code・Detail・Description',
    reason: '初期値: コードに直書きしていた Code・Detail・Description の書式を写した',
    definition: {
      kind: 'budget',
      name: 'Code・Detail・Description',
      read: {layout: 'code_detail', subtotal: 'sum_range_of_amount_column', category: 'words_then_line_majority'},
      header: {roles: {code: ['code'], name: ['detail'], description: ['description'], qty: ['数', '数量'], unitPrice: ['単価'], unit: ['単位'],
        amount: ['合計(税抜)', '金額(税抜)', '金額']}},
      grandTotal: {contains: ['grand total', '総合計']},
      categories: [
        {to: 'managementFee', words: ['制作管理', 'production fee']},
        {to: 'contingency', words: ['予備費', 'contingency']},
        {to: 'A', words: ['企画', 'development']},
        {to: 'B', words: ['キャスト', '俳優', '出演', 'talent', 'cast']},
        {to: 'C', words: ['プロデューサー', 'producer', 'producers']},
        {to: 'D', words: ['監督', 'スタッフ', 'director', 'directors', 'staff', 'crew']},
        {to: 'E', words: ['準備', 'ロケハン', 'リハーサル', 'pre-production', 'preproduction']},
        {to: 'F', words: ['機材', 'equipment']},
        {to: 'G', words: ['美術', '装飾', '衣裳', '衣装', 'ヘアメイク', 'メイク', 'wardrobe', 'set construction']},
        {to: 'H', words: ['ロケ', '車両', 'location', 'locations', 'transportation']},
        {to: 'I', words: ['音楽', '効果', '音響', '劇伴', '楽曲', '選曲', 'sound', 'music']},
        {to: 'J', words: ['編集', 'タイトル', 'テロップ', 'データ', 'メディア', 'グレーディング', 'vfx', 'cg', 'dit', 'editing', 'grading']},
        {to: 'K', words: ['保険', '宣伝', 'ポスター', 'スチール', '雑費', 'expense', 'expenses', 'insurance', 'publicity']},
      ],
      summary: SUMMARY,
      headerFields: HEADER_FIELDS,
      notes: NOTES,
      confirmedFills: CONFIRMED_FILLS,
    },
  },
]);
