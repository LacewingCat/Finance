import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const bad = [];
for (const file of files) {
  if (
    /(^|\/)(\.env(\..*)?|session\.json)$/.test(file) &&
    file !== ".env.example"
  ) {
    bad.push(`${file}: private configuration`);
    continue;
  }
  if (/\.(sqlite(?:-wal|-shm)?|db|pem|key|jpg|jpeg)$/i.test(file)) {
    bad.push(`${file}: private/binary file requires review`);
    continue;
  }
  const value = readFileSync(file, "utf8");
  // Test placeholders deliberately do not match real key lengths.
  if (
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/.test(value) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
  )
    bad.push(`${file}: credential pattern`);
}
if (bad.length) {
  console.error(bad.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Secret scan passed (${files.length} source files; ignored personal files excluded).`,
  );
