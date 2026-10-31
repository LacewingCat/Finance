import { createRequire } from "node:module";

// This module is only imported by the server. It never exposes a key through status or errors.
const require = createRequire(import.meta.url);
const SERVICE = "Finance.local.OpenAI";
const ACCOUNT = "personal-platform-key";
type KeyringEntry = {
  getPassword(): string | null;
  setPassword(key: string): void;
  deleteCredential(): boolean;
};
function entry(): KeyringEntry {
  const { Entry } =
    require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return new Entry(SERVICE, ACCOUNT);
}
export interface KeyStatus {
  configured: boolean;
  source: "environment" | "keychain" | "none" | "injected";
}
export function getApiKey(): string | undefined {
  // Explicit project environment takes priority; never scan other projects or user profiles.
  const value = process.env.OPENAI_API_KEY?.trim();
  if (value) return value;
  try {
    return entry().getPassword() || undefined;
  } catch {
    return undefined;
  }
}
export function keyStatus(): KeyStatus {
  if (process.env.OPENAI_API_KEY?.trim())
    return { configured: true, source: "environment" };
  try {
    const configured = !!entry().getPassword();
    return { configured, source: configured ? "keychain" : "none" };
  } catch {
    return { configured: false, source: "none" };
  }
}
export function saveApiKey(key: string): KeyStatus {
  if (
    typeof key !== "string" ||
    key.length < 16 ||
    key.length > 512 ||
    /\s/.test(key)
  )
    throw new Error("API Key 格式无效");
  try {
    entry().setPassword(key);
  } catch {
    throw new Error("无法写入 macOS Keychain；请检查本机钥匙串权限");
  }
  return {
    configured: true,
    source: process.env.OPENAI_API_KEY?.trim() ? "environment" : "keychain",
  };
}
export function deleteApiKey(): KeyStatus {
  try {
    entry().deleteCredential();
  } catch {
    /* Absence is idempotent; environment credentials remain managed by the user. */
  }
  return keyStatus();
}
