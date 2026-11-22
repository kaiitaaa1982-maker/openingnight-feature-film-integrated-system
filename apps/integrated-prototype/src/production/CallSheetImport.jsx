// 香盤・日々スケの「日々スケを取り込む」。日々スケを構造化した JSON と原本の PDF を選び、版の古い順に登録する。
// 中身は call-sheet-import.mjs（scripts/import-call-sheets.mjs と同じ）。登録済みの版（保管庫に同じファイル名・日付の原本）は飛ばす。
import React, {useState} from 'react';
import {Notice} from '../ui/Notice.jsx';
import {checkCallSheetSource, importCallSheets, isRegisteredSheet} from './call-sheet-import.mjs';

export default function CallSheetImport({work, request, disabled, onDone, onClose}) {
  const [source, setSource] = useState(null), [problems, setProblems] = useState([]), [pdfs, setPdfs] = useState(new Map());
  const [registered, setRegistered] = useState([]), [busy, setBusy] = useState(false), [result, setResult] = useState(null), [error, setError] = useState(null);

  async function pickJson(file) {
    setResult(null); setError(null);
    try {
      const parsed = JSON.parse(await file.text());
      setProblems(checkCallSheetSource(parsed));
      setSource(parsed);
      setRegistered((await request(`/preprod/works/${work.id}/documents`)).documents);
    } catch (e) {
      setSource(null); setProblems([e instanceof SyntaxError ? 'JSON として読めません' : e.message]);
    }
  }
  function pickPdfs(files) {
    // 選んだ直後に入力欄を空にするので、その前に写しを取る
    const picked = [...files].map((file) => [file.name.normalize('NFC'), file]);
    setPdfs((current) => new Map([...current, ...picked]));
  }

  const sheets = (source?.sheets || []).map((sheet) => {
    const done = isRegisteredSheet(registered, sheet);
    return {sheet, done, pdf: pdfs.get(sheet.file.normalize('NFC')) || null};
  });
  const missing = sheets.filter((row) => !row.done && !row.pdf);
  const todo = sheets.filter((row) => !row.done);
  const ready = source && !problems.length && todo.length > 0 && !missing.length;

  async function run() {
    setBusy(true); setError(null);
    const call = (method, path, payload, headers = {}) => request(path, {method, headers: {...(payload === undefined ? {} : {'content-type': 'application/json'}), ...headers},
      body: payload === undefined ? undefined : JSON.stringify(payload)});
    try {
      const done = await importCallSheets(call, source, {work, readPdf: async (name) => new Uint8Array(await pdfs.get(name.normalize('NFC')).arrayBuffer())});
      setResult(done);
      setRegistered((await request(`/preprod/works/${work.id}/documents`)).documents);
      onDone?.();
    } catch (e) {
      setError(e);
      onDone?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card call-sheet-import" aria-label="日々スケを取り込む">
      <div className="call-sheet-import-head">
        <h3>日々スケを取り込む</h3>
        <button type="button" className="secondary" onClick={onClose} disabled={busy}>閉じる</button>
      </div>
      <div className="call-sheet-import-pick">
        <label className="call-sheet-pick">JSON<input type="file" accept="application/json,.json" onChange={(e) => { if (e.target.files[0]) pickJson(e.target.files[0]); e.target.value = ''; }} /></label>
        <label className="call-sheet-pick">PDF<input type="file" accept="application/pdf,.pdf" multiple onChange={(e) => { pickPdfs(e.target.files); e.target.value = ''; }} /></label>
      </div>
      {problems.length > 0 && <Notice tone="error" title="JSON を確認" details={problems} compact />}
      {sheets.length > 0 && (
        <table className="call-sheet-import-table">
          <thead><tr><th>日付</th><th>版</th><th>ファイル</th><th>行</th><th>原本</th></tr></thead>
          <tbody>
            {sheets.map(({sheet, done, pdf}) => (
              <tr key={`${sheet.date}-${sheet.file}`} className={done ? 'is-done' : ''}>
                <td>{sheet.date}</td><td>{sheet.stamp || '—'}</td><td>{sheet.file}</td><td>{sheet.rows.length}</td>
                <td>{done ? '済' : pdf ? 'あり' : <span className="call-sheet-missing">なし</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <Notice tone="error" title="途中で止まりました" error={error} details={['済んだ版は登録済み。直してもう一度取り込むと続きから進む']} compact />}
      {result && <Notice tone="ok" message={`登録 ${result.applied.length}枚・済 ${result.skipped.length}枚`} compact />}
      <div className="call-sheet-import-run">
        <button type="button" onClick={run} disabled={!ready || busy || disabled} title={disabled ? '未保存の変更を保存するか取り消してから取り込みます' : undefined}>
          {busy ? '取込中…' : `${todo.length}枚を取り込む`}
        </button>
      </div>
    </section>
  );
}
