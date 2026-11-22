import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSourceTree} from '../src/source-documents/source-tree-model.mjs';

const doc = (id, location, fileName, linkedCount = 0) => ({id, location, fileName, linkedCount});

test('currentだけを外してORG・業務・作品・子フォルダ・原本の木を作り、件数と未を子から集める', () => {
  const items = [doc(1, 'current/ORG/F22/架空作品/資料/z.pdf', 'z.pdf'),
    doc(2, 'current/ORG/F01/架空作品/資料/b.pdf', 'b.pdf', 2),
    doc(3, 'current/ORG/F01/架空作品/資料/a.pdf', 'a.pdf')];
  const before = JSON.stringify(items);
  const tree = buildSourceTree(items);
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(tree.map((n) => [n.name, n.count, n.unlinkedCount]), [['ORG', 3, 2]]);
  assert.deepEqual(tree[0].children.map((n) => n.name), ['F01', 'F22']);
  const work = tree[0].children[0].children[0];
  assert.equal(work.name, '架空作品');
  assert.equal(work.children[0].name, '資料');
  assert.deepEqual(work.children[0].children.map((n) => [n.name, n.document.id]), [['a.pdf', 3], ['b.pdf', 2]]);
});

test('NFCで名前を揃えて並べ、同名原本を落とさず、場所なしは専用の枝に分ける', () => {
  const tree = buildSourceTree([doc(1, 'current/ORG/カ\u3099/a.pdf', 'a.pdf'),
    doc(2, 'current/ORG/ガ/a.pdf', 'a.pdf', 1), doc(3, null, 'b.pdf'), doc(4, null, 'a.pdf'),
    doc(5, 'current/場所なし/a.pdf', 'a.pdf'), doc(6, 'archive/current/x.pdf', 'x.pdf')]);
  const org = tree.find((n) => n.name === 'ORG');
  assert.equal(org.children.length, 1);
  assert.equal(org.children[0].name, 'ガ');
  assert.deepEqual(org.children[0].children.map((n) => n.document.id), [1, 2]);
  const missing = tree.find((n) => n.id === 'unlocated');
  assert.equal(missing.name, '場所なし');
  assert.deepEqual(missing.children.map((n) => n.document.id), [4, 3]);
  assert.equal(missing.unlinkedCount, 2);
  assert.equal(tree.find((n) => n.name === 'archive').children[0].name, 'current');
  assert.equal(new Set(tree.map((n) => n.id)).size, tree.length);
  assert.deepEqual(buildSourceTree([]), []);
});
