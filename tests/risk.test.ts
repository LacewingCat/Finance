import { describe, it, expect } from "vitest";
import {
  amountCandidates,
  triggerEligible,
  tradeWindow,
  settledQuantity,
  candidateCashRequired,
  candidateCashRequiredCny,
  fxRateToCny,
} from "../src/server/risk.js";
import { Decimal } from "decimal.js";
import { Store } from "../src/server/store.js";
import { snapshot } from "../src/server/portfolio.js";
import { recordTransaction } from "../src/server/ledger.js";
import { DEFAULT_SETTINGS } from "../src/server/config.js";
import type {
  DecisionResult,
  PortfolioSnapshot,
  ProductData,
  Instrument,
} from "../src/shared/types.js";
const instrument: Instrument = {
  code: "X",
  name: "Synthetic",
  kind: "fund",
  currency: "CNY",
  market: "CN",
  rulesVerified: true,
  purchasable: true,
  minBuy: "1",
  feeRate: "0",
  channel: "CMB",
};
const snap: PortfolioSnapshot = {
  id: "s",
  createdAt: "2026-10-30T02:00:00Z",
  revision: 1,
  positions: [],
  cash: { CNY: "1000" },
  accountCash: { CMB: { CNY: "1000" } },
  frozen: {},
  receivables: {},
  totalValue: "1000",
  investedCost: "0",
  realizedPnl: "0",
  unrealizedPnl: "0",
  income: "0",
  fees: "0",
  externalFlows: "1000",
  totalPnl: "0",
  reconciliation: "0",
  warnings: [],
  risk: {
    minimumCash: "100",
    singleTradeLimit: "500",
    maxPositionPct: "50",
    configured: true,
  },
};
const product: ProductData = {
  instrument,
  observation: {
    code: "X",
    price: "1",
    asOf: "2026-10-29",
    fetchedAt: "2026-10-30",
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
  fetchedAt: "2026-10-30",
};
const cfg = {
  ...DEFAULT_SETTINGS,
  risk: snap.risk,
  calendarVerifiedThrough: { CN: "2026-12-31" },
};
const dec: DecisionResult = {
  code: "X",
  snapshotId: "s",
  asOf: "2026-10-29",
  generatedAt: "2026-10-30T02:00:00Z",
  buy: 0.9,
  sell: 0.05,
  hold: 0.05,
  confidence: 0.99,
  score: 8,
  status: "valid",
  model: "gpt-6-luna",
  promptVersion: 1,
};
describe("deterministic decision gates", () => {
  it("strictly exceeds 90 percent and respects original snapshot", () => {
    const now = new Date("2026-10-30T02:00:00Z");
    expect(triggerEligible(dec, snap, product, cfg, now).eligible).toBe(false);
    expect(
      triggerEligible(
        { ...dec, buy: 0.91, sell: 0.04 },
        snap,
        product,
        cfg,
        now,
      ).eligible,
    ).toBe(true);
    expect(
      triggerEligible(
        { ...dec, buy: 0.91, sell: 0.04, snapshotId: "old" },
        snap,
        product,
        cfg,
        now,
      ).eligible,
    ).toBe(false);
  });
  it("stops outside trading hours, unverified calendars, and source conflicts", () => {
    expect(
      tradeWindow(instrument, cfg, new Date("2026-10-31T02:00:00Z")).open,
    ).toBe(false);
    expect(
      tradeWindow(
        instrument,
        DEFAULT_SETTINGS,
        new Date("2026-10-30T02:00:00Z"),
      ).open,
    ).toBe(false);
    expect(
      triggerEligible(
        { ...dec, buy: 0.99 },
        snap,
        {
          ...product,
          observation: { ...product.observation!, quality: "conflict" },
        },
        cfg,
        new Date("2026-10-30T02:00:00Z"),
      ).eligible,
    ).toBe(false);
  });
  it("reserves one shared cash budget, never exceeds position caps", () => {
    expect(
      amountCandidates(snap, instrument, "Buy").map((c) => c.amount),
    ).toEqual(["125.00", "250.00", "500.00"]);
    expect(
      amountCandidates(snap, instrument, "Buy", "800").at(-1)?.amount,
    ).toBe("100.00");
    expect(
      amountCandidates(
        { ...snap, risk: { ...snap.risk, configured: false } },
        instrument,
        "Buy",
      ),
    ).toEqual([]);
  });
  it("cannot spend another account cash or invent a missing account mapping", () => {
    const split = {
      ...snap,
      accountCash: { CMB: { CNY: "20" }, BOC: { CNY: "980" } },
    };
    expect(amountCandidates(split, instrument, "Buy").at(-1)?.amount).toBe(
      "20.00",
    );
    expect(
      amountCandidates(split, { ...instrument, channel: "unknown" }, "Buy"),
    ).toEqual([]);
    expect(
      amountCandidates({ ...snap, accountCash: undefined }, instrument, "Buy"),
    ).toEqual([]);
    expect(
      amountCandidates(snap, { ...instrument, feeRate: undefined }, "Buy"),
    ).toEqual([]);
  });
  it("never combines accounts to satisfy a stock lot and reports percent of the whole product holding", () => {
    const stock: Instrument = { ...instrument, kind: "stock", lotSize: "100" };
    const position = {
      code: "X",
      name: "Synthetic",
      currency: "CNY" as const,
      quantity: "100",
      sellable: "100",
      cost: "100",
      averageCost: "1",
      price: "1",
      marketValue: "100",
      instrument: stock,
      accounts: [
        { account: "CMB", quantity: "50", sellable: "50", marketValue: "50" },
        { account: "BOC", quantity: "50", sellable: "50", marketValue: "50" },
      ],
    };
    const s = { ...snap, positions: [position] };
    expect(amountCandidates(s, stock, "Sell")).toEqual([]);
    expect(
      amountCandidates(s, { ...stock, lotSize: "1" }, "Sell").at(-1),
    ).toMatchObject({
      quantity: "50",
      amount: "50.00",
      percentage: "50.00",
      account: "CMB",
      currency: "CNY",
    });
    expect(
      amountCandidates(
        { ...s, positions: [{ ...position, accounts: undefined }] },
        stock,
        "Sell",
      ),
    ).toEqual([]);
  });
  it("rounds fee reservations upward and includes them in cash and single-trade caps", () => {
    const charged = { ...instrument, feeRate: "0.01" };
    const options = amountCandidates(snap, charged, "Buy");
    expect(options.at(-1)?.amount).toBe("495.04");
    for (const option of options)
      expect(
        Number(candidateCashRequired(option, charged)),
      ).toBeLessThanOrEqual(500);
    expect(candidateCashRequired({ amount: "0.01" }, charged)).toBe("0.02");
    const first = candidateCashRequired(options.at(-1)!, charged);
    const second = amountCandidates(
      {
        ...snap,
        risk: { ...snap.risk, singleTradeLimit: "900", maxPositionPct: "100" },
      },
      charged,
      "Buy",
      first,
    );
    expect(
      Number(first) + Number(candidateCashRequired(second.at(-1)!, charged)),
    ).toBeLessThanOrEqual(900);
  });
  it("exposes conservative estimated fees, buy cash and sell net without inventing settled proceeds", () => {
    const charged = { ...instrument, feeRate: "0.015" };
    const buy = amountCandidates(snap, charged, "Buy").at(-1)!;
    expect(buy).toMatchObject({
      account: "CMB",
      currency: "CNY",
      cashRequired: candidateCashRequired(buy, charged),
    });
    expect(buy.estimatedNet).toBeUndefined();
    expect(Number(buy.cashRequired)).toBeLessThanOrEqual(500);
    const position = {
      code: "X",
      name: "Synthetic",
      currency: "CNY" as const,
      quantity: "200",
      sellable: "100",
      cost: "200",
      averageCost: "1",
      price: "1.001",
      marketValue: "200.20",
      instrument: charged,
      accounts: [
        { account: "CMB", quantity: "100", sellable: "100" },
        { account: "BOC", quantity: "100", sellable: "0" },
      ],
    };
    const sell = amountCandidates(
      { ...snap, positions: [position] },
      charged,
      "Sell",
    ).at(-1)!;
    expect(sell).toMatchObject({
      amount: "100.10",
      quantity: "100",
      percentage: "50.00",
      estimatedFee: "1.51",
      estimatedNet: "98.59",
      account: "CMB",
      currency: "CNY",
    });
    expect(sell.cashRequired).toBeUndefined();
  });
  it("keeps the post-fee position fraction within its configured cap", () => {
    const charged = { ...instrument, feeRate: "0.1" };
    const s = { ...snap, risk: { ...snap.risk, singleTradeLimit: "1000" } };
    const buy = amountCandidates(s, charged, "Buy").at(-1)!;
    expect(
      Number(buy.amount) / (1000 - Number(buy.estimatedFee)),
    ).toBeLessThanOrEqual(0.5);
  });
  it("advances settlement only on verified trading days, preserving same-day and holiday locks", () => {
    const t2 = { ...instrument, settlementDays: 2 };
    const lots = [{ quantity: "10", date: "2026-10-30" }];
    const calendar = {
      ...cfg,
      holidays: { ...cfg.holidays, CN: ["2026-11-02"] },
    };
    expect(
      settledQuantity(
        t2,
        lots,
        calendar,
        new Date("2026-11-03T02:00:00Z"),
      ).toFixed(),
    ).toBe("0");
    expect(
      settledQuantity(
        t2,
        lots,
        calendar,
        new Date("2026-11-04T02:00:00Z"),
      ).toFixed(),
    ).toBe("10");
    expect(
      settledQuantity(
        t2,
        lots,
        DEFAULT_SETTINGS,
        new Date("2026-11-04T02:00:00Z"),
      ).toFixed(),
    ).toBe("0");
    expect(
      settledQuantity(
        { ...t2, settlementDays: 0 },
        lots,
        DEFAULT_SETTINGS,
        new Date("2026-10-30T02:00:00Z"),
      ).toFixed(),
    ).toBe("10");
  });
  it("rejects stale decision dates, mismatched products, invalid probabilities and future or estimated prices", () => {
    const now = new Date("2026-10-30T02:00:00Z"),
      valid = { ...dec, buy: 0.91, sell: 0.04 };
    for (const patch of [
      { generatedAt: "2026-10-30T01:54:59Z" },
      { generatedAt: "2026-10-30T03:00:00Z" },
      { code: "OTHER" },
      { buy: NaN },
      { buy: 1.2 },
    ])
      expect(
        triggerEligible({ ...valid, ...patch }, snap, product, cfg, now)
          .eligible,
      ).toBe(false);
    for (const patch of [
      { asOf: "invalid" },
      { asOf: "2026-11-01" },
      { fetchedAt: "invalid" },
      { priceKind: "estimate" as const },
      { price: "NaN" },
    ])
      expect(
        triggerEligible(
          valid,
          snap,
          { ...product, observation: { ...product.observation!, ...patch } },
          cfg,
          now,
        ).eligible,
      ).toBe(false);
  });
});

describe("multi-currency deterministic candidates", () => {
  const now = new Date("2026-10-30T15:00:00Z");
  const usd: Instrument = {
    ...instrument,
    code: "USD_TEST",
    name: "Synthetic USD stock",
    kind: "stock",
    market: "US",
    currency: "USD",
    channel: "USD account",
    lotSize: "1",
    feeRate: "0.01",
  };
  const usdPosition: PortfolioSnapshot["positions"][number] = {
    code: usd.code,
    name: usd.name,
    currency: "USD",
    quantity: "100",
    sellable: "100",
    cost: "1000",
    averageCost: "10",
    price: "10",
    marketValue: "1000",
    instrument: usd,
    accounts: [
      { account: "USD account", quantity: "60", sellable: "60" },
      { account: "Other USD account", quantity: "40", sellable: "40" },
    ],
  };
  const multi: PortfolioSnapshot = {
    ...snap,
    positions: [usdPosition],
    cash: { CNY: "7200", USD: "1000" },
    accountCash: { "USD account": { USD: "1000" }, CMB: { CNY: "7200" } },
    totalValue: "21600",
    fxRates: { CNY: "1", USD: "7.2", HKD: "0.9" },
    fxAsOf: "2026-10-30",
    risk: {
      configured: true,
      minimumCash: "3600",
      singleTradeLimit: "3600",
      maxPositionPct: "100",
    },
  };

  it("returns original USD buy amounts while applying CNY caps and original-currency fees", () => {
    const options = amountCandidates(multi, usd, "Buy", "0", now);
    expect(options.map((c) => c.amount)).toEqual([
      "120.00",
      "240.00",
      "490.00",
    ]);
    expect(options.at(-1)).toMatchObject({
      currency: "USD",
      account: "USD account",
      quantity: "49",
      estimatedFee: "4.90",
      cashRequired: "494.90",
      amountCny: "3528.00",
      cashRequiredCny: "3563.28",
      fxRateToCny: "7.2",
      fxAsOf: "2026-10-30",
    });
    for (const c of options) {
      expect(
        new Decimal(candidateCashRequiredCny(c, usd, multi, now)).lte(
          multi.risk.singleTradeLimit,
        ),
      ).toBe(true);
      expect(
        new Decimal(c.cashRequired!).lte(multi.accountCash!["USD account"].USD),
      ).toBe(true);
    }
  });

  it("converts the sell cap to USD, uses only that account's shares and retains total-product percentages", () => {
    const sell = amountCandidates(multi, usd, "Sell", "0", now).at(-1)!;
    expect(sell).toMatchObject({
      amount: "500.00",
      quantity: "50",
      percentage: "50.00",
      estimatedFee: "5.00",
      estimatedNet: "495.00",
      currency: "USD",
      account: "USD account",
      amountCny: "3600.00",
    });
    expect(sell.cashRequired).toBeUndefined();
    expect(sell.cashRequiredCny).toBeUndefined();
  });

  it("does not spend another account's USD, convert the same account's CNY, or combine sell lots", () => {
    const split = {
      ...multi,
      accountCash: {
        "USD account": { USD: "20", CNY: "7200" },
        Other: { USD: "980" },
      },
    };
    expect(amountCandidates(split, usd, "Buy", "0", now).at(-1)?.amount).toBe(
      "10.00",
    );
    expect(
      amountCandidates(
        {
          ...split,
          accountCash: {
            "USD account": { CNY: "7200" },
            Other: { USD: "1000" },
          },
        },
        usd,
        "Buy",
        "0",
        now,
      ),
    ).toEqual([]);
    expect(
      amountCandidates(
        {
          ...multi,
          positions: [
            {
              ...usdPosition,
              accounts: [
                { account: "USD account", quantity: "4", sellable: "4" },
                {
                  account: "Other USD account",
                  quantity: "96",
                  sellable: "96",
                },
              ],
            },
          ],
        },
        { ...usd, lotSize: "10" },
        "Sell",
        "0",
        now,
      ),
    ).toEqual([]);
  });

  it("fails closed on absent, stale, future, malformed and nonpositive foreign FX", () => {
    const invalid: Partial<PortfolioSnapshot>[] = [
      { fxRates: undefined },
      { fxRates: { CNY: "1" } },
      { fxAsOf: undefined },
      { fxAsOf: "2026-10-25" },
      { fxAsOf: "2026-10-31" },
      { fxAsOf: "invalid" },
      { fxAsOf: "2026-02-30" },
      ...["0", "-1", "NaN", "Infinity"].map((rate) => ({
        fxRates: { CNY: "1", USD: rate },
      })),
    ];
    for (const patch of invalid) {
      const bad = { ...multi, ...patch };
      expect(amountCandidates(bad, usd, "Buy", "0", now)).toEqual([]);
      expect(amountCandidates(bad, usd, "Sell", "0", now)).toEqual([]);
      expect(() =>
        candidateCashRequiredCny(
          { amount: "10", currency: "USD" },
          usd,
          bad,
          now,
        ),
      ).toThrow();
    }
    expect(fxRateToCny({ fxRates: { CNY: "1" } }, "CNY", now)?.toFixed()).toBe(
      "1",
    );
    expect(
      amountCandidates(
        { ...multi, fxRates: { CNY: "1" } },
        instrument,
        "Buy",
        "0",
        now,
      ),
    ).toEqual([]);
  });

  it("converts changing rates and shared reservations once, always in CNY", () => {
    const cheaperUsd = {
      ...multi,
      totalValue: "14400",
      fxRates: { ...multi.fxRates, USD: "3.6" },
    };
    expect(
      amountCandidates(cheaperUsd, usd, "Buy", "0", now).at(-1)?.amount,
    ).toBe("990.00");
    const free = { ...usd, feeRate: "0" },
      room = { ...multi, risk: { ...multi.risk, singleTradeLimit: "7200" } };
    const first = amountCandidates(room, free, "Buy", "0", now)[0];
    const reserved = candidateCashRequiredCny(first, free, room, now);
    expect(first.amount).toBe("250.00");
    expect(reserved).toBe("1800");
    const second = amountCandidates(room, free, "Buy", reserved, now).at(-1)!;
    expect(second.amount).toBe("750.00");
    expect(
      new Decimal(reserved)
        .plus(candidateCashRequiredCny(second, free, room, now))
        .toFixed(),
    ).toBe("7200");
    expect(() =>
      candidateCashRequiredCny(
        { amount: "10", currency: "HKD" },
        free,
        room,
        now,
      ),
    ).toThrow();
  });

  it("retains the CNY cash floor, original-currency channel cap and post-fee position ceiling", () => {
    const constrained = {
      ...multi,
      risk: { ...multi.risk, minimumCash: "13680", singleTradeLimit: "7200" },
    };
    const buy = amountCandidates(constrained, usd, "Buy", "0", now).at(-1)!;
    expect(buy.amount).toBe("90.00");
    expect(new Decimal("14400").minus(buy.cashRequiredCny!).gte("13680")).toBe(
      true,
    );
    expect(
      amountCandidates(
        multi,
        { ...usd, channelLimit: "200" },
        "Buy",
        "0",
        now,
      ).at(-1)?.amount,
    ).toBe("200.00");
    const capped = {
      ...multi,
      risk: { ...multi.risk, singleTradeLimit: "7200", maxPositionPct: "50" },
    };
    for (const c of amountCandidates(capped, usd, "Buy", "0", now)) {
      const postPosition = new Decimal("1000").plus(c.amount).times("7.2"),
        postTotal = new Decimal(capped.totalValue!).minus(
          new Decimal(c.estimatedFee!).times("7.2"),
        );
      expect(postPosition.div(postTotal).lte("0.5")).toBe(true);
    }
  });

  it("supports HKD lots and preserves sub-cent CNY reservations without rounding down", () => {
    const hkd: Instrument = {
      ...usd,
      code: "HK_TEST",
      currency: "HKD",
      market: "HK",
      channel: "HK account",
      feeRate: "0",
      lotSize: "100",
    };
    const hk: PortfolioSnapshot = {
      ...multi,
      cash: { HKD: "2000" },
      accountCash: { "HK account": { HKD: "2000" } },
      totalValue: "1980",
      risk: {
        configured: true,
        minimumCash: "0",
        singleTradeLimit: "900",
        maxPositionPct: "100",
      },
      positions: [
        {
          ...usdPosition,
          code: hkd.code,
          currency: "HKD",
          price: "2",
          marketValue: "200",
          instrument: hkd,
          accounts: [
            { account: "HK account", quantity: "100", sellable: "100" },
          ],
        },
      ],
    };
    expect(amountCandidates(hk, hkd, "Buy", "0", now).at(-1)).toMatchObject({
      amount: "1000.00",
      currency: "HKD",
      quantity: "500",
      cashRequiredCny: "900",
    });
    expect(
      candidateCashRequiredCny(
        { amount: "0.01", currency: "HKD" },
        { ...hkd, feeRate: "0.01" },
        hk,
        now,
      ),
    ).toBe("0.018");
  });

  it("carries dated FX into actual ledger snapshots and invalidates valuation on stale FX", () => {
    const store = new Store(":memory:");
    try {
      store.put("settings", "app", {
        ...DEFAULT_SETTINGS,
        fxRates: { CNY: "1", USD: "7.2" },
        fxAsOf: "2026-10-30",
        risk: {
          configured: true,
          minimumCash: "0",
          singleTradeLimit: "720",
          maxPositionPct: "100",
        },
      });
      recordTransaction(store, {
        idempotencyKey: "fx-snapshot-test",
        kind: "deposit",
        account: "USD account",
        currency: "USD",
        date: "2026-10-30",
        amount: "100",
        fxRateToCny: "7.2",
      });
      const current = snapshot(store, now);
      expect(current.fxRates).toEqual({ CNY: "1", USD: "7.2" });
      expect(current.fxAsOf).toBe("2026-10-30");
      expect(current.totalValue).toBe("720.00");
      expect(
        amountCandidates(
          current,
          { ...usd, kind: "fund", feeRate: "0" },
          "Buy",
          "0",
          now,
        ).at(-1)?.amount,
      ).toBe("100.00");
      const stale = snapshot(store, new Date("2026-11-05T15:00:00Z"));
      expect(stale.totalValue).toBeNull();
      expect(stale.warnings.join(" ")).toContain("有效汇率");
    } finally {
      store.close();
    }
  });
});
