import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appliedRules, approvalState, cardsFromExtraction, cardsFromReview, editCard, hasProvenance, markCounts, markState,
  openMarks, pageBoxes, pageSummary, reviewPayload, setChecked, uncheckedMarks,
} from '../src/production/script-structuring/script-structuring-model.mjs';

// 架空の台本の読み取り（workflow-extractor-4 の形）。8-1 は読めた値だけ、8-3 は「同・」で場所と昼夜を補った、8-4 は昼夜が読めない
const read = (reason = null) => ({status: 'read', reason});
const extraction = {
  scriptMeta: {rulesApplied: [
    {id: 'same-place', label: '「同・」は直前の場所の続きとして補った', count: 1},
    {id: 'inherit-day-night', label: '「同・」の柱に昼夜が無いときは、直前のシーンの昼夜を引き継いだ', count: 1},
    {id: 'order-number', label: '番号の無い柱に、順番で番号を振った', count: 0},
    {id: 'broken', count: 2},
  ]},
  scenes: [
    {sceneNo: '8-1', location: '駅前（実景）', dayNight: 'N', cast: [], synopsis: '終電間際の駅前。', pageEighths: 2, reviewNotes: [],
      source: {page: 3, box: {left: 0.7, top: 0.1, width: 0.04, height: 0.3}},
      fields: {sceneNo: read('柱の番号'), location: read(), dayNight: read('柱の末尾の時間帯'), cast: read('セリフの話者がいない'), pageEighths: read('柱から次の柱までの列の数で計算')}},
    {sceneNo: '8-3', location: 'ふくろう堂・奥の書庫', dayNight: 'N', cast: ['千尋', '蓮見'], synopsis: '千尋が古い貸出台帳をめくる。', pageEighths: 4, reviewNotes: [],
      source: {page: 3, box: {left: 0.25, top: 0.1, width: 0.04, height: 0.2}},
      fields: {sceneNo: read('柱の番号'), location: {status: 'inferred', reason: '「同・」を直前の場所「ふくろう堂・店内」で補った'},
        dayNight: {status: 'inferred', reason: '柱に昼夜が無いので、直前のシーン（8-2）の昼夜を引き継いだ'}, cast: read('セリフの話者から（ト書きだけの人物は入らない）'), pageEighths: read('柱から次の柱までの列の数で計算')}},
    {sceneNo: '8-4', location: '千尋の部屋', dayNight: null, cast: ['千尋'], synopsis: '', pageEighths: 3, reviewNotes: ['場所の文字が化けている疑いがあります'],
      source: {page: 4, box: {left: 0.8, top: 0.1, width: 0.04, height: 0.2}},
      fields: {sceneNo: read('柱の番号'), location: read(), dayNight: {status: 'missing', reason: '柱に昼夜が無い'}, cast: read('セリフの話者から（ト書きだけの人物は入らない）'), pageEighths: read('柱から次の柱までの列の数で計算')}},
  ],
};

test('FR-PROD-STRUCT-006 補った値と読めない値は、確かめるか直すまで承認できない', () => {
  let cards = cardsFromExtraction(extraction);
  const first = approvalState(cards, extraction);
  assert.equal(first.canApprove, false);
  assert.deepEqual(first.open.map((m) => `${m.sceneNo}:${m.key}:${m.status}`), ['8-3:location:inferred', '8-3:dayNight:inferred', '8-4:dayNight:missing']);
  assert.equal(first.open[0].reason, '「同・」を直前の場所「ふくろう堂・店内」で補った');

  // 場所を確かめた（値はそのまま）
  cards = cards.map((c, i) => (i === 1 ? setChecked(c, 'location', true) : c));
  assert.equal(markState(cards[1], 'location', extraction), 'checked');
  // 昼夜を直した（夜→夕）。直した値そのものが人の確かめになる
  cards = cards.map((c, i) => (i === 1 ? editCard(c, 'dayNight', 'DN') : c));
  assert.equal(markState(cards[1], 'dayNight', extraction), 'edited');
  // 読めない昼夜は、空のまま確かめてもよい（推測で埋めさせない）
  cards = cards.map((c, i) => (i === 2 ? setChecked(c, 'dayNight', true) : c));
  const last = approvalState(cards, extraction);
  assert.deepEqual(last.open, []);
  assert.equal(last.canApprove, true);
  assert.deepEqual(markCounts(cards, extraction), {inferred: 2, missing: 1, open: 0, resolved: 3});

  // 直した値を読み取りの値に戻すと、確かめていない印に戻る（直したことにならない）
  const back = cards.map((c, i) => (i === 1 ? editCard(c, 'dayNight', 'N') : c));
  assert.deepEqual(openMarks(back, extraction).map((m) => `${m.sceneNo}:${m.key}`), ['8-3:dayNight']);
  // 受け口の数え方も同じ
  assert.deepEqual(uncheckedMarks(extraction, reviewPayload(back)), [{sceneNo: '8-3', field: 'dayNight'}]);
  // 確かめた印を外すと、また承認できなくなる
  const unchecked = cards.map((c, i) => (i === 2 ? setChecked(c, 'dayNight', false) : c));
  assert.equal(approvalState(unchecked, extraction).canApprove, false);
  // シーンが0件なら承認できない
  assert.equal(approvalState([], extraction).canApprove, false);
});

test('FR-PROD-STRUCT-006 状態が「読めた」でない項目は、知らない状態でも印を付け、補った値として数えて確かめるまで承認させない', () => {
  // 読み取りの版の違いや壊れた JSON で、知らない状態（guessed）・状態の無い項目が来た
  const odd = {scenes: [{...extraction.scenes[0], fields: {...extraction.scenes[0].fields, location: {status: 'guessed', reason: '新しい決まり'}, cast: {reason: '状態が無い'}}}]};
  let cards = cardsFromExtraction(odd);
  assert.deepEqual(openMarks(cards, odd).map((m) => `${m.key}:${m.status}`), ['location:inferred', 'cast:inferred']);
  assert.deepEqual(markCounts(cards, odd), {inferred: 2, missing: 0, open: 2, resolved: 0});
  assert.equal(approvalState(cards, odd).canApprove, false);
  assert.deepEqual(uncheckedMarks(odd, reviewPayload(cards)), [{sceneNo: '8-1', field: 'location'}, {sceneNo: '8-1', field: 'cast'}]);
  assert.equal(pageBoxes(cards, odd, 3)[0].tone, 'open');
  cards = cards.map((c) => setChecked(setChecked(c, 'location', true), 'cast', true));
  assert.equal(approvalState(cards, odd).canApprove, true);
  // 項目そのものが無い（テキストの原本の頁）ときは印を付けない
  const noPage = {scenes: [{...extraction.scenes[0], fields: Object.fromEntries(Object.entries(extraction.scenes[0].fields).filter(([key]) => key !== 'pageEighths'))}]};
  assert.deepEqual(openMarks(cardsFromExtraction(noPage), noPage), []);
});

test('FR-PROD-STRUCT-006 前の読み取り（出どころの無い版）と人が足したシーンには印を付けない', () => {
  const legacy = {scenes: [{sceneNo: 'S1', location: '港', dayNight: null, cast: []}]};
  assert.equal(hasProvenance(legacy), false);
  assert.equal(hasProvenance(extraction), true);
  assert.equal(approvalState(cardsFromExtraction(legacy), legacy).canApprove, true);
  const added = [...cardsFromExtraction(extraction).map((c) => ({...c, checked: ['location', 'dayNight']})), {sceneNo: '8-9', location: '', dayNight: null, cast: [], extractionIndex: null, checked: []}];
  assert.deepEqual(openMarks(added, extraction).map((m) => m.sceneNo), []);
});

test('FR-PROD-STRUCT-008 確認済みの版に、読み取りとの結び付きと確かめた項目を残し、開き直すと戻る', () => {
  const cards = cardsFromExtraction(extraction).map((c, i) => (i === 1 ? setChecked(setChecked(c, 'dayNight', true), 'location', true) : c));
  const payload = reviewPayload([...cards, {sceneNo: '8-9', location: '倉庫', dayNight: 'D', cast: ['透'], synopsis: '', estimatedMinutes: '', pageEighths: '', extractionIndex: null, checked: ['bogus', 'location']}]);
  assert.deepEqual(payload[1], {sceneNo: '8-3', location: 'ふくろう堂・奥の書庫', dayNight: 'N', cast: ['千尋', '蓮見'], synopsis: '千尋が古い貸出台帳をめくる。', estimatedMinutes: null, pageEighths: 4, extractionIndex: 1, checked: ['location', 'dayNight']});
  assert.deepEqual(payload[3], {sceneNo: '8-9', location: '倉庫', dayNight: 'D', cast: ['透'], synopsis: '', estimatedMinutes: null, pageEighths: null, extractionIndex: null, checked: ['location']});
  // 受け口が保存した形（sourceIndex つき）から開き直す
  const saved = payload.map((s, i) => ({...s, sourceIndex: i}));
  const reopened = cardsFromReview(saved, extraction);
  assert.deepEqual(reopened[1].checked, ['location', 'dayNight']);
  assert.equal(reopened[1].extractionIndex, 1);
  assert.equal('sourceIndex' in reopened[1], false);
  assert.deepEqual(reopened[2].reviewNotes, ['場所の文字が化けている疑いがあります']);
  assert.equal(markState(reopened[1], 'location', extraction), 'checked');
  // この画面より前の版（結び付きの無い版）は、シーン番号が1つだけ一致する読み取りのシーンに結び付ける
  const legacy = cardsFromReview([{sceneNo: '8-3', location: 'ふくろう堂・奥の書庫', dayNight: 'N', cast: [], sourceIndex: 0}, {sceneNo: '8-9', location: '倉庫', dayNight: null, cast: [], sourceIndex: 1}], extraction);
  assert.deepEqual(legacy.map((c) => c.extractionIndex), [1, null]);
  assert.deepEqual(openMarks(legacy, extraction).map((m) => `${m.sceneNo}:${m.key}`), ['8-3:location', '8-3:dayNight']);
  // 結び付きを外した版（null を送った版）と、同じシーン番号が2つある読み取りには結び付けない
  assert.equal(cardsFromReview([{sceneNo: '8-3', extractionIndex: null}], extraction)[0].extractionIndex, null);
  const twice = {scenes: [extraction.scenes[1], extraction.scenes[1]]};
  assert.equal(cardsFromReview([{sceneNo: '8-3'}], twice)[0].extractionIndex, null);
});

test('FR-PROD-STRUCT-009 読み取りが当てた変換の決まりのうち、数のあるものだけを出す', () => {
  assert.deepEqual(appliedRules(extraction).map((r) => `${r.id}:${r.count}`), ['same-place:1', 'inherit-day-night:1']);
  assert.deepEqual(appliedRules({scriptMeta: {}}), []);
  assert.deepEqual(appliedRules(null), []);
});

test('柱の枠は頁ごとに出し、確かめていない印・確かめ済み・印なしを分ける', () => {
  let cards = cardsFromExtraction(extraction);
  assert.deepEqual(pageBoxes(cards, extraction, 3).map((b) => `${b.sceneNo}:${b.tone}`), ['8-1:read', '8-3:open']);
  assert.deepEqual(pageBoxes(cards, extraction, 4).map((b) => `${b.sceneNo}:${b.tone}`), ['8-4:open']);
  cards = cards.map((c, i) => (i === 1 ? setChecked(setChecked(c, 'location', true), 'dayNight', true) : c));
  assert.deepEqual(pageBoxes(cards, extraction, 3).map((b) => `${b.sceneNo}:${b.tone}`), ['8-1:read', '8-3:done']);
  // 割合の外の枠（壊れた出どころ）は描かない
  const broken = {scenes: [{...extraction.scenes[0], source: {page: 3, box: {left: 1.2, top: 0, width: 0.1, height: 0.1}}}]};
  assert.deepEqual(pageBoxes(cardsFromExtraction(broken), broken, 3), []);
  assert.deepEqual(pageSummary(cards, extraction, 4).map((p) => `${p.page}:${p.scenes}:${p.open}`), ['1:0:0', '2:0:0', '3:2:0', '4:1:1']);
});
