// 支払う MG（買付分）の回収の計算の試験。要件は docs/requirements/planning/rights-acquisition.md の
// FR-PLAN-ACQ-009〜014・040・045〜048、計画は会社ルートの plans/2026-10-22-folder-mg-buy.md（仮説 H1〜H4、検査1〜3・6〜8）。
// 期待値は test/fixtures/acq-mg-recoup/cases.json に手で計算して書いた（実装の関数を使わない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {computeRecoup, recoupIncrement, largestRemainder} from '../src/acquisition/acq-mg-recoup.mjs';

const {cases} = JSON.parse(readFileSync(new URL('./fixtures/acq-mg-recoup/cases.json', import.meta.url), 'utf8'));

for (const c of cases) {
  test(c.name, () => {
    const r = computeRecoup({term: c.term, lines: c.lines, expenses: c.expenses ?? [], asOfMonth: c.asOfMonth});
    const e = c.expected;
    for (const key of ['status', 'deducted', 'base', 'recouped', 'balance', 'overage', 'distribution', 'statementAllowed']) {
      if (key in e) assert.equal(r[key], e[key], key);
    }
    if (e.works) assert.deepEqual(Object.fromEntries(r.works.map((w) => [w.workId, w.distribution])), e.works);
    if (e.media) {
      for (const [media, want] of Object.entries(e.media)) {
        const got = r.media.find((m) => m.media === media);
        assert.ok(got, media);
        assert.equal(got.recouped, want.recouped, `${media} recouped`);
        assert.equal(got.overage, want.overage, `${media} overage`);
      }
    }
    if (e.exceptionKinds) assert.deepEqual([...new Set(r.exceptions.map((x) => x.kind))].sort(), [...e.exceptionKinds].sort());
    const failed = r.checks.filter((x) => !x.ok).map((x) => x.key).sort();
    assert.deepEqual(failed, [...(e.failedChecks ?? [])].sort(), 'checks');
  });
}

test('当期の増分: 前回の締めとの差が、消化の仕訳と作品ごとの分配額の増分になる（約束 F-2、FR-PLAN-ACQ-047）', () => {
  const c = cases.find((x) => x.name.startsWith('シナリオ17 後半'));
  const june = computeRecoup({term: c.term, lines: c.lines, asOfMonth: '2026-06'});
  const july = computeRecoup({term: c.term, lines: c.lines, asOfMonth: '2026-07'});
  assert.deepEqual(recoupIncrement(june, july), {recouped: 2000, distribution: 3000, works: [{workId: 'X', distribution: 2727}, {workId: 'Y', distribution: 273}]});
  assert.deepEqual(recoupIncrement(null, june), {recouped: 28000, distribution: 0, works: [{workId: 'X', distribution: 0}, {workId: 'Y', distribution: 0}]});
});

test('最大剰余法: 和が total に一致し、剰余が同じなら先の並びに配る', () => {
  assert.deepEqual(largestRemainder(3000, [30000, 3000]), [2727, 273]);
  assert.deepEqual(largestRemainder(1, [1, 1]), [1, 0]);
  assert.deepEqual(largestRemainder(0, [5, 5]), [0, 0]);
  assert.deepEqual(largestRemainder(7, [0, 0]), [0, 0]);
});

test('条件版の誤りは計算せずに止める', () => {
  const base = {consideration: 'mg', mgAmount: 30000, recoupBasis: 'platform_net', overageEnabled: true, overageRateBps: 10000, works: [{workId: 'W1'}]};
  const run = (term, lines = []) => computeRecoup({term, lines, asOfMonth: '2026-06'});
  assert.throws(() => run({...base, currency: 'USD'}), /外貨/);
  assert.throws(() => run({...base, recoupBasis: 'after_fee'}), /手数料の率/);
  assert.throws(() => run({...base, overageRateBps: undefined}), /超過後の分配の率/);
  assert.throws(() => run({...base, multiWork: 'hold_until_total', works: [{workId: 'X'}, {workId: 'Y'}]}), /約束の根拠/);
  assert.throws(() => run({...base, works: [{workId: 'X'}, {workId: 'Y'}]}), /single/);
  assert.throws(() => run({...base, pooling: 'per_media'}), /配分が1件以上/);
  assert.throws(() => run({...base, mgAmount: 1.5}), /MG の額/);
  const line = {saleId: 'S1', workId: 'W1', media: 'rs', accountingMonth: '2026-06', amountExTax: 100};
  assert.throws(() => run(base, [line, line]), /同じ売上明細/);
  assert.throws(() => computeRecoup({term: base, lines: [], asOfMonth: '2026-6'}), /締め月/);
});
