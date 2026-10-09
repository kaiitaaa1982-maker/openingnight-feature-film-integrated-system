// 受領原本を作品ごとに分ける論理（純関数）。サーバー（sales-source-routes.mjs・sales-source-store.mjs）と画面（取込ウィザード）で共用する。
// 設計: docs/platform/team-development/royalty-committee-design.md §5。node:* は使わない（Worker でも動く）。
// - 1つの作品: 全行をその作品へ。
// - 商品コードの列: 値を NFKC にして前後の空白を除き、products.sku（同じ正規化）と完全一致で照合 → product_works の作品。
//   複数の作品に配賦された商品は「配賦率が最も高い作品、同率なら作品IDの小さい方」の報告に置く（画面で変えられる）。
//   他の作品への按分は、今と同じく集計時（allocatedSaleParts）に行う。
// - 作品コードの列: 値を works.code と照合。商品コードの列を併せて指定すると、その作品に配賦された商品かも確かめる。
// 照合できない値は推測で埋めない（unmatched に理由を付けて返し、取り込まない行にするかマスタを直してもらう）。

export const BINDING_MODES = Object.freeze(['single_work', 'by_product', 'by_work_column']);
// 商品コードの列で照合した商品IDを、分割後の表の右端に足す列（列対応の版では product_id の元の列にする）
export const RESOLVED_PRODUCT_COLUMN = '商品ID（照合）';

export const normalizeCode = (value) => String(value ?? '').normalize('NFKC').trim();

const CHANNEL_LABELS = Object.freeze({theatrical: '劇場', digital: '配信', package: 'ビデオグラム', broadcast: '放送', license: 'ライセンス', other: 'その他'});
const channelText = (value) => CHANNEL_LABELS[value] || '未確認';

// 自分で書き出した表（見出し＋明細の CSV）を、セルの値を変えずに読み戻す（parseCsv は値の前後の空白を除くため使わない）。
export function parseCsvCells(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const input = String(text ?? '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\r' && input[index + 1] === '\n') { row.push(value); rows.push(row); row = []; value = ''; index += 1; }
    else if (char === '\n') { row.push(value); rows.push(row); row = []; value = ''; }
    else value += char;
  }
  if (quoted) throw new Error('表の引用符が閉じていません');
  if (value !== '' || row.length) { row.push(value); rows.push(row); }
  return rows;
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export const toCsvText = (rows) => rows.map((row) => row.map(csvCell).join(',')).join('\r\n');

// 選択版（canonical_csv と原本の行番号）→ {headers, rows:[{sourceRow, cells, values}]}
export function selectionTable(canonicalCsv, sourceRowNumbers = []) {
  const [headers = [], ...data] = parseCsvCells(canonicalCsv);
  if (data.length !== sourceRowNumbers.length) throw new Error('表の選択の行数と原本の行番号の数が一致しません');
  return {
    headers,
    rows: data.map((cells, index) => ({sourceRow: Number(sourceRowNumbers[index]), cells, values: Object.fromEntries(headers.map((header, column) => [header, cells[column] ?? '']))})),
  };
}

// 割り当ての入力をそろえる。返り値 {binding} か {error}。headers を渡すと列の有無も確かめる。
export function normalizeBinding(input, headers = null) {
  const mode = String(input?.mode ?? '');
  if (!BINDING_MODES.includes(mode)) return {error: '作品の決め方を選んでください（1つの作品・商品コードの列・作品コードの列）'};
  const column = (value) => {
    const text = String(value ?? '').trim();
    return text || null;
  };
  const productColumn = column(input?.productColumn);
  const workColumn = column(input?.workColumn);
  const workId = input?.workId == null || input.workId === '' ? null : Number(input.workId);
  if (mode === 'single_work') {
    if (!Number.isSafeInteger(workId) || workId <= 0) return {error: '作品を選んでください'};
    return {binding: {mode, workId, productColumn: null, workColumn: null}};
  }
  for (const value of [productColumn, workColumn]) if (value && value.length > 200) return {error: '列の名前は200文字以内です'};
  if (mode === 'by_product') {
    if (!productColumn) return {error: '商品コードの列を選んでください'};
    if (headers && !headers.includes(productColumn)) return {error: `商品コードの列「${productColumn}」が見出しにありません`};
    return {binding: {mode, workId: null, productColumn, workColumn: null}};
  }
  if (!workColumn) return {error: '作品コードの列を選んでください'};
  if (headers && !headers.includes(workColumn)) return {error: `作品コードの列「${workColumn}」が見出しにありません`};
  if (productColumn && headers && !headers.includes(productColumn)) return {error: `商品コードの列「${productColumn}」が見出しにありません`};
  if (productColumn && productColumn === workColumn) return {error: '作品コードの列と商品コードの列は別の列にしてください'};
  return {binding: {mode, workId: null, productColumn, workColumn}};
}

export function sameBinding(a, b) {
  if (!a || !b) return false;
  return a.mode === b.mode && Number(a.workId ?? 0) === Number(b.workId ?? 0) && (a.productColumn ?? null) === (b.productColumn ?? null) && (a.workColumn ?? null) === (b.workColumn ?? null);
}

// DB の行 → 画面・計算用の形
export const bindingFromRow = (row) => (row ? {
  id: Number(row.id), versionNo: Number(row.version_no), mode: row.mode, workId: row.work_id == null ? null : Number(row.work_id),
  productColumn: row.product_column ?? null, workColumn: row.work_column ?? null, reason: row.reason, createdAt: row.created_at, createdBy: row.created_by,
} : null);

// 割り当ての説明（画面の日本語）。works: [{id, title}]
export function bindingText(binding, works = []) {
  if (!binding) return '作品はまだ決めていません';
  if (binding.mode === 'single_work') {
    const work = works.find((item) => Number(item.id) === Number(binding.workId));
    return `1つの作品「${work?.title || '権限のない作品'}」へ`;
  }
  if (binding.mode === 'by_product') return `商品コードの列「${binding.productColumn}」で作品ごとに分ける`;
  return `作品コードの列「${binding.workColumn}」で作品ごとに分ける${binding.productColumn ? `（商品は列「${binding.productColumn}」で照合）` : ''}`;
}

export const usesResolvedProduct = (binding) => Boolean(binding && binding.mode !== 'single_work' && binding.productColumn);

// 分割の計画。products: [{id, sku, name, channel}]、allocations: [{product_id, work_id, allocation_bps}]、
// works: [{id, project_id, code, title}]、kind: 報告の種類（あれば商品の販路と照らす）、reportWorks: {商品ID: 報告を置く作品ID}。
// 返り値 {partitions:[{workId, projectId, sourceRows, productMap}], unmatched:[{sourceRow, column, value, reason}], errors:[文]}
export function planPartitions({table, binding, products = [], allocations = [], works = [], kind = null, reportWorks = {}}) {
  const errors = [];
  const unmatched = [];
  if (!table?.headers?.length) return {partitions: [], unmatched, errors: ['表の見出しがありません']};
  if (!binding) return {partitions: [], unmatched, errors: ['作品の決め方が決まっていません']};
  const workById = new Map(works.map((work) => [Number(work.id), work]));
  const groups = new Map();
  const add = (workId, row, product = null) => {
    const work = workById.get(Number(workId));
    let group = groups.get(Number(workId));
    if (!group) { group = {workId: Number(workId), projectId: work ? Number(work.project_id) : null, sourceRows: [], products: new Map()}; groups.set(Number(workId), group); }
    group.sourceRows.push(row.sourceRow);
    if (product) {
      const item = group.products.get(product.code) || {code: product.code, productId: product.productId, sku: product.sku, name: product.name, rows: 0, allocations: product.allocations};
      item.rows += 1;
      group.products.set(product.code, item);
    }
  };
  if (binding.mode === 'single_work') {
    if (!workById.has(Number(binding.workId))) return {partitions: [], unmatched, errors: ['割り当てた作品が見つかりません']};
    for (const row of table.rows) add(binding.workId, row);
  } else {
    const needColumns = [binding.mode === 'by_product' ? binding.productColumn : binding.workColumn, binding.mode === 'by_work_column' ? binding.productColumn : null].filter(Boolean);
    for (const column of needColumns) if (!table.headers.includes(column)) errors.push(`列「${column}」が見出しにありません。見出しの行か列の選び方を確かめてください`);
    if (usesResolvedProduct(binding) && table.headers.includes(RESOLVED_PRODUCT_COLUMN)) errors.push(`見出しに「${RESOLVED_PRODUCT_COLUMN}」という列があるため、商品の照合結果を足せません。元のファイルの列名を変えてください`);
    if (errors.length) return {partitions: [], unmatched, errors};
    const productsByCode = new Map();
    for (const product of products) {
      const code = normalizeCode(product.sku);
      if (!code) continue;
      productsByCode.set(code, [...(productsByCode.get(code) || []), product]);
    }
    const sharesOf = (productId) => allocations.filter((row) => Number(row.product_id) === Number(productId)).map((row) => ({workId: Number(row.work_id), bps: Number(row.allocation_bps)})).sort((a, b) => a.workId - b.workId);
    const worksByCode = new Map();
    for (const work of works) {
      const code = normalizeCode(work.code);
      if (code) worksByCode.set(code, [...(worksByCode.get(code) || []), work]);
    }
    // 商品コード → 商品（なければ理由）
    const resolveProduct = (row) => {
      const column = binding.productColumn;
      const raw = row.values[column];
      const code = normalizeCode(raw);
      if (!code) return {problem: {sourceRow: row.sourceRow, column, value: '', reason: '商品コードが空欄です'}};
      const found = productsByCode.get(code) || [];
      if (!found.length) return {problem: {sourceRow: row.sourceRow, column, value: code, reason: '商品マスタにない商品コードです（作品商品マスタで登録してください）'}};
      if (found.length > 1) return {problem: {sourceRow: row.sourceRow, column, value: code, reason: '同じ商品コードに当てはまる商品が複数あります（作品商品マスタの商品コードを確かめてください）'}};
      const product = found[0];
      if (kind && product.channel !== kind) return {problem: {sourceRow: row.sourceRow, column, value: code, reason: `商品の販路（${channelText(product.channel)}）が報告の種類（${channelText(kind)}）と違います`}};
      const shares = sharesOf(product.id);
      if (!shares.length) return {problem: {sourceRow: row.sourceRow, column, value: code, reason: '商品がどの作品にも配賦されていません（作品商品マスタで作品に結び付けてください）'}};
      if (shares.reduce((sum, share) => sum + share.bps, 0) !== 10000) return {problem: {sourceRow: row.sourceRow, column, value: code, reason: '商品の作品配賦が100%になっていません（作品商品マスタを直してください）'}};
      return {product: {code, productId: Number(product.id), sku: product.sku, name: product.name, allocations: shares}};
    };
    for (const row of table.rows) {
      if (binding.mode === 'by_product') {
        const {problem, product} = resolveProduct(row);
        if (problem) { unmatched.push(problem); continue; }
        const override = Number(reportWorks?.[product.productId] ?? reportWorks?.[String(product.productId)] ?? 0);
        const chosen = product.allocations.some((share) => share.workId === override) ? override : [...product.allocations].sort((a, b) => b.bps - a.bps || a.workId - b.workId)[0].workId;
        if (!workById.has(chosen)) { unmatched.push({sourceRow: row.sourceRow, column: binding.productColumn, value: product.code, reason: '商品の配賦先の作品が見つかりません'}); continue; }
        add(chosen, row, product);
        continue;
      }
      const column = binding.workColumn;
      const code = normalizeCode(row.values[column]);
      if (!code) { unmatched.push({sourceRow: row.sourceRow, column, value: '', reason: '作品コードが空欄です'}); continue; }
      const found = worksByCode.get(code) || [];
      if (!found.length) { unmatched.push({sourceRow: row.sourceRow, column, value: code, reason: '作品マスタにない作品コードです（作品商品マスタで登録してください）'}); continue; }
      if (found.length > 1) { unmatched.push({sourceRow: row.sourceRow, column, value: code, reason: '同じ作品コードに当てはまる作品が複数あります（作品マスタの作品コードを確かめてください）'}); continue; }
      const workId = Number(found[0].id);
      if (!binding.productColumn) { add(workId, row); continue; }
      const {problem, product} = resolveProduct(row);
      if (problem) { unmatched.push(problem); continue; }
      if (!product.allocations.some((share) => share.workId === workId)) { unmatched.push({sourceRow: row.sourceRow, column: binding.productColumn, value: product.code, reason: `商品が作品「${code}」に配賦されていません（作品商品マスタで結び付けてください）`}); continue; }
      add(workId, row, product);
    }
  }
  const partitions = [...groups.values()].sort((a, b) => a.workId - b.workId).map((group) => ({
    workId: group.workId, projectId: group.projectId, sourceRows: group.sourceRows,
    productMap: [...group.products.values()].sort((a, b) => a.code.localeCompare(b.code)),
  }));
  return {partitions, unmatched, errors};
}

// 分け方の照合値の元（同じ分け方なら同じ文字列）。sha256 は呼び出し側で取る。
// 商品の作品配賦（作品と率）も含める: 分けたあとで配賦が変われば別の分け方になり、分け直すと今の配賦の写しで分割を作り直す
// （古い写しの分割を使い続けて、権限の確認や照合の根拠が今の配賦とずれないように）。
export function planKey(binding, partitions) {
  return JSON.stringify({
    mode: binding.mode, workId: binding.workId ?? null, productColumn: binding.productColumn ?? null, workColumn: binding.workColumn ?? null,
    partitions: partitions.map((partition) => ({workId: partition.workId, sourceRows: partition.sourceRows, products: (partition.productMap || []).map((item) => [item.code, item.productId, allocationKey(item.allocations)])})),
  });
}

// 配賦の比較用の文字列（作品IDの順）。[{workId, bps}] → "1:5000,4:5000"
export function allocationKey(allocations = []) {
  return [...(allocations || [])].map((share) => [Number(share.workId), Number(share.bps)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([workId, bps]) => `${workId}:${bps}`).join(',');
}

// 分割後の表（CSV）。商品を照合する割り当てでは右端に「商品ID（照合）」を足す。
// 1つの作品への割り当ては、選択版の表そのもの（ハッシュも同じ）になる。
export function partitionCsv(table, partition, binding) {
  const rowsBySource = new Map(table.rows.map((row) => [row.sourceRow, row]));
  const resolved = usesResolvedProduct(binding);
  const byCode = new Map((partition.productMap || []).map((item) => [item.code, item.productId]));
  const headers = resolved ? [...table.headers, RESOLVED_PRODUCT_COLUMN] : [...table.headers];
  const body = partition.sourceRows.map((sourceRow) => {
    const row = rowsBySource.get(Number(sourceRow));
    if (!row) throw new Error(`${sourceRow}行目が表の選択にありません`);
    if (!resolved) return row.cells;
    const productId = byCode.get(normalizeCode(row.values[binding.productColumn]));
    if (!productId) throw new Error(`${sourceRow}行目の商品が分割の記録にありません`);
    return [...row.cells, String(productId)];
  });
  return {headers, csv: toCsvText([headers, ...body]), sourceRowNumbers: partition.sourceRows.map(Number)};
}

// 登録の進み具合（画面の表示用）。partitions: [{committed}]
export function commitProgress(partitions = []) {
  const total = partitions.length;
  const committed = partitions.filter((item) => item.committed).length;
  return {total, committed, remaining: total - committed, started: committed > 0, complete: total > 0 && committed === total,
    label: total <= 1 ? (committed ? '登録済み' : '未登録') : `${total}作品中${committed}作品を登録済み`};
}

// 見出しから、分けるのに使う列の候補（なければ null）。推測で決めず、画面で確かめてもらう初期値にだけ使う。
export function guessSplitColumn(headers = [], kind = 'product') {
  const list = (headers || []).map(String);
  const patterns = kind === 'work'
    ? [/^作品\s*(コード|ｺｰﾄﾞ|CD|番号|ID)$/i, /作品.*(コード|ｺｰﾄﾞ|CD)/i, /^(タイトル|title)\s*(コード|ｺｰﾄﾞ|CD|code)$/i, /work\s*code/i]
    : [/^商品\s*(コード|ｺｰﾄﾞ|CD|番号|ID)$/i, /商品.*(コード|ｺｰﾄﾞ|CD)/i, /^(SKU|品番)$/i, /sku|product\s*code/i];
  for (const pattern of patterns) {
    const found = list.find((header) => pattern.test(header.normalize('NFKC')));
    if (found) return found;
  }
  return null;
}
