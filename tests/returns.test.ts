import { it, expect } from "vitest";
import { xirr, performanceMetrics } from "../src/server/returns.js";
import type { PortfolioSnapshot } from "../src/shared/types.js";
it("solves dated external cash flows and rejects insufficient histories", () => {
  expect(
    xirr([
      { date: "2025-01-01", amount: "-100" },
      { date: "2026-01-01", amount: "110" },
    ]),
  ).toBeCloseTo(0.1, 8);
  expect(
    xirr([
      { date: "2026-01-01", amount: "-100" },
      { date: "2026-01-01", amount: "110" },
    ]),
  ).toBeNull();
});
it("does not report estimated cash-flow-adjusted returns as exact TWR", () => {
  const values = [
    {
      createdAt: "2026-10-01T00:00:00Z",
      totalValue: "100",
      totalPnl: "0",
      externalFlows: "100",
    },
    {
      createdAt: "2026-10-02T00:00:00Z",
      totalValue: "210",
      totalPnl: "10",
      externalFlows: "200",
    },
  ] as PortfolioSnapshot[];
  const result = performanceMetrics(values, []);
  expect(result.twr).toBeNull();
  expect(result.maxDrawdown).toBeNull();
  expect(result.estimatedTwr).toBe("10.00");
});
