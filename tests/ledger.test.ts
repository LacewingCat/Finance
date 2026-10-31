import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../src/server/store.js";
import {
  recordTransaction,
  reverseTransaction,
  transactions,
  replay,
} from "../src/server/ledger.js";
import { snapshot } from "../src/server/portfolio.js";
import type {
  TransactionInput,
  Instrument,
  ProductData,
} from "../src/shared/types.js";
const stores: Store[] = [];
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const instrument: Instrument = {
    code: "TEST01",
    name: "合成基金",
    kind: "fund",
    currency: "CNY",
    market: "CN",
  };
  store.put("instruments", instrument.code, instrument);
  store.put("products", instrument.code, {
    instrument,
    observation: {
      code: "TEST01",
      price: "12",
      asOf: "2026-10-30",
      fetchedAt: "2026-10-31",
      currency: "CNY",
      priceKind: "nav",
      source: "synthetic",
      sourceUrl: "https://example.com",
      quality: "valid",
    },
    history: [],
    exposures: [],
    documents: [],
    errors: [],
    fetchedAt: "2026-10-31",
  } satisfies ProductData);
  let n = 0;
  const add = (
    kind: TransactionInput["kind"],
    amount: string,
    extra: Partial<TransactionInput> = {},
  ) =>
    recordTransaction(store, {
      kind,
      amount,
      code:
        kind === "deposit" || kind === "withdraw" || kind === "fx"
          ? undefined
          : "TEST01",
      account: "本地测试",
      currency: "CNY",
      date: "2026-10-30",
      idempotencyKey: String(n++),
      ...extra,
    });
  return { store, add };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
describe("ledger accounting", () => {
  it("reconciles buy partial sell dividends fees and reversal", () => {
    const { store, add } = setup();
    add("deposit", "2000");
    add("buy", "1000", { quantity: "100", fee: "2" });
    add("sell", "600", { quantity: "50", fee: "1" });
    add("dividend", "10");
    const snap = snapshot(store);
    expect(snap.totalValue).toBe("2207.00");
    expect(snap.realizedPnl).toBe("100.00");
    expect(snap.unrealizedPnl).toBe("100.00");
    expect(snap.totalPnl).toBe("207.00");
    expect(snap.reconciliation).toBe("0.00");
  });
  it("keeps subscription and redemption in transit until confirmed and settled", () => {
    const { store, add } = setup();
    add("deposit", "2000");
    const sub = add("subscribe", "1000");
    expect(snapshot(store).positions).toHaveLength(0);
    expect(snapshot(store).frozen.CNY).toBe("1000");
    add("confirm", "990", { quantity: "99", parentId: sub.id, fee: "10" });
    expect(snapshot(store).positions[0].quantity).toBe("99");
    const redeem = add("redeem", "0", { quantity: "20" });
    const conf = add("confirm", "240", { parentId: redeem.id, fee: "1" });
    expect(snapshot(store).receivables.CNY).toBe("239");
    const before = snapshot(store).cash.CNY;
    add("settle", "239", { parentId: conf.id });
    expect(Number(snapshot(store).cash.CNY) - Number(before)).toBe(239);
    expect(snapshot(store).reconciliation).toBe("0.00");
  });
  it("rejects cross-account disposal, overselling and duplicate settlements", () => {
    const { store, add } = setup();
    add("deposit", "100");
    add("buy", "100", { quantity: "10" });
    expect(() =>
      add("sell", "10", { quantity: "1", account: "另一账户" }),
    ).toThrow("可卖份额不足");
    expect(() => add("sell", "200", { quantity: "20" })).toThrow();
    expect(transactions(store)).toHaveLength(2);
  });
  it("deduplicates exact retries, rejects changed payload and reverses once", () => {
    const { store } = setup();
    const input: TransactionInput = {
      kind: "deposit",
      amount: "100",
      currency: "CNY",
      account: "x",
      date: "2026-10-30",
      idempotencyKey: "same",
    };
    const t = recordTransaction(store, input);
    expect(recordTransaction(store, input).id).toBe(t.id);
    expect(() => recordTransaction(store, { ...input, amount: "200" })).toThrow(
      "幂等",
    );
    const reverse = reverseTransaction(store, t.id);
    expect(reverseTransaction(store, t.id)?.id).toBe(reverse?.id);
    expect(snapshot(store).totalValue).toBe("0.00");
  });
  it("does not allow reversing a funding event with dependent purchases", () => {
    const { store, add } = setup();
    const dep = add("deposit", "100");
    add("buy", "100", { quantity: "10" });
    expect(() => reverseTransaction(store, dep.id)).toThrow();
    expect(
      transactions(store).find((t) => t.id === dep.id)?.reversedBy,
    ).toBeUndefined();
  });
  it("preserves cents using decimals and marks missing FX unknown", () => {
    const { store, add } = setup();
    add("deposit", "0.30");
    add("withdraw", "0.10");
    expect(snapshot(store).cash.CNY).toBe("0.2");
    add("deposit", "10", { currency: "USD" });
    expect(snapshot(store).totalValue).toBeNull();
    expect(snapshot(store).totalPnl).toBeNull();
  });
  it("cancelled subscriptions return frozen cash without manufacturing units", () => {
    const { store, add } = setup();
    add("deposit", "100");
    const sub = add("subscribe", "50");
    add("cancel", "0", { parentId: sub.id });
    expect(snapshot(store).cash.CNY).toBe("100");
    expect(snapshot(store).positions).toHaveLength(0);
  });
  it("cash dividend reinvestment enters income once", () => {
    const { store, add } = setup();
    add("deposit", "1000");
    add("buy", "1000", { quantity: "100" });
    add("reinvest", "12", { quantity: "1" });
    const s = snapshot(store);
    expect(s.income).toBe("12.00");
    expect(s.totalPnl).toBe("212.00");
    expect(s.reconciliation).toBe("0.00");
  });
  it("rejects zero-principal FX and unconfirmed zero-value reinvestment without creating assets", () => {
    const { store, add } = setup();
    expect(() =>
      add("fx", "0", { toCurrency: "USD", toAmount: "1000" }),
    ).toThrow("本金");
    expect(() => add("reinvest", "0", { quantity: "1000" })).toThrow("红利");
    expect(transactions(store)).toHaveLength(0);
    expect(snapshot(store).totalValue).toBe("0.00");
  });
  it("rejects future/invalid dates and fractional cents while preserving fractional share precision", () => {
    const { store, add } = setup();
    for (const date of ["9999-01-01", "2026-02-30", "2026-13-01", "2026-00-01"])
      expect(() => add("deposit", "100", { date })).toThrow();
    expect(() => add("deposit", "0.001")).toThrow();
    add("deposit", "1.01");
    add("buy", "1.00", { quantity: "0.12345678", fee: "0.01" });
    expect(snapshot(store).cash.CNY).toBe("0");
    expect(snapshot(store).positions[0].quantity).toBe("0.12345678");
  });
  it("accounts settlement and cancellation fees instead of silently discarding them", () => {
    const { store, add } = setup();
    add("deposit", "100");
    const sub = add("subscribe", "40");
    add("cancel", "0", { parentId: sub.id, fee: "0.25" });
    expect(snapshot(store).cash.CNY).toBe("99.75");
    add("buy", "50", { quantity: "5" });
    const redeem = add("redeem", "0", { quantity: "2" });
    const confirmation = add("confirm", "24", {
      parentId: redeem.id,
      fee: "1",
    });
    expect(() =>
      add("settle", "23", { parentId: confirmation.id, fee: "0.50" }),
    ).toThrow();
    add("settle", "22.50", { parentId: confirmation.id, fee: "0.50" });
    const s = snapshot(store);
    expect(s.cash.CNY).toBe("72.25");
    expect(s.fees).toBe("1.75");
    expect(s.receivables.CNY).toBe("0");
    expect(s.reconciliation).toBe("0.00");
  });
  it("rejects ignored fees and estimated application units or redemption amounts", () => {
    const { add } = setup();
    add("deposit", "100");
    for (const kind of ["fee", "tax", "opening"] as const)
      expect(() => add(kind, "1", { fee: "0.10", quantity: "1" })).toThrow();
    expect(() => add("subscribe", "10", { quantity: "1" })).toThrow("确认");
    add("buy", "10", { quantity: "1" });
    expect(() => add("redeem", "10", { quantity: "1" })).toThrow("尚未确认");
  });
  it("allocates partial disposal basis to cents with the last disposal clearing all residual cost", () => {
    const { store, add } = setup();
    add("deposit", "100");
    add("buy", "100", { quantity: "3" });
    add("sell", "40", { quantity: "1" });
    let state = replay(transactions(store));
    expect(state.positions.get("本地测试|TEST01")?.cost.toFixed()).toBe(
      "66.67",
    );
    expect(state.realized.get("CNY")?.toFixed()).toBe("6.67");
    add("sell", "40", { quantity: "1" });
    state = replay(transactions(store));
    expect(state.positions.get("本地测试|TEST01")?.cost.toFixed()).toBe(
      "33.33",
    );
    add("sell", "40", { quantity: "1" });
    state = replay(transactions(store));
    expect(state.positions.get("本地测试|TEST01")?.cost.toFixed()).toBe("0");
    expect(state.realized.get("CNY")?.toFixed()).toBe("20");
    expect(snapshot(store).reconciliation).toBe("0.00");
  });
  it("binds confirmations to the original account, currency, date and reserved units", () => {
    const { store, add } = setup();
    add("opening", "100", { quantity: "10" });
    const redeem = add("redeem", "0", { quantity: "6" });
    expect(() => add("sell", "50", { quantity: "5" })).toThrow();
    expect(() =>
      add("confirm", "60", { parentId: redeem.id, account: "另一账户" }),
    ).toThrow("原账户");
    expect(() =>
      add("confirm", "60", { parentId: redeem.id, currency: "USD" }),
    ).toThrow("币种");
    expect(() =>
      add("confirm", "60", { parentId: redeem.id, date: "2026-10-29" }),
    ).toThrow();
    expect(() =>
      add("confirm", "60", { parentId: redeem.id, quantity: "3" }),
    ).toThrow("部分确认");
    const confirmed = add("confirm", "60", {
      parentId: redeem.id,
      quantity: "6",
    });
    expect(() => add("confirm", "60", { parentId: redeem.id })).toThrow();
    const settled = add("settle", "60", { parentId: confirmed.id });
    expect(() => add("settle", "60", { parentId: confirmed.id })).toThrow();
    expect(() => reverseTransaction(store, confirmed.id)).toThrow();
    reverseTransaction(store, settled.id);
    reverseTransaction(store, confirmed.id);
    const state = replay(transactions(store));
    expect(state.positions.get("本地测试|TEST01")?.quantity.toFixed()).toBe(
      "10",
    );
    expect(state.positions.get("本地测试|TEST01")?.reserved.toFixed()).toBe(
      "6",
    );
  });
});
