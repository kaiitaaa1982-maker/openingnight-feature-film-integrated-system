// CSV の文字コード判定。Excel 既定の「CSV（コンマ区切り）」は Shift_JIS で保存されることが多い。
// BOM 付き UTF-8 → UTF-8（厳密に読めるか）→ Shift_JIS の順に試し、どれで読んだかを返す。
export function detectEncoding(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return 'utf-8-bom';
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(data);
    return 'utf-8';
  } catch {
    return 'shift_jis';
  }
}

export const ENCODING_LABELS = Object.freeze({'utf-8-bom': 'UTF-8（BOM付き）', 'utf-8': 'UTF-8', shift_jis: 'Shift_JIS（Excel の既定のCSV）'});

export function decodeText(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const encoding = detectEncoding(data);
  if (encoding === 'utf-8-bom') return {text: new TextDecoder('utf-8').decode(data.subarray(3)), encoding};
  if (encoding === 'utf-8') return {text: new TextDecoder('utf-8').decode(data), encoding};
  let text;
  try {
    text = new TextDecoder('shift_jis', {fatal: true}).decode(data);
  } catch {
    throw new Error('文字コードを判定できません。UTF-8 か Shift_JIS のCSVで保存してください');
  }
  return {text, encoding};
}
