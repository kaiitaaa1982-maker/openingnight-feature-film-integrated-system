import test from 'node:test';
import assert from 'node:assert/strict';
import {createUnsavedStore, shouldBlock, unsavedMessage, beforeUnloadHandler} from '../src/shell/unsaved.mjs';

test('unsaved registrations add up and clear per id', () => {
  const store = createUnsavedStore();
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  store.register('grid', 2, '売上の表編集');
  store.register('form', 1, '新規登録の入力');
  store.register('form', 1, '新規登録の入力');
  assert.equal(store.total(), 3);
  assert.equal(notified, 2);
  assert.equal(unsavedMessage(store.getSnapshot()), '未保存の変更が3件あります（売上の表編集 2件、新規登録の入力 1件）');
  store.register('grid', 0);
  assert.equal(store.total(), 1);
  store.clear();
  assert.equal(store.total(), 0);
  assert.equal(shouldBlock(store.total()), false);
  assert.equal(unsavedMessage(store.getSnapshot()), '');
});

test('beforeunload asks only while changes are unsaved', () => {
  let total = 0;
  const handler = beforeUnloadHandler(() => total);
  const event = {prevented: false, preventDefault() { this.prevented = true; }, returnValue: undefined};
  handler(event);
  assert.equal(event.prevented, false);
  total = 1;
  handler(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, '');
});
