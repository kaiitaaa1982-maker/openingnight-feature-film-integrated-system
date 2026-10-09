// Worker-safe adapter. Keep Node built-ins out of this module and its import graph.
// 入口の4つと読み取りの一括（FR-CORE-DATA-003・009）。エラーには共通のエラーの種類を付ける（src/data-platform/db-errors.mjs）。
// 新しい行の ID は INSERT … RETURNING id を get で受け取る（docs/rules/dialect.md）
import { attachDbError } from './data-platform/db-errors.mjs';
import { assertReadBatch } from './data-platform/pg-db.mjs';

const changesOf = result => Number(result.meta?.changes || 0);

export class D1Database {
  constructor(binding) { this.binding = binding; }
  async call(fn) {
    try { return await fn(); } catch (error) { throw attachDbError(error); }
  }
  async all(sql, params = []) {
    const result = await this.call(() => this.binding.prepare(sql).bind(...params).all());
    return result.results || [];
  }
  async get(sql, params = []) { return (await this.call(() => this.binding.prepare(sql).bind(...params).first())) || null; }
  async run(sql, params = []) {
    const result = await this.call(() => this.binding.prepare(sql).bind(...params).run());
    if (!result.success) throw new Error('D1 statement failed');
    return { changes: changesOf(result) };
  }
  async batch(statements) {
    // D1 batch is atomic. Guard statements use CHECK violations to make stale CAS fail the whole batch.
    const results = await this.call(() => this.binding.batch(statements.map(({ sql, params = [] }) => this.binding.prepare(sql).bind(...params))));
    if (results.some(result => !result.success)) throw new Error('D1 transaction failed');
    return results.map(result => ({ changes: changesOf(result), rows: result.results || [] }));
  }
  // 複数の読み取りを1つの時点で返す。D1 の素の batch は1つのトランザクションで流れる（入口の all を並べても同じにならない）
  // D1 の batch は書き込みも通すので、書き込みの文は入口が先に断る（共通のエラーの種類 read_only）
  async readBatch(statements) {
    assertReadBatch(statements);
    const results = await this.call(() => this.binding.batch(statements.map(({ sql, params = [] }) => this.binding.prepare(sql).bind(...params))));
    if (results.length !== statements.length || results.some(result => !result.success)) throw new Error('D1 read batch failed');
    return results.map(result => result.results || []);
  }
}
