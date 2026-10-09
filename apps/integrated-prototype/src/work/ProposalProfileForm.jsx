// 作品・商品マスタの「作品情報」タブの下に出す、提案資料に出す作品情報（フリガナ・英題・ジャンル・コピーライト・注意事項・
// イントロダクション（短・長）・作品情報URL・画像の参照）。保存するたびに新しい版を積む（前の版は残る）。
// 画像はファイルを置かず、URL か保存済みの原本のキーと、ファイル名だけを入れる（提案資料の Excel には URL・キー・ファイル名を出す）。
// 直せるのは案件の編集権限がある人。制作担当と閲覧だけの人は読むだけ。
import React, {useEffect, useState} from 'react';
import {useShell} from '../shell/context.mjs';
import {FormField} from '../ui/FormField.jsx';
import {Notice} from '../ui/Notice.jsx';
import {dateTimeJst} from '../ui/format.mjs';
import '../sales-ops/proposals.css';

const KEYS = ['title_kana', 'title_en', 'genre', 'copyright_notice', 'caution', 'intro_short', 'intro_long', 'info_url', 'image_url', 'image_key', 'image_file_name'];
const TEXTAREAS = new Set(['caution', 'intro_short', 'intro_long']);
const HINTS = {
  caution: '提案のときに伝える注意（素材の制限・表記の決まりなど）',
  info_url: 'https:// で始まるアドレス',
  image_url: 'URL か、下の保存済みのキーのどちらか1つ',
  image_key: '保存済みの原本のキー（英数字と / . _ -）',
};
const draftOf = (profile) => ({...Object.fromEntries(KEYS.map((key) => [key, profile?.[key] ?? ''])), source_reference: ''});

export function ProposalProfileForm({request: requestProp, workId, readOnly = false}) {
  const shell = useShell();
  const request = requestProp || shell.request;
  const [state, setState] = useState({loading: true});
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState(draftOf(null));
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setState((previous) => ({...previous, loading: true}));
    request(`/work-proposal-profiles/${workId}`)
      .then((body) => { if (live) { setState({body}); setDraft(draftOf(body.profile)); } })
      .catch((error) => { if (live) setState({error}); });
    return () => { live = false; };
  }, [request, workId, revision]);
  const body = state.body;
  const base = draftOf(body?.profile);
  const dirty = Boolean(body) && JSON.stringify(draft) !== JSON.stringify(base);
  useEffect(() => {
    shell.registerUnsaved?.('work-proposal-profile', dirty ? 1 : 0, '提案資料に出す作品情報（入力中）');
    return () => shell.registerUnsaved?.('work-proposal-profile', 0);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const labelOf = (key) => body?.fields?.find((field) => field.key === key)?.label || key;
  const maxOf = (key) => body?.fields?.find((field) => field.key === key)?.max;

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await request(`/work-proposal-profiles/${workId}`, {method: 'POST', body: JSON.stringify({...draft, baseRevision: body.profile?.revision || 0})});
      shell.registerUnsaved?.('work-proposal-profile', 0);
      setNotice({tone: 'ok', message: `提案資料に出す作品情報を第${result.revision}版として保存しました`});
      setRevision((n) => n + 1);
    } catch (error) {
      setNotice({error});
    } finally {
      setBusy(false);
    }
  }

  const canEdit = Boolean(body?.canEdit) && !readOnly && !shell.readOnly;
  return (
    <section className="pp-profile" aria-label="提案資料に出す作品情報">
      <h3>提案資料に出す作品情報{body?.profile ? `（第${body.profile.revision}版）` : '（未登録）'}</h3>
      <p className="wc-note">営業基幹の提案資料（月別・SVOD）の列に出ます。保存するたびに新しい版になり、前の版は残ります。画像はファイルを置かず、URL か保存済みのキーとファイル名だけを入れます。</p>
      {state.error && <Notice error={state.error} onRetry={() => setRevision((n) => n + 1)} />}
      {notice && <Notice tone={notice.tone} message={notice.message} error={notice.error} onDismiss={() => setNotice(null)} />}
      {body && (
        <form onSubmit={save} aria-label="提案資料に出す作品情報の新しい版">
          <fieldset disabled={!canEdit || busy} style={{border: 0, padding: 0, minWidth: 0}}>
            <div className="pp-profile-grid">
              {KEYS.map((key) => (
                <FormField key={key} type={TEXTAREAS.has(key) ? 'textarea' : key.endsWith('_url') ? 'url' : 'text'} rows={3} label={labelOf(key)} maxLength={maxOf(key)}
                  hint={HINTS[key]} value={draft[key]} onChange={(value) => setDraft((previous) => ({...previous, [key]: value}))} />
              ))}
            </div>
            <FormField label="出所・改訂理由" required value={draft.source_reference} onChange={(value) => setDraft((previous) => ({...previous, source_reference: value}))} hint="版の履歴と監査記録に残ります" />
            <div className="on-form-actions">
              <button type="submit" disabled={!dirty || !draft.source_reference.trim()}>{body.profile ? `第${body.profile.revision + 1}版として保存` : '第1版として保存'}</button>
              {dirty && <button type="button" className="text" onClick={() => setDraft(base)}>入力を戻す</button>}
            </div>
          </fieldset>
          {!canEdit && <p className="wc-note">この作品は案件の編集権限がある人が直します。</p>}
        </form>
      )}
      {body?.versions?.length > 0 && (
        <details>
          <summary>版の履歴（{body.versions.length}版）</summary>
          <ul>{body.versions.map((version) => <li key={version.revision}>第{version.revision}版・{dateTimeJst(version.created_at)}・{version.created_by_name || '不明'}・{version.source_reference}</li>)}</ul>
        </details>
      )}
    </section>
  );
}

export default ProposalProfileForm;
