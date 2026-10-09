// 設計キャンバスの実画面プレビューを「確認専用」にする道具。
// - readOnlyRequest: GET 以外の呼び出しを送らずに断る（書き込みを起こさない）。
// - readOnlyPreview: 画面の要素の木をたどり、request・画面移動・再読込の props を確認専用のものに差し替える。
//   main.jsx の画面は LocalShellProvider で包まれ、さらに <div> や slot の props に入っていることがあるため、
//   一番外の要素だけでなく、子と要素の props（manualSlot・workView など）にも差し替えを届ける。
// URL は LocalShellProvider（src/shell/context.mjs）が内部の状態だけで持つので、ここでは画面移動を無効にするだけ。
import {cloneElement, isValidElement} from 'react';
import {ApiError} from './ui/api-client.mjs';

export const READ_ONLY_MESSAGE = '設計キャンバスは確認専用です。登録や修正は、その画面を開いて行ってください';

const READ_METHODS = new Set(['GET', 'HEAD']);

export function readOnlyRequest(request) {
  const wrapped = (path, options = {}) => {
    const method = String(options?.method || 'GET').toUpperCase();
    if (!READ_METHODS.has(method)) return Promise.reject(new ApiError(READ_ONLY_MESSAGE, {kind: 'forbidden', status: 0}));
    return request(path, options);
  };
  wrapped.readOnly = true;
  return wrapped;
}

const noop = () => {};

// 部品が受け取っている props のうち、差し替えるもの。持っていない props は足さない（DOM へ未知の属性を渡さない）。
function replacements(props, request) {
  const next = {};
  if (Object.hasOwn(props, 'request')) next.request = request;
  for (const key of ['onNavigate', 'reload', 'onSelect']) if (Object.hasOwn(props, key)) next[key] = noop;
  return next;
}

function transformChildren(children, request, depth) {
  if (Array.isArray(children)) return children.map((child) => transformNode(child, request, depth + 1));
  return transformNode(children, request, depth + 1);
}

function transformNode(node, request, depth) {
  if (depth > 24) return node;
  if (Array.isArray(node)) return node.map((child) => transformNode(child, request, depth + 1));
  if (!isValidElement(node)) return node;
  const props = node.props || {};
  const next = typeof node.type === 'string' ? {} : replacements(props, request);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue;
    if (isValidElement(value)) next[key] = transformNode(value, request, depth + 1);
  }
  const hasChildren = props.children !== undefined && typeof props.children !== 'function';
  if (!hasChildren && !Object.keys(next).length) return node;
  if (hasChildren) return cloneElement(node, next, ...[].concat(transformChildren(props.children, request, depth)));
  return cloneElement(node, next);
}

export function readOnlyPreview(element, {request} = {}) {
  if (!request) return element;
  const safe = request.readOnly ? request : readOnlyRequest(request);
  return transformNode(element, safe, 0);
}

// 設計キャンバスの「戻る」。?from= に画面IDがあり、その画面が実在してキャンバス自身でないときだけ戻り先にする。
export function canvasBackTarget(from, {isKnownPage = () => false, canvasPage = '設計キャンバス'} = {}) {
  const page = typeof from === 'string' ? from.trim() : '';
  if (!page || page === canvasPage || !isKnownPage(page)) return null;
  return page;
}
