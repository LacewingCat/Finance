import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../src/server/store.js";
import { buildApp } from "../src/server/app.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const store = new Store(":memory:");
  const result = await buildApp({
    store,
    token: "test-token",
    port: 4318,
    staticDir: "/nonexistent",
  });
  cleanups.push(async () => {
    await result.app.close();
    store.close();
  });
  const login = await result.app.inject({
    method: "POST",
    url: "/api/session",
    headers: { host: "127.0.0.1:4318" },
    payload: { token: "test-token" },
  });
  const cookie = login.cookies[0].name + "=" + login.cookies[0].value;
  const headers = {
    host: "127.0.0.1:4318",
    cookie,
    "x-csrf-token": login.json().csrf,
  };
  return { ...result, headers };
}
describe("local server privacy and persistence", () => {
  it("blocks missing authentication, cross-origin writes and DNS rebinding", async () => {
    const { app, headers } = await setup();
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { host: "127.0.0.1:4318" },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { ...headers, host: "evil.example:4318" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/transactions",
          headers: { ...headers, origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/transactions",
          headers: { host: headers.host, cookie: headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });
  it("starts with zero actual holdings and six reference watches", async () => {
    const { app, headers } = await setup();
    const r = await app.inject({ url: "/api/state", headers });
    expect(r.statusCode).toBe(200);
    expect(r.json().snapshot.positions).toHaveLength(0);
    expect(r.json().watched).toHaveLength(6);
    expect(r.json().budget.enabled).toBe(false);
    expect(r.json().notification.state).toBe("pending");
  });
  it("records a deposit and exports no secrets", async () => {
    const { app, headers } = await setup();
    const r = await app.inject({
      method: "POST",
      url: "/api/transactions",
      headers,
      payload: {
        kind: "deposit",
        amount: "1000",
        account: "测试",
        currency: "CNY",
        date: "2026-10-30",
        idempotencyKey: "d",
      },
    });
    expect(r.statusCode).toBe(200);
    const state = (await app.inject({ url: "/api/state", headers })).json();
    expect(state.snapshot.totalValue).toBe("1000.00");
    const exported = (await app.inject({ url: "/api/export", headers })).body;
    expect(exported).not.toMatch(/sk-proj-|OPENAI_API_KEY|finance_session/);
  });
  it("imports atomically and rolls back invalid replay", async () => {
    const { app, headers } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/import",
      headers,
      payload: {
        transactions: [
          {
            kind: "deposit",
            amount: "100",
            account: "a",
            currency: "CNY",
            date: "2026-10-30",
            idempotencyKey: "a",
          },
          {
            kind: "withdraw",
            amount: "200",
            account: "a",
            currency: "CNY",
            date: "2026-10-30",
            idempotencyKey: "b",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      (await app.inject({ url: "/api/transactions", headers })).json().items,
    ).toHaveLength(0);
  });
});
