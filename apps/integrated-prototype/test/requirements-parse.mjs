// 工程の要件（docs/requirements/<領域>/<工程>.md）の機能要件の表を読む道具。
// test/requirements-trace.test.mjs（番号のつながりの検査）と scripts/metrics.mjs（FR の状態の件数）が使う。
// 決まりの正本は docs/rules/requirements.md。

export const DOMAIN_CODES = {planning: 'PLAN', production: 'PROD', sales: 'SALES', publicity: 'PUB', revenue: 'REV',
  expenses: 'EXP', settlement: 'SETL', accounting: 'ACCT', ledger: 'LEDG', core: 'CORE', admin: 'ADMIN'};
export const STATES = new Set(['テスト', '画面', '未検証', '廃止']);
const ID = '(?<![A-Za-z0-9-])FR-[A-Z]+-[A-Z]+-\\d{3}(?![A-Za-z0-9])';
export const idsIn = text => new Set(text.match(new RegExp(ID, 'g')) || []);

const unquote = v => v.trim().replace(/^(['"])(.*)\1$/, '$2');

export function frontmatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(text);
  if (!m) return null;
  return Object.fromEntries(m[1].split(/\r?\n/).map(l => /^([A-Za-z_]+):\s*(.*)$/.exec(l)).filter(Boolean).map(x => [x[1], unquote(x[2])]));
}

// 「## 機能要件」の節の表の行を読む（コードブロックの中は読まない）。
// FR 番号を含む表の行が4列として読めない・全角の ｜ で区切っているときは問題として返す。
// ほかの節（テストの穴・要確認など）で番号を書くのはよいが、その番号は機能要件の表に無ければならない（problems が見る）
export function parseRequirements(text, file = '') {
  const rows = [];
  const broken = [];
  const start = text.search(/^##\s*機能要件\s*$/m);
  if (start < 0) return {rows, broken: [`${file}: 「## 機能要件」の節が無い`]};
  const rest = text.slice(start).replace(/^##[^\n]*\n/, '');
  const end = rest.search(/^##\s/m);
  const section = end < 0 ? rest : rest.slice(0, end);
  let fenced = false;
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || !new RegExp(ID).test(line)) continue;
    if (line.startsWith('｜')) { broken.push(`${file}: 全角の ｜ で区切った行（半角の | にする）: ${line.slice(0, 60)}`); continue; }
    if (!line.startsWith('|')) continue;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());
    const id = (cells[0] || '').replace(/[`*]/g, '');
    if (!new RegExp(`^${ID}$`).test(id)) continue;
    if (cells.length !== 4) { broken.push(`${file}: 4列でない機能要件の行: ${line.slice(0, 60)}`); continue; }
    rows.push({id, text: cells[1], state: cells[2], where: cells[3], file});
  }
  return {rows, broken};
}
