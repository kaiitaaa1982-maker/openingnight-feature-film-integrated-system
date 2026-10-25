import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computeTrial, deckBoard, normalizeTrialInput, readiness, templateTrial, DECK_PAGES, addMonths} from '../src/planning/kikaku/kikaku-model.mjs';

// 正解表は、会社ルートの売上試算の3段の型（架空のデータ）を Excel で再計算した値。実装の関数を使わずに抜き出した
const golden = JSON.parse(readFileSync(new URL('./fixtures/kikaku/trial-3dan.json', import.meta.url), 'utf8'));

test('FR-PLAN-KIKAKU-010 試算の計算が、Excel で再計算した3段の型と行ごと・案ごとに一致する', () => {
  const r = computeTrial(golden);
  golden.lines.forEach((line, i) => {
    for (const s of ['even', 'good', 'max']) assert.equal(r.rows[i].result[s].income, line.expected[s], `${line.partnerName} ${s}`);
  });
  for (const s of ['even', 'good', 'max']) {
    assert.equal(r.totals[s].income, golden.expected[s].income, `${s} の権利元収入`);
    assert.equal(r.totals[s].creator, golden.expected[s].creator, `${s} の作り手への印税`);
    assert.equal(r.totals[s].breakEvenMonth, golden.expected[s].breakEvenMonth, `${s} の ±0 の月`);
  }
});

test('FR-PLAN-KIKAKU-010 流通の大別の合計は詳細の合計と一致し、控除＝売上−作り手への印税−権利元収入', () => {
  const r = computeTrial(golden);
  for (const s of ['even', 'good', 'max']) {
    assert.equal(r.groups.reduce((a, g) => a + g[s].income, 0), r.rows.reduce((a, row) => a + row.result[s].income, 0));
    for (const g of r.groups) assert.equal(g[s].deduction, g[s].sale - g[s].creator - g[s].income);
  }
});

test('FR-PLAN-KIKAKU-011 率を変えると結果が変わる（手数料の根拠の数字は版ごとに変えられる）', () => {
  const base = computeTrial(golden).totals.good.income;
  const rates = golden.rates.map((r) => (r.typeCode === 'THEA' ? {...r, feeBps: 3000} : r));
  assert.ok(computeTrial({...golden, rates}).totals.good.income < base);
});

test('FR-PLAN-KIKAKU-012 出資の後で累計が0以上になる最初の月を ±0 の月にし、届かなければ null', () => {
  const r = computeTrial({costTotalYen: 1000, firstMonth: '2027-01', rates: [], investments: [{month: '2027-01', amountYen: 1000}],
    lines: [{typeCode: 'SVOD', partnerName: 'A', startMonth: '2027-03', months: 1, calc: 'fixed', unitPriceYen: 0, evenValue: 0, goodValue: 2000, maxValue: 2000}]});
  assert.equal(r.totals.good.breakEvenMonth, '2027-03');
  assert.equal(r.totals.even.breakEvenMonth, null);
});

test('FR-PLAN-KIKAKU-013 試算の入力の検査: 単価×数量の行に単価が無い・率の和が100%超・月の形の誤りを断る', () => {
  const bad = normalizeTrialInput({costTotalYen: 1, firstMonth: '2027-13', reason: 'x',
    rates: [{typeCode: 'THEA', shareBps: 0, feeBps: 6000, originalBps: 3000, creatorBps: 2000, unitCostYen: 0}],
    lines: [{typeCode: 'TVOD', partnerName: 'A', startMonth: '2027-01', months: 1, calc: 'unit', unitPriceYen: 0, evenValue: 0, goodValue: 1, maxValue: 1}]});
  const fields = bad.errors.map((e) => e.field);
  assert.ok(fields.includes('firstMonth'));
  assert.ok(fields.includes('rates.0'));
  assert.ok(fields.includes('lines.0.unitPriceYen'));
  assert.ok(normalizeTrialInput(templateTrial({costTotalYen: 1000, firstMonth: '2027-01'})).ok);
});

test('FR-PLAN-KIKAKU-020 4つの揃い: 欠けたものの名前を出し、全部揃うと最後に揃った日を doneOn にする。見送りは見送り', () => {
  const none = readiness({});
  assert.equal(none.state, 'not_started');
  assert.equal(none.verdict, '! 残り4: 企画書の提出版・試算・予算書・判断');
  const all = readiness({documents: [{kind: 'deck', role: 'submitted', submittedOn: '2027-01-10'}], trialVersions: [{createdAt: '2027-01-05 10:00:00'}],
    budgetFixed: {fixedOn: '2027-01-20'}, approvals: [{status: 'approved', at: '2027-01-25 09:00:00'}]});
  assert.equal(all.state, 'done');
  assert.equal(all.doneOn, '2027-01-25');
  assert.equal(readiness({stageCode: 'declined'}).state, 'declined');
  const stage = readiness({stageCode: 'contracted', stageEnteredOn: '2027-02-01'});
  assert.equal(stage.marks.find((m) => m.key === 'decision').done, true);
});

test('FR-PLAN-KIKAKU-030 準備ボード: 確定した事実のあるページだけが確定。下書きは下書き。差し替えた行は数えない', () => {
  const facts = [
    {id: 1, pages: '3,12', state: 'ai_draft', previousId: null},
    {id: 2, pages: '3,12', state: 'human_confirmed', previousId: 1},
    {id: 3, pages: '16', state: 'ai_draft', previousId: null},
  ];
  const b = deckBoard({facts, hasTrial: true, materialCount: 2});
  const page = (no) => b.pages.find((p) => p.no === no);
  assert.equal(page(3).state, 'confirmed');
  assert.equal(page(16).state, 'draft');
  assert.equal(page(1).state, 'auto');
  assert.equal(page(27).state, 'confirmed');
  assert.equal(page(18).gap, true);
  assert.equal(b.counts.drafts, 1);
  assert.equal(b.counts.confirmed, 1);
  assert.equal(DECK_PAGES.length, 32);
  assert.equal(deckBoard({facts: []}).pages.find((p) => p.no === 27).state, 'none');
});

test('月の足し算', () => {
  assert.equal(addMonths('2027-11', 3), '2028-02');
  assert.equal(addMonths('2027-01', -1), '2026-12');
});
