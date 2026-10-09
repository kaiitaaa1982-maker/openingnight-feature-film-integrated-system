// 売上1行の流通の区分（劇場・レンタル・セル・配信・放送・海外など）と、作品の配賦済み売上明細を読む関数。
// ロイヤリティ（対象流通・基礎）と製作委員会の月次収支（窓口）が同じ区分を使う。Worker でも動くよう node:* を import しない。
// 決め方: 最新の流通分類（sale_distribution_versions）の地域が日本以外なら海外。それ以外は分類の family・utilization、
// 分類が無ければ報告の種類で決める。区分を決め切れないビデオグラムは package（レンタル／セル未確認）として残す。
// 地域は営業作品一覧と同じ名寄せ（sales-catalog-model.mjs の territoryKey。全角半角・大文字小文字・別表記をそろえる）で日本かを決める。
import {splitByAllocation} from '../money-allocation.mjs';
import {territoryKey} from '../sales-ops/sales-catalog-model.mjs';
import {allIn} from '../sql-in.mjs';

export const CHANNEL_GROUPS = Object.freeze(['theatrical', 'rental', 'sell', 'package', 'digital', 'broadcast', 'overseas', 'other']);
export const CHANNEL_LABELS = Object.freeze({
  theatrical: '劇場', rental: 'ビデオグラム（レンタル）', sell: 'ビデオグラム（セル）', package: 'ビデオグラム（区分未確認）',
  digital: '配信', broadcast: '放送', overseas: '海外', other: 'その他',
});
// 製作委員会の窓口（committee_term_windows.kind）への対応。海外は窓口 other の条件で計算する
export const COMMITTEE_WINDOW_OF = Object.freeze({
  theatrical: 'theatrical', rental: 'package', sell: 'package', package: 'package', digital: 'digital', broadcast: 'broadcast', overseas: 'other', other: 'other',
});

// 地域が日本（国内）か。空・「日本」「国内」「日本国内」「全国」「JPN」「ＪＰ」「ジャパン」など日本の別表記は国内。
// 名寄せの表に無い「日本（国内）」「日本(沖縄を含む)」のように、括弧の前が日本で、括弧の中が日本以外の既知の地域でないものも国内。
export function isDomesticTerritory(territory) {
  const key = territoryKey(territory);
  if (key === '' || key === 'JP') return true;
  if (!key.startsWith('raw:')) return false;
  const match = /^(.+?)\((.*)\)$/.exec(key.slice(4));
  if (!match || territoryKey(match[1]) !== 'JP') return false;
  const inner = territoryKey(match[2]);
  return inner === '' || inner === 'JP' || inner.startsWith('raw:');
}

export function isOverseasTerritory(territory) {
  return !isDomesticTerritory(territory);
}

// 流通区分マスタ（H001〜 などのコード。family は 'unverified'）の流通名 → 区分。名前で決まらないコードは報告の種類で決める。
// レンタル_RSS（R001・R002・R004）もレンタル（取引先別リストの流通の照合 partner-list-model.mjs の flowOf と同じ）
export const MASTER_NAME_GROUP = Object.freeze({
  '配給': 'theatrical', 'レンタル': 'rental', 'レンタル_RSS': 'rental', 'セル': 'sell', '配信': 'digital', '業務用VOD': 'digital', '放送': 'broadcast', '海外': 'overseas',
  '配給_物販': 'other', 'グッズ': 'other', '稿料': 'other', '映像、画像使用': 'other', '製作委員会収入': 'other', '調整': 'other', '相殺': 'other',
});

// {family, utilization, territory, kind, distributionName} → 区分
export function channelGroupOf({family = null, utilization = null, territory = null, kind = null, distributionName = null} = {}) {
  if (territory != null && isOverseasTerritory(territory)) return 'overseas';
  const verified = family && family !== 'unverified';
  if (!verified && distributionName && MASTER_NAME_GROUP[distributionName]) return MASTER_NAME_GROUP[distributionName];
  const base = verified ? family : kind;
  if (base === 'theatrical') return 'theatrical';
  if (base === 'package') return utilization === 'rental' ? 'rental' : utilization === 'sell' ? 'sell' : 'package';
  if (base === 'digital') return 'digital';
  if (base === 'broadcast') return 'broadcast';
  return 'other';
}

// 対象流通の指定（区分の配列。空＝全流通）に売上の区分が入るか。
// 区分未確認のビデオグラム（package）は、レンタルとセルの両方を対象にしているときだけ入る。片方だけなら決められない（null）
export function channelMatches(filter, group) {
  const list = Array.isArray(filter) ? filter : [];
  if (!list.length) return true;
  if (group === 'package') {
    const rental = list.includes('rental'), sell = list.includes('sell');
    if (rental && sell) return true;
    if (!rental && !sell) return false;
    return null;
  }
  return list.includes(group);
}

// ---- 1回の要求の中で同じ読み出しを分け合う ----
// 委員会の月次収支は、本委員会収入とロイヤリティの発生額（その中の本委員会収入）が同じ作品の売上明細を読む。
// withSharedReads(db) で包んだ db を渡すと、workSaleLines などは先に読んだ結果（作品・期間が包含するもの）を使い、読み直さない。
// 包まない db では何もしない（毎回読む）。要求ごとに包み直すこと（書き込みの後に古い結果を使わないため）。
const SHARED = Symbol('sharedReads');
export function withSharedReads(db) {
  if (!db || db[SHARED]) return db;
  const cache = new Map();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === SHARED) return cache;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
export function sharedReads(db) {
  return db?.[SHARED] || null;
}

const idList = (list) => [...new Set((list || []).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);

// 売上明細の問い合わせ（組織・有効な報告・計上月で絞る。作品の条件は呼び出し側が足す）
const SALE_SELECT = `SELECT s.id, s.work_id, s.product_id, s.partner_id, s.report_id, s.accounting_month, s.amount_ex_tax,
      r.kind, r.report_key, d.distribution_code, d.territory, t.family, t.utilization, m.distribution_name
    FROM sale_lines s
    JOIN report_imports r ON r.org_id=s.org_id AND r.id=s.report_id
    LEFT JOIN sale_distribution_versions d ON d.org_id=s.org_id AND d.sale_id=s.id
      AND d.version_no=(SELECT MAX(x.version_no) FROM sale_distribution_versions x WHERE x.org_id=s.org_id AND x.sale_id=s.id)
    LEFT JOIN distribution_types t ON t.code=d.distribution_code
    LEFT JOIN distribution_master m ON m.code=d.distribution_code
    WHERE s.org_id=? AND r.status='active' AND s.accounting_month BETWEEN ? AND ?`;

async function readWorkSaleLines(db, orgId, targets, from, to) {
  const wanted = new Set(targets);
  // 1. 対象作品へ配賦する商品と、その商品の配賦先すべて（配賦の端数は全配賦先で決めるため）
  const maps = await allIn(db, `SELECT pw.product_id, pw.work_id, pw.allocation_bps FROM product_works pw
      WHERE pw.org_id=? AND pw.product_id IN (SELECT x.product_id FROM product_works x WHERE x.org_id=? AND x.work_id IN (:in))`,
  {before: [orgId, orgId], ids: targets});
  const byProduct = new Map();
  const seenShare = new Set();
  for (const m of maps.sort((a, b) => a.product_id - b.product_id || a.work_id - b.work_id)) {
    const key = `${m.product_id}:${m.work_id}`;
    if (seenShare.has(key)) continue;
    seenShare.add(key);
    if (!byProduct.has(m.product_id)) byProduct.set(m.product_id, []);
    byProduct.get(m.product_id).push(m);
  }
  // 2. その商品の売上と、配賦の無い（商品なし・配賦未登録の商品の）対象作品の売上。作品で絞って読む（組織全体を読まない）
  const [byProductSales, byWorkSales] = await Promise.all([
    byProduct.size ? allIn(db, `${SALE_SELECT} AND s.product_id IN (:in)`, {before: [orgId, from, to], ids: [...byProduct.keys()]}) : [],
    allIn(db, `${SALE_SELECT} AND s.work_id IN (:in)
        AND (s.product_id IS NULL OR NOT EXISTS (SELECT 1 FROM product_works pw WHERE pw.org_id=s.org_id AND pw.product_id=s.product_id))`,
    {before: [orgId, from, to], ids: targets}),
  ]);
  const sales = new Map();
  for (const sale of [...byProductSales, ...byWorkSales]) sales.set(sale.id, sale);
  const ordered = [...sales.values()].sort((a, b) => a.accounting_month.localeCompare(b.accounting_month) || a.id - b.id);
  const lines = [];
  for (const sale of ordered) {
    let shares = sale.product_id ? byProduct.get(sale.product_id) || [] : [];
    if (!shares.length) shares = [{work_id: sale.work_id, allocation_bps: 10000}];
    const mine = shares.filter((share) => wanted.has(Number(share.work_id)));
    if (!mine.length) continue;
    const parts = splitByAllocation(sale.amount_ex_tax, shares);
    for (const share of mine) {
      lines.push({
        saleId: sale.id, reportId: sale.report_id, reportKey: sale.report_key, workId: Number(share.work_id), productId: sale.product_id,
        partnerId: sale.partner_id, accountingMonth: sale.accounting_month, amount: parts.get(share.work_id), allocationBps: share.allocation_bps,
        kind: sale.kind, distributionCode: sale.distribution_code || null, family: sale.family || null, utilization: sale.utilization || null,
        territory: sale.territory ?? null,
        channelGroup: channelGroupOf({family: sale.family, utilization: sale.utilization, territory: sale.territory, kind: sale.kind, distributionName: sale.distribution_name}),
      });
    }
  }
  return lines;
}

// 作品（複数可）の配賦済み売上明細。有効な報告だけ・計上月・税抜。work-pnl と同じ配賦（商品→作品の配賦率）。
// 対象作品へ配賦する商品の売上と、配賦の無い対象作品の売上だけを読む（IN は allIn で80件ずつ）。
// withSharedReads で包んだ db なら、同じ要求で先に読んだ明細（対象作品・期間を包含するもの）から返す。
// 戻り値: [{saleId, reportId, reportKey, workId, productId, partnerId, accountingMonth, amount, allocationBps, kind,
//           distributionCode, family, utilization, territory, channelGroup}]
export async function workSaleLines(db, orgId, workIds, {from = '0000-01', to = '9999-12'} = {}) {
  const targets = idList(workIds);
  if (!targets.length) return [];
  const cache = sharedReads(db);
  if (cache && !cache.has('saleLines')) cache.set('saleLines', []);
  const entries = cache ? cache.get('saleLines') : null;
  const covering = entries?.find((entry) => entry.orgId === orgId && entry.from <= from && entry.to >= to && targets.every((id) => entry.works.has(id)));
  if (covering) {
    const wanted = new Set(targets);
    return (await covering.promise).filter((line) => wanted.has(line.workId) && line.accountingMonth >= from && line.accountingMonth <= to);
  }
  const promise = readWorkSaleLines(db, orgId, targets, from, to);
  if (entries) {
    const entry = {orgId, works: new Set(targets), from, to, promise};
    entries.push(entry);
    // 読み出しに失敗したら分け合わない（次の呼び出しで読み直す）
    promise.catch(() => { entries.splice(entries.indexOf(entry), 1); });
  }
  return promise;
}
