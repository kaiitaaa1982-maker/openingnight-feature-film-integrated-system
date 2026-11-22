// 原本の一覧から表示用の木と結び付けの件数を導く。DB・R2には触れない。
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function sourceTreeItems(documents, groups) {
  const byDocument = new Map();
  for (const {table, pageId, rows} of groups) {
    for (const row of rows) {
      const id = Number(row.document_id);
      if (!byDocument.has(id)) byDocument.set(id, new Map());
      const links = byDocument.get(id);
      if (!links.has(table)) links.set(table, {table, pageId, count: 0, targets: []});
      const link = links.get(table);
      const count = Number(row.n);
      link.count += count;
      link.targets.push({id: Number(row.target_id), name: row.name, count,
        workId: row.work_id == null ? null : Number(row.work_id)});
    }
  }
  return documents.map((d) => {
    const links = [...(byDocument.get(d.id)?.values() || [])];
    const linkedCount = links.reduce((sum, link) => sum + link.count, 0);
    return {id: d.id, fileName: d.file_name, location: d.external_location, sha256: d.sha256,
      byteLength: d.byte_length, kind: d.kind, links, linkedCount, unlinked: linkedCount === 0};
  });
}

export function buildSourceTree(items) {
  const root = {children: new Map(), count: 0, unlinkedCount: 0};
  for (const document of items) {
    const location = document.location;
    const folders = location ? location.replace(/^current\//, '').split('/').slice(0, -1) : ['場所なし'];
    let parent = root;
    const parts = [];
    for (const raw of folders) {
      const name = raw.normalize('NFC');
      parts.push(name);
      const id = location ? `folder:${JSON.stringify(parts)}` : 'unlocated';
      if (!parent.children.has(id)) parent.children.set(id, {id, name, type: 'folder', children: new Map(), count: 0, unlinkedCount: 0});
      parent = parent.children.get(id);
      parent.count += 1;
      if (!document.linkedCount) parent.unlinkedCount += 1;
    }
    parent.children.set(`document:${document.id}`, {id: `document:${document.id}`, type: 'file',
      name: document.fileName.normalize('NFC'), document});
  }
  const finish = (node) => [...node.children.values()]
    .sort((a, b) => compare(a.name, b.name) || compare(a.type, b.type) || compare(a.id, b.id))
    .map((child) => child.type === 'folder' ? {...child, children: finish(child)} : child);
  return finish(root);
}
