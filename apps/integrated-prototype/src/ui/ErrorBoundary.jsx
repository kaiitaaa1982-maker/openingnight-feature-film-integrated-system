// 画面単位で描画の例外を受け止める。ナビ（外枠）は残したまま、この画面だけを「問題が起きました」に置き換える。
// 「この画面を再読込」で子を作り直す。resetKeys（画面名・作品IDなど）が変わると自動で元に戻る。
// 使い方: <ErrorBoundary name="帳票センター" resetKeys={[page, workId]}><Screen /></ErrorBoundary>
import React from 'react';
import './forms.css';

function sameKeys(a = [], b = []) {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {error: null, info: null, attempt: 0, keys: props.resetKeys || []};
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return {error};
  }

  static getDerivedStateFromProps(props, state) {
    const keys = props.resetKeys || [];
    if (sameKeys(keys, state.keys)) return null;
    // エラー表示中だけ子を作り直す。正常な画面はキーが変わっても再マウントしない
    return state.error ? {keys, error: null, info: null, attempt: state.attempt + 1} : {keys};
  }

  componentDidCatch(error, info) {
    this.setState({info});
    if (typeof console !== 'undefined') console.error(`[${this.props.name || '画面'}] 描画エラー`, error, info?.componentStack);
    this.props.onError?.(error, info);
  }

  reset() {
    this.setState((state) => ({error: null, info: null, attempt: state.attempt + 1}));
    this.props.onReset?.();
  }

  render() {
    const {error, info, attempt} = this.state;
    if (!error) return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
    const name = this.props.name;
    const detail = [error?.name && error?.message ? `${error.name}: ${error.message}` : String(error?.message || error), info?.componentStack?.trim()]
      .filter(Boolean).join('\n');
    return (
      <section className="card on-error-boundary" role="alert" aria-live="assertive">
        <p className="on-error-boundary-tone">エラー</p>
        <h2>この画面で問題が起きました</h2>
        <p>{name ? `「${name}」の表示中に問題が起きました。` : ''}ほかの画面はそのまま使えます。入力中の内容は保存されていない可能性があります。</p>
        <div className="on-form-actions">
          <button type="button" onClick={this.reset}>この画面を再読込</button>
          <button type="button" className="secondary" onClick={() => window.location.reload()}>ページ全体を再読込</button>
        </div>
        <details className="on-notice-tech">
          <summary>技術情報</summary>
          <pre>{detail}</pre>
        </details>
      </section>
    );
  }
}

export default ErrorBoundary;
