// 検査用の小さな字句の読み取り（依存の検査とつながりの検査が使う）。
// JavaScript・JSX のソースから、コメントを消し、文字列・テンプレート・正規表現リテラルの中身を見分ける。
// 返すもの:
//   masked  … コメントと、文字列・テンプレート・正規表現の中身を空白にした本文（長さと改行は元のまま）。括弧の対応を取るのに使う
//   code    … コメントだけを消した本文（文字列は残る）
//   strings … 文字列とテンプレートの {start, end, value}（value は引用符を除いた中身。テンプレートの ${…} は元の文字のまま）。
//             テンプレートは expressions も持つ。その段の ${…} の中の式の {start, end, value}（入れ子のテンプレートの ${…} は、その式を scanJs で読むと出る）
//   regexes … 正規表現リテラルの {start, end, value}（value は /…/ とフラグを含む元の字）
// 直前の字がこれなら / は正規表現の始まり（< と > は JSX の閉じタグ </p> を正規表現と読まないよう外す。矢印 => の後は正規表現）
const REGEX_BEFORE = /(?:[(,=:[!&|?{};+\-*%~^]|=>)$/;
const REGEX_KEYWORDS = /(?:^|[^\w$])(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await|instanceof)$/;

export function scanJs(text) {
  const masked = text.split('');
  const codeParts = [];
  const strings = [];
  const regexes = [];
  let codeStart = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (masked[k] !== '\n' && masked[k] !== '\r') masked[k] = ' '; };
  const cut = (from, to) => { codeParts.push(text.slice(codeStart, from)); codeStart = to; blank(from, to); };
  const prevSignificant = i => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    return text.slice(Math.max(0, k - 12), k + 1);
  };
  // 引用符 q で始まる文字列の終わり（閉じの引用符の次の位置）
  const endOfQuoted = (i, q) => {
    let k = i + 1;
    while (k < text.length && text[k] !== q && !(q !== '`' && text[k] === '\n')) k += text[k] === '\\' ? 2 : 1;
    return Math.min(k + 1, text.length);
  };
  // テンプレートの終わり。${ … } の入れ子（中の文字列・テンプレートを含む）をたどる。parts を渡すと、この段の ${ … } の中の範囲を入れる
  const endOfTemplate = (i, parts = null) => {
    let k = i + 1;
    while (k < text.length) {
      const ch = text[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '`') return k + 1;
      if (ch === '$' && text[k + 1] === '{') {
        let depth = 1;
        k += 2;
        const from = k;
        while (k < text.length && depth > 0) {
          const c = text[k];
          if (c === "'" || c === '"') { k = endOfQuoted(k, c); continue; }
          if (c === '`') { k = endOfTemplate(k); continue; }
          if (c === '{') depth++;
          else if (c === '}') depth--;
          k++;
        }
        parts?.push({start: from, end: depth === 0 ? k - 1 : k});
        continue;
      }
      k++;
    }
    return text.length;
  };
  const endOfRegex = i => {
    let k = i + 1;
    let inClass = false;
    while (k < text.length && text[k] !== '\n') {
      const ch = text[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { k++; break; }
      k++;
    }
    while (k < text.length && /[a-z]/i.test(text[k])) k++;
    return k;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      let k = i;
      while (k < text.length && text[k] !== '\n') k++;
      cut(i, k);
      i = k;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const k = end < 0 ? text.length : end + 2;
      cut(i, k);
      i = k;
    } else if (ch === "'" || ch === '"') {
      const k = endOfQuoted(i, ch);
      strings.push({start: i, end: k, value: text.slice(i + 1, k - 1)});
      blank(i + 1, k - 1);
      i = k;
    } else if (ch === '`') {
      const parts = [];
      const k = endOfTemplate(i, parts);
      strings.push({start: i, end: k, value: text.slice(i + 1, k - 1), expressions: parts.map(p => ({...p, value: text.slice(p.start, p.end)}))});
      blank(i + 1, k - 1);
      i = k;
    } else if (ch === '/') {
      const before = prevSignificant(i);
      if (before === '' || REGEX_BEFORE.test(before) || REGEX_KEYWORDS.test(before)) {
        const k = endOfRegex(i);
        regexes.push({start: i, end: k, value: text.slice(i, k)});
        blank(i + 1, k);
        i = k;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  codeParts.push(text.slice(codeStart));
  return {masked: masked.join(''), code: codeParts.join(''), strings, regexes};
}

// masked の中で、open の位置の括弧に対応する閉じ括弧の位置
export function matchParen(masked, open) {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === '(') depth++;
    else if (masked[k] === ')' && --depth === 0) return k;
  }
  return -1;
}
