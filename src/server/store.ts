import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const dataDirectory = () =>
  process.env.FINANCE_DATA_DIR ||
  join(homedir(), "Library", "Application Support", "Finance");
export class Store {
  readonly db: DatabaseSync;
  readonly file: string;
  private depth = 0;
  constructor(file = join(dataDirectory(), "finance.sqlite")) {
    this.file = file;
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      chmodSync(dirname(file), 0o700);
    }
    this.db = new DatabaseSync(file);
    const version = (
      this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 1) {
      this.db.close();
      throw new Error("数据库由较新版本创建；请升级应用，禁止降级覆盖");
    }
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL); INSERT OR IGNORE INTO metadata VALUES ('revision',0); PRAGMA user_version=1;",
    );
    if (file !== ":memory:")
      for (const path of [file, `${file}-wal`, `${file}-shm`])
        if (existsSync(path)) chmodSync(path, 0o600);
  }
  get<T>(ns: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM records WHERE namespace=? AND key=?")
      .get(ns, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(ns: string, key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
      )
      .run(ns, key, JSON.stringify(value));
  }
  list<T>(ns: string): T[] {
    return this.entries<T>(ns).map((r) => r.value);
  }
  entries<T>(ns: string): { key: string; value: T }[] {
    return (
      this.db
        .prepare(
          "SELECT key,value FROM records WHERE namespace=? ORDER BY rowid",
        )
        .all(ns) as { key: string; value: string }[]
    ).map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }
  remove(ns: string, key: string) {
    this.db
      .prepare("DELETE FROM records WHERE namespace=? AND key=?")
      .run(ns, key);
  }
  clear(ns: string) {
    this.db.prepare("DELETE FROM records WHERE namespace=?").run(ns);
  }
  atomic<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }
  revision() {
    return Number(
      (
        this.db
          .prepare("SELECT value FROM metadata WHERE key='revision'")
          .get() as { value: number }
      ).value,
    );
  }
  bump() {
    this.db
      .prepare("UPDATE metadata SET value=value+1 WHERE key='revision'")
      .run();
    return this.revision();
  }
  close() {
    this.db.close();
  }
}
