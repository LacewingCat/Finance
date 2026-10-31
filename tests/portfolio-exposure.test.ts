import { it, expect } from "vitest";
import { Store } from "../src/server/store.js";
import { recordTransaction } from "../src/server/ledger.js";
import { portfolioExposure } from "../src/server/portfolio-exposure.js";
it("aggregates repeated disclosed securities and preserves unresolved portions", () => {
  const s = new Store(":memory:");
  try {
    for (const code of ["TEST1", "TEST2"]) {
      const instrument = {
        code,
        name: code,
        kind: "fund",
        currency: "CNY",
        market: "CN",
      };
      s.put("instruments", code, instrument);
      s.put("products", code, {
        instrument,
        history: [],
        documents: [],
        errors: [],
        exposures: [
          {
            code: "COMMON",
            name: "共同标的",
            weight: "20",
            basis: "net_assets",
            kind: "stock",
            reportDate: "2026-09-30",
            sourceUrl: "https://example.com/report",
          },
        ],
        observation: {
          code,
          price: "1",
          currency: "CNY",
          priceKind: "nav",
          quality: "valid",
          source: "fixture",
          sourceUrl: "https://example.com",
          asOf: "2026-10-30",
          fetchedAt: "2026-10-30T10:00:00Z",
        },
      });
      recordTransaction(s, {
        kind: "opening",
        code,
        account: "test",
        currency: "CNY",
        date: "2026-10-01",
        amount: "100",
        quantity: "100",
        idempotencyKey: code,
      });
    }
    const result = portfolioExposure(s, new Date("2026-10-30T12:00:00Z"));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].cnyValue).toBe("40.00");
    expect(result.items[0].sources).toHaveLength(2);
    expect(result.unresolvedValue).toBe("160.00");
  } finally {
    s.close();
  }
});
