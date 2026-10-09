// T0 の実在と同時書き込みの印を検査する。試験を選ぶ selector ではない。
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, posix} from 'node:path';
import {matchParen, scanJs} from './js-scan.mjs';

const testPath = 'apps/integrated-prototype/test';
const apiHelpers = new Set(['call', 'req', 'request', 'fetch', 'api']);

function expressionEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (--depth < 0) return i; }
    else if ((c === ';' || c === ',') && depth === 0) return i;
  }
  return masked.length;
}

function argsOf(source) {
  const {masked} = scanJs(source);
  const args = [];
  let start = 0;
  while (start < source.length) {
    const end = expressionEnd(masked, start);
    args.push(source.slice(start, end).trim());
    start = end + 1;
  }
  return args;
}

// 関数と変数の定義をたどり、bill(f) や map(callback)、先に作った promises も見る。
function definitions(source, masked) {
  const result = new Map();
  const root = {start: 0, end: source.length};
  const scopes = [root], stack = [root], functions = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '{') {
      const scope = {start: i, end: source.length};
      scopes.push(scope);
      stack.push(scope);
    } else if (masked[i] === '}' && stack.length > 1) stack.pop().end = i + 1;
  }
  const contains = (scope, at) => scope.start <= at && at < scope.end;
  const narrowest = candidates => candidates.reduce((best, scope) =>
    !best || scope.end - scope.start < best.end - best.start ? scope : best, null);
  const scopeAt = at => narrowest(scopes.filter(scope => contains(scope, at))) ?? root;
  const add = (name, scope, start, end) => {
    const entries = result.get(name) ?? [];
    entries.push({scope, start, end});
    result.set(name, entries);
  };
  const parameters = (text, scope) => {
    // 引数の値は呼び出し側次第。外側の同名関数に解決して読むだけと誤認しない。
    for (const m of text.matchAll(/\b[\w$]+\b/g)) add(m[0], scope, null, null);
  };
  for (const m of masked.matchAll(/\bfunction\s*\*?\s*([\w$]+)?\s*\(/g)) {
    const close = matchParen(masked, m.index + m[0].length - 1);
    const start = masked.indexOf('{', close + 1);
    if (close < 0 || start < 0) continue;
    const scope = scopes.find(s => s.start === start);
    functions.push(scope);
    parameters(masked.slice(m.index + m[0].length, close), scope);
    if (m[1]) add(m[1], scopeAt(m.index), start + 1, scope.end - 1);
  }
  for (const m of masked.matchAll(/=>/g)) {
    let end = m.index;
    while (/\s/.test(masked[end - 1] ?? '')) end--;
    let start = end - 1;
    if (masked[start] === ')') {
      let depth = 1;
      while (start > 0 && depth) {
        start--;
        if (masked[start] === ')') depth++;
        else if (masked[start] === '(') depth--;
      }
    } else {
      while (start > 0 && /[\w$]/.test(masked[start - 1])) start--;
    }
    let body = m.index + 2;
    while (/\s/.test(masked[body] ?? '')) body++;
    const scope = masked[body] === '{' ? scopes.find(s => s.start === body)
      : {start, end: expressionEnd(masked, body)};
    if (masked[body] !== '{') scopes.push(scope);
    functions.push(scope);
    parameters(masked.slice(start, end), scope);
  }
  const declarations = new Set();
  for (const m of masked.matchAll(/\b(const|let|var)\s+([\w$]+)\s*(=\s*(?!>))?/g)) {
    const start = m[3] ? m.index + m[0].length : null;
    const scope = m[1] === 'var' ? narrowest(functions.filter(s => contains(s, m.index))) ?? root : scopeAt(m.index);
    declarations.add(m.index + m[0].indexOf(m[2], m[1].length));
    add(m[2], scope, start, start === null ? null : expressionEnd(masked, start));
  }
  // 分割代入も、その場の束縛として扱う。取り出す値は初期化式全体で近似する。
  for (const m of masked.matchAll(/\b(const|let|var)\s*([{\[])/g)) {
    const open = m.index + m[0].length - 1;
    const closing = m[2] === '{' ? '}' : ']';
    let close = open + 1, depth = 1;
    for (; close < masked.length && depth; close++) {
      if (masked[close] === m[2]) depth++;
      else if (masked[close] === closing) depth--;
    }
    const initializer = masked.slice(close).match(/^\s*=\s*/);
    const start = initializer ? close + initializer[0].length : null;
    const scope = m[1] === 'var' ? narrowest(functions.filter(s => contains(s, m.index))) ?? root : scopeAt(m.index);
    for (const name of masked.slice(open + 1, close - 1).matchAll(/\b[\w$]+\b/g)) {
      add(name[0], scope, start, start === null ? null : expressionEnd(masked, start));
    }
  }
  const resolve = (name, at) => {
    const visible = (result.get(name) ?? []).filter(d => contains(d.scope, at));
    const scope = narrowest(visible.map(d => d.scope));
    return visible.filter(d => d.scope === scope);
  };
  // 制御フローは確定しない。代入の可能性があれば初期値だけで読み取りと断定しない。
  for (const m of masked.matchAll(/\b([\w$]+)\s*=(?!=|>)/g)) {
    if (declarations.has(m.index) || /\.\s*$/.test(masked.slice(0, m.index))) continue;
    for (const def of resolve(m[1], m.index)) def.uncertain = true;
  }
  return {has: name => result.has(name), resolve};
}

function fetchWrites(args) {
  // Fetch の第2引数は RequestInit。method が無ければ GET（payload ではない）。
  // 動的な入力・spread・computed key は method を隠し得るので安全側に倒す。
  if (!/^['"`]/.test(args[0] ?? '')) return true;
  const options = args[1];
  if (!options || /^(?:null|undefined)$/.test(options)) return false;
  if (!options.startsWith('{') || !options.endsWith('}')) return true;
  for (const property of argsOf(options.slice(1, -1))) {
    const {masked} = scanJs(property);
    if (/^(?:\.\.\.|\[)/.test(masked)) return true;
    // コメントで method を隠さない（{/*理由*/ method: 'POST'} を GET と読まない）
    const text = property.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').trim();
    const method = text.match(/^(?:method|['"]method['"])\s*:\s*(['"])(GET|HEAD)\1\s*$/i);
    if (/^(?:method\b|['"]method['"])/.test(text) && !method) return true;
  }
  return false;
}

function writes(source, defs, offset = 0, visiting = new Set(), fullSource = source) {
  const {masked} = scanJs(source);
  // run・batch は DB の変数名や D1 の statement の名前に依存しない。
  if (/\.\s*(?:run|batch|post|put|patch|delete)\s*\(/i.test(masked)) return true;
  for (const m of masked.matchAll(/\b([\w$]+)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    if (close < 0) continue;
    // method-first の独自ヘルパーも拾う。Fetch の headers 内の文字列は見ない。
    const args = argsOf(source.slice(open + 1, close));
    if (m[1] !== 'fetch' && args.some(arg =>
      /^(['"`])(POST|PUT|PATCH|DELETE)\1$/i.test(arg)
      || (arg.startsWith('{') && argsOf(arg.slice(1, -1)).some(property =>
        /^(?:method|['"]method['"])\s*:\s*(['"`])(POST|PUT|PATCH|DELETE)\1\s*$/i.test(property))))) return true;
    if (apiHelpers.has(m[1])) {
      if (m[1] === 'fetch') {
        if (fetchWrites(args)) return true;
        continue;
      }
      // 本の API ヘルパーは (path, payload)。GET の明示と本文なしは読むだけ。
      if (/^['"`]/.test(args[0] ?? '') && args.length > 1 && !/^(?:null|undefined)$/.test(args[1])
        && !/\bmethod\s*:\s*['"](?:GET|HEAD)['"]/.test(args[1])) return true;
      continue;
    }
  }
  for (const m of masked.matchAll(/\b([\w$]+)\b/g)) {
    const name = m[1];
    if (apiHelpers.has(name) && !(name === 'fetch' && defs.has(name))) continue;
    // 引数の値（認証済みの admin など）の初期化まで再実行扱いにしない。
    const after = masked.slice(m.index + name.length);
    const before = masked.slice(0, m.index);
    const called = /^\s*\(/.test(after) && !/\.\s*$/.test(before);
    const callback = /\.\s*map\s*\(\s*$/.test(before) && /^\s*\)/.test(after);
    const promises = masked.trim() === name;
    if (!called && !callback && !promises) continue;
    if (!defs.has(name)) continue;
    const candidates = defs.resolve(name, offset + m.index);
    if (!candidates.length) return true;
    for (const def of candidates) {
      if (def.uncertain || def.start === null || visiting.has(def)) return true;
      const next = new Set(visiting).add(def);
      if (writes(fullSource.slice(def.start, def.end), defs, def.start, next, fullSource)) return true;
    }
  }
  return false;
}

export function concurrentWrites(source) {
  const {masked} = scanJs(source);
  const defs = definitions(source, masked);
  const found = [];
  for (const m of masked.matchAll(/\bPromise\s*\.\s*all\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(masked, open);
    if (close < 0 || writes(source.slice(open + 1, close), defs, open + 1, new Set(), source)) {
      found.push(masked.slice(0, m.index).split('\n').length);
    }
  }
  return found;
}

export function alwaysRunViolations(root, manifest) {
  const problems = [];
  if (manifest.version !== 1 || manifest.pathBase !== 'core' || !Array.isArray(manifest.tests) || !manifest.tests.length) {
    return ['always-run.json は version: 1、pathBase: core と空でない tests が必要'];
  }
  const seen = new Set();
  for (const entry of manifest.tests) {
    const file = entry.file;
    if (typeof file !== 'string' || !/^(apps\/integrated-prototype\/test|scripts\/ops)\/[\w-]+\.test\.mjs$/.test(file)
      || posix.normalize(file) !== file) {
      problems.push(`T0 のパスが不正: ${file}`);
      continue;
    }
    if (seen.has(file)) problems.push(`T0 に重複: ${file}`);
    seen.add(file);
    try { if (!statSync(join(root, file)).isFile()) problems.push(`T0 の本が無い: ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; problems.push(`T0 の本が無い: ${file}`); }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) problems.push(`T0 に理由が無い: ${file}`);
    if ('concurrency' in entry && typeof entry.concurrency !== 'boolean') problems.push(`concurrency は真偽値: ${file}`);
  }
  const marked = new Set(manifest.tests.filter(e => e.concurrency === true).map(e => e.file));
  for (const name of readdirSync(join(root, testPath)).filter(n => n.endsWith('.test.mjs'))) {
    const file = `${testPath}/${name}`;
    const lines = concurrentWrites(readFileSync(join(root, file), 'utf8'));
    if (lines.length && !marked.has(file)) problems.push(`concurrency の印が無い: ${file}:${lines.join(',')}`);
  }
  return problems;
}
