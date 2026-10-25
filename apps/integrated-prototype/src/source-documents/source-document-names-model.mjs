// 解析と保存が共有する名前の検査。DB・R2 には触れない。
function nameError(value, label, maxLength) {
  const name = typeof value === 'string' ? value.trim() : '';
  // trim 前に見る。NUL は SQLite の length、PostgreSQL の text でも保存に支障がある。
  if (typeof value === 'string' && /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return `${label}に制御文字は使えません`;
  // cloud-r2-db の prepareStatement が断る印。保存時と同じ trim 後の値で調べる。
  if (name.startsWith('@r2:v1:')) return `${label}に予約済みR2参照形式は使えません`;
  if (name.length < 1 || name.length > maxLength) return `${label}は1〜${maxLength}字にしてください`;
  return null;
}

export const sourceDocumentFileNameError = (value) => nameError(value, 'ファイル名', 240);
export const sourceDocumentLocationError = (value) => nameError(value, '外の置き場の名前', 500);
