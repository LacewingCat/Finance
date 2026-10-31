import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetManager, type Reservation } from "../src/server/budget.js";
import { DEFAULT_SETTINGS } from "../src/server/config.js";
import { ProbeBudgetStore } from "../src/server/probe-budget.js";
import { Store } from "../src/server/store.js";
import type { AppSettings } from "../src/shared/types.js";

const now = () => new Date("2026-11-01T02:00:00Z");
const settings: AppSettings = {
  ...structuredClone(DEFAULT_SETTINGS),
  apiEnabled: true,
  monthlyLimit: "90",
  creditConfirmed: true,
  creditAmount: "100",
  creditStartsAt: "2026-10-20T00:00:00+08:00",
  creditExpiresAt: "2026-11-20T00:00:00+08:00",
};
const input = {
  model: "gpt-6-luna",
  endpoint: "decisions" as const,
  category: "decisions" as const,
  reservedMicros: 100_000,
};
const resources: { directory: string; stores: Store[] }[] = [];
function fixture(patch: Partial<AppSettings> = {}, cap = 500_000) {
  const directory = mkdtempSync(join(tmpdir(), "finance-probe-budget-"));
  const file = join(directory, "production.sqlite");
  const production = new Store(file);
  const otherConnection = new Store(file);
  const isolated = new Store(join(directory, "synthetic.sqlite"));
  resources.push({
    directory,
    stores: [production, otherConnection, isolated],
  });
  const cfg = { ...settings, ...patch };
  production.put("settings", "app", cfg);
  isolated.put("settings", "app", { ...settings, apiEnabled: true });
  const probe = new ProbeBudgetStore(production, isolated, cap, now);
  return { production, otherConnection, isolated, probe, cfg, directory };
}
function legacy(patch: Partial<Reservation> = {}): Reservation {
  return {
    ...input,
    id: randomUUID(),
    status: "ambiguous",
    createdAt: now().toISOString(),
    ...patch,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { stores, directory } of resources.splice(0)) {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("shared production and API probe budget", () => {
  it.each([
    { monthlyLimit: "6", creditAmount: "100" },
    { monthlyLimit: "90", creditAmount: "6" },
  ])(
    "combines app and probe reservations across independent connections: %j",
    (patch) => {
      const { probe, otherConnection, production, cfg } = fixture(patch);
      const app = new BudgetManager(otherConnection, now);
      const test = new BudgetManager(probe, now);
      app.reserve(cfg, { ...input, reservedMicros: 700_000 });
      const reservation = test.reserve(cfg, {
        ...input,
        reservedMicros: 200_000,
      });
      expect(app.summary(cfg).remaining).toBe("0.100000");
      expect(() =>
        app.reserve(cfg, { ...input, reservedMicros: 100_001 }),
      ).toThrow();
      expect(() =>
        test.reserve(cfg, { ...input, reservedMicros: 100_001 }),
      ).toThrow();
      expect(production.list("ai-budget")).toHaveLength(2);
      expect(probe.records().map((r) => r.id)).toEqual([reservation.id]);
      expect(probe.accountedMicros()).toBe(200_000);
    },
  );

  it("cannot add a probe allowance above the production USD 90 monthly cap", () => {
    const { probe, otherConnection, cfg } = fixture(
      { creditAmount: "200" },
      20_000_000,
    );
    const app = new BudgetManager(otherConnection, now);
    for (const [category, dollars] of [
      ["decisions", 44],
      ["brief", 14],
      ["chat", 10],
      ["review", 5],
      ["amounts", 5],
      ["verification", 5],
    ] as const)
      app.reserve(cfg, {
        ...input,
        category,
        reservedMicros: dollars * 1_000_000,
      });
    const test = new BudgetManager(probe, now);
    test.reserve(cfg, {
      ...input,
      category: "brief",
      reservedMicros: 1_000_000,
    });
    test.reserve(cfg, { ...input, reservedMicros: 1_000_000 });
    expect(app.summary(cfg).remaining).toBe("0.000000");
    expect(() => test.reserve(cfg, { ...input, reservedMicros: 1 })).toThrow();
  });

  it.each([
    { monthlyLimit: "5.15" },
    { creditAmount: "5.15" },
    { creditConfirmed: false },
    { creditExpiresAt: "2026-11-01T01:59:59Z" },
  ])(
    "rechecks current production fields inside the final reservation transaction: %j",
    (patch) => {
      const { probe, production, otherConnection, cfg } = fixture();
      const stale = probe.get<AppSettings>("settings", "app")!;
      otherConnection.put("settings", "app", { ...cfg, ...patch });
      expect(() =>
        new BudgetManager(probe, now).reserve(stale, {
          ...input,
          reservedMicros: 200_000,
        }),
      ).toThrow();
      expect(production.list("ai-budget")).toHaveLength(0);
      expect(production.list("ai-probe-requests")).toHaveLength(0);
    },
  );

  it("shares the global overrun latch in both directions", () => {
    const { probe, production, otherConnection, cfg } = fixture();
    const test = new BudgetManager(probe, now);
    const reservation = test.reserve(cfg, { ...input, reservedMicros: 1000 });
    test.settle(reservation.id, { input_tokens: 20_000, output_tokens: 0 });
    expect(production.get("ai-budget-state", "blocked")).toBe(true);
    expect(() =>
      new BudgetManager(otherConnection, now).reserve(cfg, input),
    ).toThrow();
    expect(() => test.reserve(cfg, input)).toThrow();
    expect(() => probe.put("ai-budget-state", "blocked", false)).toThrow();
  });

  it("preserves a committed reservation across probe crash, missing audit and new isolated database", () => {
    const { probe, production, otherConnection, isolated, directory, cfg } =
      fixture({}, 150_000);
    const reservation = new BudgetManager(probe, now).reserve(cfg, input);
    vi.spyOn(isolated, "put").mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    expect(() => probe.put("ai-audit", reservation.id, {})).toThrow(
      "disk failure",
    );
    const restartedIsolation = new Store(
      join(directory, "new-synthetic.sqlite"),
    );
    resources.at(-1)!.stores.push(restartedIsolation);
    const restarted = new ProbeBudgetStore(
      otherConnection,
      restartedIsolation,
      150_000,
      now,
    );
    expect(
      production.get<Reservation>("ai-budget", reservation.id)?.status,
    ).toBe("reserved");
    expect(restarted.accountedMicros()).toBe(100_000);
    expect(() => new BudgetManager(restarted, now).reserve(cfg, input)).toThrow(
      "Lifetime",
    );
    expect(production.list("ai-probe-requests")).toHaveLength(1);
  });

  it("counts only probe-owned lifetime expenses toward its cap, including prior months", () => {
    const { production, isolated, cfg } = fixture({}, 150_000);
    const old = legacy({
      createdAt: "2026-09-10T00:00:00Z",
      status: "settled",
      actualMicros: 100_000,
    });
    isolated.put("ai-budget", old.id, old);
    const probe = new ProbeBudgetStore(production, isolated, 150_000, now);
    new BudgetManager(production, now).reserve(cfg, {
      ...input,
      reservedMicros: 2_000_000,
    });
    expect(probe.accountedMicros()).toBe(100_000);
    expect(() => new BudgetManager(probe, now).reserve(cfg, input)).toThrow(
      "Lifetime",
    );
  });

  it("migrates legacy records idempotently and never downgrades production settled to ambiguous", () => {
    const { production, isolated } = fixture();
    const old = legacy();
    isolated.put("ai-budget", old.id, old);
    const settled = {
      ...old,
      status: "settled" as const,
      actualMicros: 1234,
      completedAt: now().toISOString(),
    };
    production.put("ai-budget", old.id, settled);
    const pending = legacy();
    isolated.put("ai-budget", pending.id, pending);
    const probe = new ProbeBudgetStore(production, isolated, 500_000, now);
    new ProbeBudgetStore(production, isolated, 500_000, now);
    expect(production.list("ai-budget")).toHaveLength(2);
    expect(production.get("ai-budget", old.id)).toEqual(settled);
    expect(production.get<Reservation>("ai-budget", pending.id)?.status).toBe(
      "ambiguous",
    );
    expect(probe.accountedMicros()).toBe(101_234);
  });

  it("rolls back all legacy imports on conflicting request identity or settled cost", () => {
    for (const conflict of [{ model: "gpt-6.1-sol" }, { actualMicros: 2000 }]) {
      const { production, isolated } = fixture();
      const first = legacy();
      const second = legacy({ status: "settled", actualMicros: 1000 });
      isolated.put("ai-budget", first.id, first);
      isolated.put("ai-budget", second.id, second);
      production.put("ai-budget", second.id, { ...second, ...conflict });
      expect(
        () => new ProbeBudgetStore(production, isolated, 500_000, now),
      ).toThrow("Conflicting");
      expect(production.get("ai-budget", first.id)).toBeUndefined();
      expect(production.list("ai-probe-requests")).toHaveLength(0);
    }
  });

  it("imports a legacy global block without clearing an existing production block", () => {
    const { production, isolated, cfg } = fixture();
    isolated.put("ai-budget-state", "blocked", true);
    const probe = new ProbeBudgetStore(production, isolated, 500_000, now);
    expect(() => new BudgetManager(probe, now).reserve(cfg, input)).toThrow();
    isolated.remove("ai-budget-state", "blocked");
    new ProbeBudgetStore(production, isolated, 500_000, now);
    expect(production.get("ai-budget-state", "blocked")).toBe(true);
  });

  it("keeps synthetic records, prompts and API enablement isolated; projects only budget fields", () => {
    const { production, isolated, probe, cfg } = fixture({
      apiEnabled: false,
      monthlyLimit: "7",
    });
    production.put("settings", "app", {
      ...cfg,
      privateSentinel: "never export",
    });
    production.put("transactions", "real", { amount: "private" });
    probe.put("prompts", "chat", { text: "test" });
    probe.put("transactions", "synthetic", { amount: "1.00" });
    const projected = probe.get<AppSettings>("settings", "app")!;
    expect(projected.apiEnabled).toBe(true);
    expect(projected.monthlyLimit).toBe("7");
    expect(projected).not.toHaveProperty("privateSentinel");
    expect(probe.list("transactions")).toEqual([{ amount: "1.00" }]);
    expect(production.get("prompts", "chat")).toBeUndefined();
    expect(production.get("transactions", "synthetic")).toBeUndefined();
    expect(production.get<AppSettings>("settings", "app")?.apiEnabled).toBe(
      false,
    );
    new BudgetManager(probe, now).reserve(projected, input);
    expect(isolated.list("ai-budget")).toHaveLength(0);
    expect(production.list("ai-budget")).toHaveLength(1);
  });

  it("cannot mutate app expenses or release ambiguous probe reservations", () => {
    const { probe, production, cfg } = fixture();
    const app = new BudgetManager(production, now).reserve(cfg, input);
    expect(() =>
      probe.put("ai-budget", app.id, { ...app, status: "released" }),
    ).toThrow();
    const test = new BudgetManager(probe, now);
    const owned = test.reserve(cfg, input);
    test.ambiguous(owned.id);
    expect(() =>
      probe.put("ai-budget", owned.id, { ...owned, status: "released" }),
    ).toThrow();
    expect(probe.accountedMicros()).toBe(100_000);
  });
});
