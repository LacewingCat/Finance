import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync, backup } from "node:sqlite";
import { dataDirectory } from "../src/server/store.js";
import {loadEnvFile} from 'node:process';
import {saveApiKey} from '../src/server/secrets.js';

process.umask(0o077);
const dir = dataDirectory(),
  command = process.argv[2] ?? "doctor",
  project = resolve(import.meta.dirname, "..");
const file = join(dir, "finance.sqlite"),
  sessionPath = join(dir, "session.json");
const label = "io.github.lacewingcat.finance",
  plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
function session() {
  try {
    return JSON.parse(readFileSync(sessionPath, "utf8")) as {
      port: number;
      token: string;
      pid: number;
    };
  } catch {
    return undefined;
  }
}
function running() {
  const s = session();
  if (!s) return false;
  try {
    process.kill(s.pid, 0);
    return true;
  } catch {
    return false;
  }
}
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} 执行失败 (${r.status})`);
}
function checkDatabase(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    if (row.integrity_check !== "ok") throw new Error("备份完整性检查失败");
    const v = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (v.user_version !== 1)
      throw new Error(`不兼容的数据库版本 ${v.user_version}`);
    db.prepare("SELECT count(*) FROM records").get();
  } finally {
    db.close();
  }
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
if (command === "open") {
  const s = session();
  if (!s || !running())
    throw new Error("服务尚未运行，请先 npm start 或 npm run service:start");
  // Fragment is consumed by the UI and erased; never logged or sent as a query parameter.
  run("/usr/bin/open", [
    `http://127.0.0.1:${s.port}/#token=${encodeURIComponent(s.token)}`,
  ]);
} else if (command === "doctor") {
  const report = {
    node: process.version,
    nodeSupported: Number(process.versions.node.split(".")[0]) === 26,
    platform: process.platform,
    buildReady:
      existsSync(join(project, "dist/server/server/index.js")) &&
      existsSync(join(project, "dist/web/index.html")),
    privateDirectory: dir,
    databasePresent: existsSync(file),
    serviceInstalled: existsSync(plist),
    runtimeInstalled: existsSync(join(dir,'runtime','dist/server/server/index.js')),
    running: running(),
    envFilePresent: existsSync(join(project, ".env.local")),
    notification: "pending: requires verified identity and iPhone delivery",
  };
  if (existsSync(file)) checkDatabase(file);
  console.log(JSON.stringify(report, null, 2));
} else if (command === "backup") {
  if (!existsSync(file)) throw new Error("尚无数据库");
  const target = resolve(
    process.argv[3] ??
      join(
        dir,
        "backups",
        `finance-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
      ),
  );
  if (existsSync(target) || target === file)
    throw new Error("目标文件已存在，请使用新文件名");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
  chmodSync(target, 0o600);
  checkDatabase(target);
  console.log(`备份已验证：${target}`);
} else if (command === "restore") {
  const source = process.argv[3];
  if (!source)
    throw new Error("用法 npm run restore -- /绝对路径/backup.sqlite");
  if (running())
    throw new Error("请先停止后台服务或退出当前 npm start，再恢复备份");
  const sourcePath = resolve(source);
  if (sourcePath === file) throw new Error("请选择独立备份文件");
  checkDatabase(sourcePath);
  const temporary = join(dir, `restore-${process.pid}.sqlite`);
  copyFileSync(sourcePath, temporary);
  chmodSync(temporary, 0o600);
  checkDatabase(temporary);
  if (existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      await backup(db, join(dir, `before-restore-${Date.now()}.sqlite`));
    } finally {
      db.close();
    }
  }
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  renameSync(temporary, file);
  console.log(
    "恢复完成；原数据库已另存为 before-restore 备份。API 启用及监控状态来自备份，请启动后核对。",
  );
} else if (command === "install") {
  if (process.platform !== "darwin") throw new Error("launchd 仅支持 macOS");
  if (!existsSync(join(project, "dist/server/server/index.js")))
    throw new Error("请先 npm run build");
  if(running())throw new Error('请先 npm run service:stop，再安装更新');
  const runtime=join(dir,'runtime');mkdirSync(runtime,{recursive:true,mode:0o700});
  // Install only executable public artifacts; no database, log, screenshot or env file is copied.
  cpSync(join(project,'dist'),join(runtime,'dist'),{recursive:true,force:true});
  cpSync(join(project,'node_modules'),join(runtime,'node_modules'),{recursive:true,force:true});
  copyFileSync(join(project,'package.json'),join(runtime,'package.json'));
  if(existsSync(join(project,'.env.local')))loadEnvFile(join(project,'.env.local'));
  if(process.env.OPENAI_API_KEY)saveApiKey(process.env.OPENAI_API_KEY);
  mkdirSync(dirname(plist), { recursive: true, mode: 0o700 });
  const args = [
    process.execPath,
    join(runtime, "dist/server/server/index.js"),
  ];
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(runtime)}</string><key>EnvironmentVariables</key><dict><key>FINANCE_DATA_DIR</key><string>${xml(dir)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(join(dir, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(dir, "service-error.log"))}</string></dict></plist>`;
  writeFileSync(plist, text, { mode: 0o600 });
  run("/usr/bin/plutil", ["-lint", plist]);
  console.log(
    "启动项已安装；运行 npm run service:start 启动，npm run service:stop 停止。",
  );
} else if (command === "start") {
  if (!existsSync(plist)) throw new Error("请先 npm run service:install");
  if (running()) throw new Error("工作台服务已经运行");
  run("/bin/launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist]);
} else if (command === "stop" || command === "uninstall") {
  if (existsSync(plist)) {
    spawnSync(
      "/bin/launchctl",
      ["bootout", `gui/${process.getuid!()}`, plist],
      { stdio: "ignore" },
    );
    if (command === "uninstall") rmSync(plist);
  }
  console.log(
    command === "uninstall"
      ? "启动项已移除，个人数据库和备份保留。"
      : "已请求停止 launchd 服务。",
  );
} else throw new Error("未知命令");
