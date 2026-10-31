import { describe, expect, it } from "vitest";
import {
  BudgetManager,
  estimateReservation,
  shanghaiMonth,
  usageCostMicros,
  type BudgetStore,
} from "../src/server/budget.js";
import type { AppSettings } from "../src/shared/types.js";

class MemoryStore implements BudgetStore {
  values = new Map<string, unknown>();
  get<T>(ns: string, key: string): T | undefined {
    return structuredClone(this.values.get(ns + ":" + key)) as T | undefined;
  }
  put(ns: string, key: string, value: unknown) {
    this.values.set(ns + ":" + key, structuredClone(value));
  }
  list<T>(ns: string): T[] {
    return [...this.values]
      .filter(([key]) => key.startsWith(ns + ":"))
      .map(([, v]) => structuredClone(v) as T);
  }
  atomic<T>(fn: () => T): T {
    const before = new Map(this.values);
    try {
      return fn();
    } catch (e) {
      this.values = before;
      throw e;
    }
  }
}
const settings = {
  apiEnabled: true,
  creditConfirmed: true,
  monthlyLimit: "90",
  creditAmount: "90",
  creditStartsAt: "2026-10-20T00:00:00+08:00",
  creditExpiresAt: "2026-11-20T00:00:00+08:00",
} as AppSettings;
const at = () => new Date("2026-11-01T02:00:00Z");
const item = {
  category: "decisions" as const,
  model: "gpt-6-luna",
  endpoint: "decisions" as const,
  reservedMicros: 1_000_000,
};

describe("persistent budget admission and accounting", () => {
  it("uses Shanghai calendar month and a separate rolling credit period with $5 buffers", () => {
    expect(shanghaiMonth(new Date("2026-10-31T16:00:00Z"))).toBe("2026-11");
    const b = new BudgetManager(new MemoryStore(), at);
    expect(b.summary(settings)).toMatchObject({
      limit: "85.000000",
      remaining: "85.000000",
      enabled: true,
    });
    expect(b.summary({ ...settings, monthlyLimit: "500" }).limit).toBe(
      "85.000000",
    );
    expect(b.summary({ ...settings, creditAmount: "12" }).remaining).toBe(
      "7.000000",
    );
  });
  it("blocks disabled, unconfirmed, future, expired, invalid and oversized credit windows", () => {
    const b = new BudgetManager(new MemoryStore(), at);
    for (const patch of [
      { apiEnabled: false },
      { creditConfirmed: false },
      { creditStartsAt: "2026-11-02" },
      { creditExpiresAt: "2026-10-31" },
      { creditExpiresAt: "garbage" },
      { creditExpiresAt: "2027-11-01" },
      { creditAmount: "-1" },
    ]) {
      expect(() => b.reserve({ ...settings, ...patch }, item)).toThrow();
    }
    expect(b.records()).toHaveLength(0);
  });
  it("accepts an explicitly confirmed 60-day credit period and stops exactly at its expiry", () => {
    const sixtyDays = {
      ...settings,
      creditAmount: "10",
      creditStartsAt: "2026-09-15T00:00:00+08:00",
      creditExpiresAt: "2026-11-14T00:00:00+08:00",
    };
    const store = new MemoryStore();
    const active = new BudgetManager(store, at);
    expect(active.summary(sixtyDays)).toMatchObject({ enabled: true, creditRemaining: "5.000000" });
    active.reserve(sixtyDays, item);
    const expired = new BudgetManager(store, () => new Date(sixtyDays.creditExpiresAt));
    expect(expired.summary(sixtyDays).enabled).toBe(false);
    expect(() => expired.reserve(sixtyDays, item)).toThrow("过期");
  });
  it("persists pending/ambiguous reservations across service restarts and month rollover", () => {
    const store = new MemoryStore();
    const old = new BudgetManager(
      store,
      () => new Date("2026-10-31T15:59:59Z"),
    );
    const r = old.reserve(settings, item);
    old.ambiguous(r.id);
    const restarted = new BudgetManager(store, at);
    expect(restarted.summary(settings)).toMatchObject({
      reserved: "1.000000",
      remaining: "84.000000",
    });
    expect(restarted.records()[0].status).toBe("ambiguous");
    restarted.releaseUnsent(r.id);
    expect(restarted.records()[0].status).toBe("ambiguous");
  });
  it("enforces category limits atomically and blocks competing admissions", () => {
    const b = new BudgetManager(new MemoryStore(), at);
    b.reserve(settings, { ...item, reservedMicros: 44_000_000 });
    expect(() =>
      b.reserve(settings, { ...item, reservedMicros: 2_000_000 }),
    ).toThrow();
    b.reserve(settings, {
      ...item,
      category: "chat",
      reservedMicros: 10_000_000,
    });
    expect(() =>
      b.reserve(settings, { ...item, category: "chat", reservedMicros: 1 }),
    ).toThrow();
    expect(b.records()).toHaveLength(2);
  });
  it("accounts shared credit usage across natural months", () => {
    const store = new MemoryStore();
    const previous = new BudgetManager(
      store,
      () => new Date("2026-10-25T00:00:00Z"),
    );
    const r = previous.reserve(settings, {
      ...item,
      reservedMicros: 4_000_000,
    });
    previous.settle(r.id, { input_tokens: 20_000_000, output_tokens: 0 });
    const current = new BudgetManager(store, at);
    expect(current.summary(settings)).toMatchObject({
      spent: "0.000000",
      creditRemaining: "83.000000",
      remaining: "83.000000",
    });
  });
  it("charges actual usage once, including cache writes, without double-counting reasoning", () => {
    const usage = {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 },
      output_tokens: 500,
      output_tokens_details: { reasoning_tokens: 400 },
    };
    expect(usageCostMicros("gpt-6-luna", "responses", usage)).toBe(346);
    expect(usageCostMicros("gpt-6-luna", "decisions", usage)).toBe(96);
    const b = new BudgetManager(new MemoryStore(), at),
      r = b.reserve(settings, item);
    b.settle(r.id, usage);
    b.settle(r.id, usage);
    expect(b.summary(settings)).toMatchObject({
      spent: "0.000096",
      reserved: "0.000000",
    });
  });
  it("retains reservation for unknown usage and trips a circuit breaker for overruns", () => {
    const b = new BudgetManager(new MemoryStore(), at),
      r = b.reserve(settings, { ...item, reservedMicros: 100 });
    expect(() =>
      b.settle(r.id, {
        input_tokens: 10,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 11 },
      }),
    ).toThrow();
    expect(b.records()[0].status).toBe("reserved");
    b.settle(r.id, { input_tokens: 10_000, output_tokens: 0 });
    expect(b.summary(settings).enabled).toBe(false);
  });
  it("blocks unknown pricing, large contexts and expired price manifests", () => {
    expect(() =>
      estimateReservation("unknown", "responses", {}, 100, 1, at()),
    ).toThrow();
    expect(() =>
      estimateReservation(
        "gpt-6-luna",
        "responses",
        { input: "中".repeat(20_000) },
        100,
        1,
        at(),
      ),
    ).toThrow();
    expect(() =>
      estimateReservation(
        "gpt-6-luna",
        "responses",
        {},
        100,
        1,
        new Date("2026-12-01"),
      ),
    ).toThrow();
    expect(
      estimateReservation(
        "gpt-6-luna",
        "decisions",
        { input: "evidence" },
        0,
        2,
        at(),
      ),
    ).toBeGreaterThan(
      estimateReservation(
        "gpt-6-luna",
        "decisions",
        { input: "evidence" },
        0,
        1,
        at(),
      ),
    );
  });
});
