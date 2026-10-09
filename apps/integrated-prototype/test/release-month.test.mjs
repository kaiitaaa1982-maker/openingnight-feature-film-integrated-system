import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseMonthGroups, shiftMonth} from '../src/sales/release-month-model.mjs';

test('release month view: starting, ending, continuing, undated and withdrawn are separated', () => {
  const rows = [
    {key: 'a', work_title: '作品A', release_on: '2026-10-01', sales_end_on: null, status: 'confirmed'},
    {key: 'b', work_title: '作品B', release_on: '2026-06-01', sales_end_on: '2026-10-31', status: 'confirmed'},
    {key: 'c', work_title: '作品C', release_on: '2026-05-01', sales_end_on: '2027-03-31', status: 'draft'},
    {key: 'd', work_title: '作品D', release_on: null, sales_end_on: null, status: 'draft'},
    {key: 'e', work_title: '作品E', release_on: '2026-10-15', sales_end_on: null, status: 'withdrawn'},
    {key: 'f', work_title: '作品F', release_on: '2026-11-01', sales_end_on: null, status: 'confirmed'},
  ];
  const g = releaseMonthGroups(rows, '2026-10');
  assert.deepEqual(g.starting.map((r) => r.key), ['a']);
  assert.deepEqual(g.ending.map((r) => r.key), ['b']);
  assert.deepEqual(g.continuing.map((r) => r.key), ['c'], 'B ends inside October, so it is only in the ending group');
  assert.deepEqual(g.undated.map((r) => r.key), ['d']);
  assert.equal(g.withdrawn, 1);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2027-01', -1), '2026-12');
});
