// 画面から原本を足すときの、画面とサーバーで同じに使う決まり（DB・R2・DOM に触れない）。
export const UPLOAD_PATH = '/api/source-documents/upload';
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // Workers の要求の本文の上限 100MB の内側

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// 置く先に選べるフォルダ。原本が既に置いてあるフォルダと、その上の階（current そのものは除く）。新しいフォルダは作らない
export function uploadFolders(items) {
  const folders = new Set();
  for (const item of items || []) {
    const location = typeof item?.location === 'string' ? item.location.normalize('NFC') : '';
    if (!location.startsWith('current/')) continue;
    const parts = location.split('/').slice(0, -1);
    for (let depth = 2; depth <= parts.length; depth += 1) folders.add(parts.slice(0, depth).join('/'));
  }
  return [...folders].sort(compare).map((value) => ({value, label: value.slice('current/'.length)}));
}

// いま開いている原本と同じフォルダを最初に選ぶ。無ければ先頭
export function defaultUploadFolder(folders, selectedLocation) {
  const own = typeof selectedLocation === 'string' ? selectedLocation.normalize('NFC').split('/').slice(0, -1).join('/') : '';
  return folders.some((f) => f.value === own) ? own : folders[0]?.value ?? '';
}

const two = (n) => String(n).padStart(2, '0');

// スマホのカメラは毎回同じ名前（image.jpg など）で渡すので、日本時間の日時の名前に替える。ほかはそのまま（NFC に寄せる）
export function uploadName(fileName, now = new Date()) {
  const name = String(fileName ?? '').normalize('NFC').trim();
  const generic = /^(?:image|photo|video|写真|画像|イメージ)(\.[A-Za-z0-9]{1,8})?$/i.exec(name);
  if (name && !generic) return name;
  const t = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const stamp = `${t.getUTCFullYear()}${two(t.getUTCMonth() + 1)}${two(t.getUTCDate())}_${two(t.getUTCHours())}${two(t.getUTCMinutes())}${two(t.getUTCSeconds())}`;
  return `${stamp}${generic?.[1]?.toLowerCase() ?? ''}`;
}

// 中身の形式から原本の種類の初めの値を決める（画面で選び直せる）
export function uploadKind(mediaType) {
  const type = String(mediaType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'media';
  if (type.startsWith('audio/')) return 'audio';
  return 'other';
}

// 画面の request() に渡す道（/api は request が付ける）
export function uploadRequestPath({folder, name, kind, mediaType}) {
  const query = new URLSearchParams({folder, name});
  if (kind) query.set('kind', kind);
  if (mediaType) query.set('type', mediaType);
  return `${UPLOAD_PATH.replace(/^\/api/, '')}?${query}`;
}

// 送る前に画面で分かる誤り。無ければ null
export function uploadProblem({folder, name, size}) {
  if (!folder) return '置く先を選んでください';
  if (!name) return '名前を入れてください';
  if (!(size > 0)) return '中身が空です';
  if (size > MAX_UPLOAD_BYTES) return `1つ ${MAX_UPLOAD_BYTES / 1024 / 1024}MB までです。大きいものはドライブに置いてください`;
  return null;
}

export async function sha256HexOfBlob(blob) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
