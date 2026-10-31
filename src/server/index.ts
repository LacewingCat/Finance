import { loadEnvFile } from "node:process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { dataDirectory } from "./store.js";
if (existsSync(".env.local")) loadEnvFile(".env.local");
process.umask(0o077);
const port = Number(process.env.FINANCE_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("FINANCE_PORT 无效");
const { app, store, token } = await buildApp({ port });
const dir = dataDirectory();
mkdirSync(dir, { recursive: true, mode: 0o700 });
await app.listen({ host: "127.0.0.1", port });
writeFileSync(
  join(dir, "session.json"),
  JSON.stringify({ port, token, pid: process.pid }),
  { mode: 0o600 },
);
console.log(
  `Finance 已在 http://127.0.0.1:${port} 启动。使用 npm run open 安全打开工作台。`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
