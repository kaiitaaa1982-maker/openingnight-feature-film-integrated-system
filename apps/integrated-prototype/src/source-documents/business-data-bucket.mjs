// 業務データの置き場（R2 openingnight-business-data、束縛名 BUSINESS_DATA）へ渡す口を、ここ1か所で作る。
// brain D-043「改め（2026-11-09）」: 読む（get）と、足すだけ書く（同じキーがあれば止める条件付きの put）。
// 上書き・削除・一覧の口は作らない。put は必ず条件（If-None-Match: *）を付け、条件なしの put を書く場所を持たない。
// 置けたら R2 の記録（size を持つ）、同じキーが既にあれば null が返る。sha256 を渡すと R2 が中身と照らし、違えば置かずに投げる。
export function businessDataPorts(bucket) {
  if (!bucket) return {readBusinessObject: null, addBusinessObject: null};
  return {
    readBusinessObject: (key) => bucket.get(key),
    addBusinessObject: (key, body, {sha256} = {}) => bucket.put(key, body, {onlyIf: new Headers({'If-None-Match': '*'}), sha256}),
  };
}
