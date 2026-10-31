import { Decimal } from "decimal.js";
import type { LedgerTransaction, PortfolioSnapshot } from "../shared/types.js";

/** Returns are dimensionless. Currency aggregation stays Decimal until the solver. */
export function xirr(flows: { date: string; amount: string }[]): number | null {
  if (
    flows.length < 2 ||
    !flows.some((f) => new Decimal(f.amount).gt(0)) ||
    !flows.some((f) => new Decimal(f.amount).lt(0))
  )
    return null;
  const first = Math.min(...flows.map((f) => Date.parse(f.date)));
  const points = flows.map((f) => ({
    years: (Date.parse(f.date) - first) / 86400000 / 365,
    amount: new Decimal(f.amount).toNumber(),
  }));
  if (
    points.some(
      (p) => !Number.isFinite(p.years) || !Number.isFinite(p.amount),
    ) ||
    Math.max(...points.map((p) => p.years)) <= 0
  )
    return null;
  const npv = (logRate: number) =>
    points.reduce((sum, p) => sum + p.amount * Math.exp(-logRate * p.years), 0);
  // Work in log(1+r), bracket every root in a finite, disclosed range. Ambiguous IRRs are not displayed.
  const brackets: [number, number][] = [];
  let previous = -9,
    pv = npv(previous);
  for (let next = -8.9; next <= 14; next += 0.1) {
    const nv = npv(next);
    if (nv === 0 || pv === 0 || Math.sign(nv) !== Math.sign(pv))
      brackets.push([previous, next]);
    previous = next;
    pv = nv;
  }
  if (brackets.length !== 1) return null;
  let [lo, hi] = brackets[0];
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    if (Math.sign(npv(mid)) === Math.sign(npv(lo))) lo = mid;
    else hi = mid;
  }
  const result = Math.expm1((lo + hi) / 2);
  return Number.isFinite(result) ? result : null;
}
export function performanceMetrics(
  snapshots: PortfolioSnapshot[],
  ledger: LedgerTransaction[],
) {
  const values = snapshots
    .filter((s) => s.totalValue !== null && s.totalPnl !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let unit = new Decimal(1),
    peak = new Decimal(1),
    drawdown = new Decimal(0),
    exact = true;
  const daily: number[] = [],
    curve: { date: string; value: string; unit: string }[] = [];
  for (let i = 0; i < values.length; i++) {
    const current = values[i],
      last = values[i - 1];
    if (last && new Decimal(last.totalValue!).gt(0)) {
      const flow = new Decimal(current.externalFlows).minus(last.externalFlows);
      // Day-end flow assumption is shown only as an estimate. Exact TWR needs valuations at every external flow.
      if (!flow.isZero()) exact = false;
      const factor = new Decimal(current.totalValue!)
        .minus(flow)
        .div(last.totalValue!);
      if (factor.gte(0)) {
        unit = unit.times(factor);
        daily.push(factor.minus(1).toNumber());
      } else exact = false;
    }
    peak = Decimal.max(peak, unit);
    drawdown = Decimal.max(drawdown, peak.minus(unit).div(peak));
    curve.push({
      date: current.createdAt.slice(0, 10),
      value: current.totalValue!,
      unit: unit.toFixed(8),
    });
  }
  const last = values.at(-1),
    flows: { date: string; amount: string }[] = [];
  let historicalFxComplete = true;
  for (const t of ledger.filter((t) => !t.reversedBy && !t.reverses)) {
    if (!["deposit", "withdraw", "opening"].includes(t.kind)) continue;
    const rate = t.currency === "CNY" ? "1" : t.fxRateToCny;
    if (!rate) {
      historicalFxComplete = false;
      continue;
    }
    flows.push({
      date: t.date,
      amount: new Decimal(t.amount)
        .times(rate)
        .times(t.kind === "withdraw" ? 1 : -1)
        .toFixed(),
    });
  }
  if (last)
    flows.push({ date: last.createdAt.slice(0, 10), amount: last.totalValue! });
  const irr = historicalFxComplete ? xirr(flows) : null;
  const mean = daily.reduce((a, b) => a + b, 0) / (daily.length || 1);
  // No annualisation of irregular/missing observations. Daily observations need at least 20 intervals.
  const consecutive = values.every(
    (s, i) =>
      i === 0 ||
      (Date.parse(s.createdAt) - Date.parse(values[i - 1].createdAt)) /
        86400000 <=
        4,
  );
  const volatility =
    exact && consecutive && daily.length >= 20
      ? Math.sqrt(
          daily.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
            (daily.length - 1),
        ) *
        Math.sqrt(252) *
        100
      : null;
  const enough = values.length >= 2;
  return {
    curve,
    maxDrawdown: enough && exact ? drawdown.times(100).toFixed(2) : null,
    twr: enough && exact ? unit.minus(1).times(100).toFixed(2) : null,
    estimatedTwr: enough ? unit.minus(1).times(100).toFixed(2) : null,
    xirr: irr === null ? null : (irr * 100).toFixed(2),
    volatility: volatility?.toFixed(2) ?? null,
    reason: !enough
      ? "需要至少两个有完整估值的日期快照。"
      : !exact
        ? "现金流发生时缺少即时估值，精确 TWR 与回撤不可计算；曲线仅按日末资金流假设估算，XIRR 使用实际记账日期。"
        : "TWR 与回撤仅覆盖已保存完整估值区间；波动率需要至少20个连续日度收益样本。XIRR 按365日年化。",
  };
}
