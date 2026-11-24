import { DatabaseSync } from 'node:sqlite';

// Thin adapter over Node's built-in node:sqlite that exposes the small slice of the better-sqlite3 API
// this project uses (prepare/run/get/all/exec, pragma(), transaction()). No native build step is needed,
// which matters on Termux/Android where better-sqlite3 has no prebuilt binary.
function wrapStatement(stmt) {
  const guard = (fn) => (...args) => {
    try {
      return fn.apply(stmt, args);
    } catch (err) {
      // better-sqlite3 reports codes like SQLITE_CONSTRAINT_UNIQUE; node:sqlite gives a numeric errcode.
      if (err && typeof err.errcode === 'number' && (err.errcode & 0xff) === 19) err.code = 'SQLITE_CONSTRAINT';
      throw err;
    }
  };
  return { run: guard(stmt.run), get: guard(stmt.get), all: guard(stmt.all) };
}

export default class Database {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.depth = 0;
  }
  prepare(sql) { return wrapStatement(this.raw.prepare(sql)); }
  exec(sql) { return this.raw.exec(sql); }
  pragma(text, { simple = false } = {}) {
    const rows = this.raw.prepare(`PRAGMA ${text}`).all();
    if (simple) return rows.length ? Object.values(rows[0])[0] : undefined;
    return rows;
  }
  transaction(fn) {
    return (...args) => {
      const nested = this.depth > 0;
      const sp = `sp_${this.depth}`;
      this.raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE');
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT');
        return result;
      } catch (err) {
        this.depth--;
        this.raw.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK');
        throw err;
      }
    };
  }
}
