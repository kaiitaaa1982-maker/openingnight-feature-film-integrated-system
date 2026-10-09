#!/usr/bin/env node
// 行は出さず、表ごとの件数と金額の合計を比較する。0=一致、1=不一致、2=入力の誤り。
// 入力の誤りは {"event":"pg_reconcile_input_failed","cause":"<原因の種類>"} の1行だけを出す。原因の種類は書き出しと同じ許可リスト
// （failureCause）で、入力の中身・ファイルの文は出さない。
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {compareReconciliation, exportError, failureCause} from '../../apps/integrated-prototype/src/data-platform/pg-export-format.mjs';
export {compareReconciliation};

export function readReconciliation(path) {
  let text;
  try { text = readFileSync(path, 'utf8').replace(/^﻿/, ''); }
  catch (error) { if (error.code === 'ENOENT') throw exportError('input_missing'); throw error; }
  // psql の区切り付きテキストは扱わない。reconcile.sql の出力を JSON 配列で受ける。
  try { return JSON.parse(text); } catch { throw exportError('invalid_json'); }
}

export function reconcileCli(argv, {out = line => console.log(line), err = line => console.error(line)} = {}) {
  try {
    let values;
    try { ({values} = parseArgs({args: argv, options: {left: {type: 'string'}, right: {type: 'string'}}})); }
    catch { throw exportError('invalid_arguments'); }
    if (!values.left || !values.right) throw exportError('invalid_arguments');
    const result = compareReconciliation(readReconciliation(values.left), readReconciliation(values.right));
    out(JSON.stringify(result));
    return result.equal ? 0 : 1;
  } catch (error) {
    err(JSON.stringify({event: 'pg_reconcile_input_failed', cause: failureCause(error)}));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = reconcileCli(process.argv.slice(2));
}
