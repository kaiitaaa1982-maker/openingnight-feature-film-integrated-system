// 手元の試作でだけ使う、業務データの置き場の代わり（フォルダ）。ON_BUSINESS_DATA_DIR を渡したときだけ server.mjs がつなぐ。
// 口は Worker と同じ2つ（読む・無ければ置く）。上書き・削除・一覧は持たない。架空のファイルだけを置く（実データのフォルダを指さない）
import {createHash} from 'node:crypto';
import {mkdir, open, readFile, unlink, link} from 'node:fs/promises';
import {dirname, resolve, sep} from 'node:path';
import {businessDataKeyAllowed} from './source-content.mjs';

export function localBusinessDataPorts(dir) {
  if (!dir) return {readBusinessObject: null, addBusinessObject: null};
  const root = resolve(dir);
  const pathOf = (key) => {
    if (!businessDataKeyAllowed(key)) throw new Error('置き場のキーを確認してください');
    const path = resolve(root, ...key.split('/'));
    if (!path.startsWith(root + sep)) throw new Error('置き場の外です');
    return path;
  };
  return {
    readBusinessObject: async (key) => {
      try {
        const bytes = await readFile(pathOf(key));
        return {arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)};
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    // 仮の名前で書き、中身を照らしてから、無いときだけ本来の名前を付ける（link は同じ名前があれば失敗する）
    addBusinessObject: async (key, body, {sha256} = {}) => {
      const path = pathOf(key);
      await mkdir(dirname(path), {recursive: true});
      const temp = `${path}.${process.pid}.${Date.now()}.part`;
      const hash = createHash('sha256');
      let size = 0;
      const file = await open(temp, 'wx');
      try {
        for await (const chunk of body) { hash.update(chunk); size += chunk.length; await file.write(chunk); }
      } finally {
        await file.close();
      }
      try {
        if (sha256 && hash.digest('hex') !== sha256) throw new Error('sha256 mismatch');
        try {
          await link(temp, path);
        } catch (error) {
          if (error.code === 'EEXIST') return null;
          throw error;
        }
        return {key, size};
      } finally {
        await unlink(temp).catch(() => {});
      }
    },
  };
}
