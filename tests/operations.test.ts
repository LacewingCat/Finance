import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/server/store.js";
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it("backs up a consistent database, restores it and retains private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "finance-backup-test-"));
  directories.push(dir);
  const file = join(dir, "finance.sqlite"),
    backup = join(dir, "backup.sqlite");
  const original = new Store(file);
  original.put("test", "amount", "1000.00");
  original.close();
  const args = ["--import", "tsx", resolve("scripts/manage.ts")],
    env = { ...process.env, OPENAI_API_KEY: "", FINANCE_DATA_DIR: dir };
  execFileSync(process.execPath, [...args, "backup", backup], {
    env,
    stdio: "pipe",
  });
  const changed = new Store(file);
  changed.put("test", "amount", "900.00");
  changed.close();
  execFileSync(process.execPath, [...args, "restore", backup], {
    env,
    stdio: "pipe",
  });
  const restored = new Store(file);
  expect(restored.get("test", "amount")).toBe("1000.00");
  restored.close();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});
it("refuses a newer schema without overwriting its version", () => {
  const dir = mkdtempSync(join(tmpdir(), "finance-schema-test-"));
  directories.push(dir);
  const file = join(dir, "new.sqlite"),
    db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=2");
  db.close();
  expect(() => new Store(file)).toThrow("较新版本");
  const check = new DatabaseSync(file);
  expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
  check.close();
});
