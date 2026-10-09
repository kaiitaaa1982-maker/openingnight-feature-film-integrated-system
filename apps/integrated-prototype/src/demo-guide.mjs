// デモ資料と香盤のデモの入口の決まり（画面・API・試験で共通。node: を import しない）。
// ・香盤のデモ（架空の連続ドラマ DEMO-D78）が、今の組織にあるか・所属する別の組織にあるか
// ・サンプルの Excel の組（従来の組織1用・架空データ DEMO-SALES 用）のどちらを今の組織に合わせて先に出すか
// ・数字のIDを直書きした「正常取込CSV」を今の組織で出してよいか

export const KOUBAN_DEMO_CODE = 'DEMO-D78';
// 組織を切り替えたあとに開く画面（香盤・日々スケの香盤タブ）。作品IDは組織ごとに違うので、作品コードで引く
export const KOUBAN_DEMO_DESTINATION = Object.freeze({page: '制作', params: Object.freeze({tab: 'kouban'}), workCode: KOUBAN_DEMO_CODE});

const positiveId = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// 香盤のデモの場所。here: 今の組織の作品にある／other: 所属する別の組織にある（id と名前だけ）／none: 見える所に無い
// locations は GET /api/session/org-features の koubanDemo（所属する組織のうち、自分が見られる DEMO-D78 がある組織）
export function koubanDemoPlace({works = [], currentOrgId = null, locations = []} = {}) {
  const work = (Array.isArray(works) ? works : []).find((row) => row?.code === KOUBAN_DEMO_CODE);
  if (work) return {kind: 'here', work};
  const current = positiveId(currentOrgId);
  const other = (Array.isArray(locations) ? locations : []).find((org) => positiveId(org?.id) !== null && positiveId(org.id) !== current);
  return other ? {kind: 'other', org: {id: positiveId(other.id), name: String(other.name || '').trim() || `組織 ${other.id}`}} : {kind: 'none'};
}

// 組織を切り替えたあとに開く画面。行き先の作品コードが読み込んだ組織の作品に無ければ、ホームを開いて知らせる
export function destinationAfterOrgChange(after, works = []) {
  if (!after?.page) return null;
  if (!after.workCode) return {page: after.page, params: {...(after.params || {})}, workId: null, missing: false};
  const work = (Array.isArray(works) ? works : []).find((row) => row?.code === after.workCode);
  if (!work) return {page: 'ホーム', params: {}, workId: null, missing: true, workCode: after.workCode};
  return {page: after.page, params: {...(after.params || {})}, workId: positiveId(work.id), missing: false};
}

// 香盤のデモの場所についての文（どの組織にも無いときだけ）。問い合わせに失敗したときは「どこにも無い」と言い切らない
export function koubanPlaceNote(place) {
  if (!place || place.kind !== 'none') return null;
  if (place.failed) return {kind: 'unknown', text: '香盤のデモがある組織を確かめられませんでした。再読込するか、台本PDFをダウンロードして台本の取込で読み込めます。'};
  if (!place.loaded) return null;
  return {kind: 'none', text: `香盤のデモ（${KOUBAN_DEMO_CODE}）は、所属しているどの組織にもありません。台本PDFをダウンロードして、台本の取込で読み込めます。`};
}

// 「取り込んだ台本を開く」のボタンの状態。scripts: null（読み込み中）・{rows}・{error}
export function scriptButtonState(scripts) {
  if (!scripts) return {disabled: true, label: '取り込んだ台本を読み込んでいます…'};
  if (scripts.error) return {disabled: true, label: '取り込んだ台本を読み込めませんでした', retry: true};
  const script = scriptToOpen(scripts.rows || []);
  if (!script) return {disabled: true, label: '取り込んだ台本はまだありません（下の「台本の取込で開く」から読み込めます）'};
  return {disabled: false, script, label: `取り込んだ台本を開く（${script.file_name}）`};
}

// 制作の画面に香盤のデモの入口を出すか。今の作品が香盤のデモ（DEMO-D78）のときと、どこにも無いときは出さない
// （香盤が空でなくても、ほかの作品や組織にあるデモへ行けるようにする）
export function showKoubanDemoEntry({place, workId}) {
  if (!place || place.kind === 'none') return false;
  if (place.kind === 'here') return Number(place.work?.id) !== Number(workId);
  return place.kind === 'other';
}

// 組織を切り替えて読み直したあとに移るときの navigate の options。作品コードの無い行き先（作品が見つからずホームへ戻るときも）は
// 作品を外して移る（前の組織の作品IDを新しい組織へ持ち込まない）
export function afterOrgChangeOptions(target) {
  return target?.workId ? {workId: target.workId, replace: true, force: true} : {clearWork: true, replace: true, force: true};
}

// 「取り込んだ台本を開く」で開く原本。登録済み（確定した）原本のうち最初に取り込んだもの。無ければ最初に取り込んだもの
// rows は GET /api/workflow/scripts の rows（id の大きい順）
export function scriptToOpen(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => positiveId(row?.id) !== null).sort((a, b) => Number(a.id) - Number(b.id));
  return list.find((row) => row.commit_id) || list[0] || null;
}

// ---- サンプルの Excel の組 ----------------------------------------------------------------------

// 従来の組（組織1の手元用初期データ WRK-DEMO に合わせた）。正常取込CSVは数字のID（取引先2・3、商品1・2）を直書きしている
const FIXTURE_IDS = Object.freeze({partners: [[2, 'PT-DIGITAL'], [3, 'PT-STORE']], products: [[1, 'SKU-DIGI'], [2, 'SKU-PACK']]});

export const SAMPLE_SETS = Object.freeze([
  Object.freeze({
    id: 'demo-sales', label: '架空データ（デモ）DEMO-SALES 用', markerCodes: Object.freeze(['DEMO-W01']),
    mapping: '作品は DEMO-W01〜DEMO-W20、取引先と商品は架空データ（デモ）の DEMO-* のマスタに合わせています。対象月は2026年7月（架空データの売上の翌月）です。',
    samples: Object.freeze([
      Object.freeze({
        key: 'demo-sales-streaming', title: '配信の売上報告（架空・DEMO-SALES 用）', tag: '配信 / TVOD・EST・6作品',
        note: '都度課金の配信の月次報告です。作品ごとに商品コード（DEMO-Wxx-DIG）を持ち、1行だけ商品コードが欠けた要修正の行があります。',
        files: Object.freeze([['XLSXをダウンロード', 'demo-sales-streaming-sample.xlsx']]),
        steps: Object.freeze([
          ['取引先', '架空配信B・都度課金（架空）（DEMO-PF-B）'], ['報告の種類', '配信'], ['見出し行', '4行目（シート Details）'],
          ['作品の決め方', '商品コードの列で作品ごとに分ける（列「商品ｺｰﾄﾞ」）'],
          ['要修正の行', '14行目（商品コード欠落・正味額不一致）。理由を書いて取込から除きます'],
        ]),
        expected: '正常9行・6作品。正味売上の合計 2,287,040円（税抜）。',
      }),
      Object.freeze({
        key: 'demo-sales-videogram', title: 'レンタルのビデオグラム報告（架空・DEMO-SALES 用）', tag: 'ビデオグラム / レンタルDVD・BD・5作品',
        note: '出荷・返品・正味数量・精算単価を持つレンタルの報告です。品番（DEMO-Wxx-RNT）で作品が決まり、1行だけ返品が出荷を超える要修正の行があります。',
        files: Object.freeze([['XLSXをダウンロード', 'demo-sales-videogram-sample.xlsx']]),
        steps: Object.freeze([
          ['取引先', '架空レンタルチェーン（架空）（DEMO-RNT-A）'], ['報告の種類', 'ビデオグラム'], ['見出し行', '4行目（シート Details）'],
          ['作品の決め方', '商品コードの列で作品ごとに分ける（列「品番」）'],
          ['要修正の行', '12行目（返品超過・正味額不一致）。理由を書いて取込から除きます'],
        ]),
        expected: '正常7行・5作品。正味数量 1,449、正味額の合計 640,580円（税抜）。',
      }),
    ]),
  }),
  Object.freeze({
    id: 'fixture', label: '手元用の初期データ（WRK-DEMO）用', markerCodes: Object.freeze(['WRK-DEMO']),
    mapping: '対象作品は WRK-DEMO / 風のあとさき。配信は取引先「架空配信」・商品「SKU-DIGI（デジタル視聴）」、ビデオグラムは取引先「架空ストア」・商品「SKU-PACK（パッケージ）」に合わせています。',
    samples: Object.freeze([
      Object.freeze({
        key: 'streaming-platform', title: '配信プラットフォームの売上報告（架空）', tag: '配信 / TVOD・SVOD・EST',
        note: '列名の揺れと、商品コード欠落・正味額不一致の要修正行を含む加工練習用です。',
        files: Object.freeze([['XLSXをダウンロード', 'streaming-platform-sample.xlsx'], ['CSVをダウンロード', 'streaming-platform-sample.csv']]), canonical: 'streaming-platform-canonical.csv',
        steps: Object.freeze([
          ['取引先', '架空配信'], ['報告の種類', '配信'], ['見出し行', '4行目（CSV は2行目）'], ['作品の決め方', '1つの作品（WRK-DEMO）'],
          ['要修正の行', '8行目（商品コード欠落・正味額不一致）。理由を書いて取込から除きます'],
        ]),
        expected: '正常3行。税抜合計 1,154,700円、税額 115,470円、税込合計 1,270,170円。',
      }),
      Object.freeze({
        key: 'videogram-rental', title: 'レンタル店のビデオグラム報告（架空）', tag: 'ビデオグラム / DVD・BD',
        note: '出荷、返品、正味数量、精算単価を持ち、返品超過・正味額不一致の要修正行を含みます。',
        files: Object.freeze([['XLSXをダウンロード', 'videogram-rental-sample.xlsx'], ['CSVをダウンロード', 'videogram-rental-sample.csv']]), canonical: 'videogram-rental-canonical.csv',
        steps: Object.freeze([
          ['取引先', '架空ストア'], ['報告の種類', 'ビデオグラム'], ['見出し行', '4行目（CSV は2行目）'], ['作品の決め方', '1つの作品（WRK-DEMO）'],
          ['要修正の行', '8行目（返品超過・正味額不一致）。理由を書いて取込から除きます'],
        ]),
        expected: '正常3行。正味数量 1,158、税抜合計 726,140円、税額 72,614円、税込合計 798,754円。',
      }),
    ]),
  }),
]);

// 正常取込CSV（数字のIDを直書き）が今の組織で正しいか。取引先・商品のIDとコードの組が、今の組織のマスタと一致するときだけ true
export function fixtureIdsValid({partners = [], products = []} = {}) {
  const partnerOk = FIXTURE_IDS.partners.every(([id, code]) => partners.some((row) => positiveId(row?.id) === id && row?.code === code));
  const productOk = FIXTURE_IDS.products.every(([id, sku]) => products.some((row) => positiveId(row?.id) === id && row?.sku === sku));
  return partnerOk && productOk;
}

// 今の組織に合う組を先に並べる。どちらも合わなければ両方を「対応するマスタがありません」の注記つきで出す。
// 戻り値: [{set, matches, showCanonical}]（showCanonical は正常取込CSVのリンクを出すか）
export function orderedSampleSets({works = [], partners = [], products = []} = {}) {
  const codes = new Set((Array.isArray(works) ? works : []).map((row) => row?.code));
  const canonicalOk = fixtureIdsValid({partners, products});
  const rows = SAMPLE_SETS.map((set, index) => ({set, index, matches: set.markerCodes.some((code) => codes.has(code))}));
  rows.sort((a, b) => Number(b.matches) - Number(a.matches) || a.index - b.index);
  return rows.map(({set, matches}) => ({set, matches, showCanonical: canonicalOk && set.samples.some((sample) => sample.canonical)}));
}

export const NO_MATCHING_MASTER_NOTE = 'この組織には対応するマスタがありません。取込の練習はできますが、作品・商品の照合は「マスタにない」になります。対応する組織に切り替えてから試してください。';
