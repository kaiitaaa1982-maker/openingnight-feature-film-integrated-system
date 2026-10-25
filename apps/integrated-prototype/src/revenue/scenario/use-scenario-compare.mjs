// シナリオの比較（段A）の画面の状態（ScenarioCompare.jsx が使う React の hook。DOM には触れない）。
// 流れ: 最初の読み込み（年度の設定と、商談の一覧・作品→稼ぎ方の対応）→ 入力（form）→ 要求の本文 → 止まってから計算 → 表示中の応答 → data-ready の判定。
// - 値は保存しない。入力から毎回、要求の本文を作って POST /api/revenue/scenarios/compare に送り、応答を描く（目標額は form にだけ持つ）
// - hash（data-ready の印）は、画面が読んだ応答の sourceHash と一致したときだけ返す。送信中・誤り・入力が変わったあと（表示中の応答が今の入力のものでない）は null
//   （判定は scenario-view-model.mjs の readyHash。この hook の配線は test/scenario-compare-ui.test.mjs が、本物の React で入力を変えて確かめる）
import {useCallback, useEffect, useMemo, useState} from 'react';
import {currentYm, fiscalSettingFrom} from '../../ui/condition-model.mjs';
import {initialForm, buildCompareRequest, requestSignature, withDiscovery, addToCustom, removeFromCustom} from './scenario-form-model.mjs';
import {readyHash, scenarioKeys} from './scenario-view-model.mjs';

// 入力が止まってから計算し直すまでの待ち（ミリ秒）。スライダーを動かすたびに送らない
export const DEBOUNCE_MS = 350;
export const COMPARE_PATH = '/revenue/scenarios/compare';
const ALL_VISIBLE = Object.freeze({standard: true, optimistic: true, pessimistic: true, custom: true});

export function useScenarioCompare({request, debounceMs = DEBOUNCE_MS}) {
  const [form, setForm] = useState(null);
  const [bootError, setBootError] = useState(null);
  const [boot, setBoot] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [renderedHash, setRenderedHash] = useState(null);
  const [visible, setVisible] = useState(ALL_VISIBLE);

  // 最初の読み込み: 年度の設定（期間の既定）と、商談の一覧・作品→稼ぎ方の対応（商談ごとの指定の既定）。
  // 商談の一覧は要求の応答（opportunityList・workSources）にあるので、商談を指定しない要求を1本送って読む（この応答は描かない）
  useEffect(() => {
    let live = true;
    setBootError(null);
    (async () => {
      try {
        const month = currentYm();
        const seed = initialForm({currentMonth: month});
        const discoveryBody = buildCompareRequest(seed).body;
        const [fiscal, discovery] = await Promise.all([
          request('/settings/fiscal').then(fiscalSettingFrom, () => fiscalSettingFrom(null)),
          request(COMPARE_PATH, {method: 'POST', body: discoveryBody}),
        ]);
        if (!live) return;
        setForm(withDiscovery(initialForm({currentMonth: month, fiscalStartMonth: fiscal.fiscalStartMonth}), discovery));
      } catch (cause) {
        if (live) setBootError(cause);
      }
    })();
    return () => { live = false; };
  }, [request, boot]);

  const built = useMemo(() => (form ? buildCompareRequest(form) : null), [form]);
  const signature = built?.ok ? requestSignature(built.body) : null;
  const shownSignature = shown?.signature ?? null;

  // 入力が変わったら、止まってから計算し直す。前の要求は取り消し、古い応答が新しい入力の画面に出ないようにする
  useEffect(() => {
    if (!built) return undefined;
    if (!built.ok || shownSignature === signature) {
      setLoading(false);
      if (built.ok) setError(null);
      return undefined;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await request(COMPARE_PATH, {method: 'POST', body: built.body, signal: controller.signal});
        if (controller.signal.aborted) return;
        setShown({response, signature});
        setError(null);
        setLoading(false);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause);
        setLoading(false);
      }
    }, shownSignature === null ? 0 : debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [signature, shownSignature, request, attempt, debounceMs]);

  // 応答を描き終えたあとに、画面が読んだ応答の hash を覚える（data-ready の判定に使う）
  useEffect(() => {
    setRenderedHash(shown?.response.sourceHash ?? null);
  }, [shown]);

  // 最初の読み込みの失敗は読み直し、計算の失敗は同じ入力でもう一度送る
  const retryBoot = useCallback(() => setBoot((n) => n + 1), []);
  const retryCompare = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  const update = useCallback((updater) => setForm((current) => (current ? updater(current) : current)), []);
  const toggle = useCallback((key) => setVisible((current) => ({...current, [key]: !current[key]})), []);
  const add = useCallback((row) => update((f) => addToCustom(f, row.source, row.step, row.addCountX100)), [update]);
  const remove = useCallback((row) => update((f) => removeFromCustom(f, row.source, row.step, row.addCountX100)), [update]);

  const visibleKeys = shown ? scenarioKeys(shown.response) : [];
  return {
    form, bootError, shown, loading, error, errors: built?.ok ? [] : built?.errors ?? [],
    hash: readyHash({shown, renderedHash, loading, error, signature}),
    visible: Object.fromEntries(visibleKeys.map((key) => [key, visible[key] !== false])),
    update, toggle, add, remove, retryBoot, retryCompare,
  };
}
