import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { Store } from "./store.js";
import { settings } from "./config.js";
import { settledQuantity, fxRateToCny } from "./risk.js";
import { performanceMetrics } from "./returns.js";
import { replay, transactions, d } from "./ledger.js";
import type {
  Instrument,
  Position,
  PortfolioSnapshot,
  ProductData,
} from "../shared/types.js";

export function marketDate(market: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:
      market === "US"
        ? "America/New_York"
        : market === "UK"
          ? "Europe/London"
          : market === "EU"
            ? "Europe/Paris"
            : "Asia/Shanghai",
  }).format(now);
}
export function snapshot(store: Store, now = new Date()): PortfolioSnapshot {
  const cfg = settings(store),
    tx = transactions(store),
    instruments = new Map(
      store.list<Instrument>("instruments").map((i) => [i.code, i]),
    );
  const s = replay(tx, instruments),
    warnings: string[] = [];
  const aggregate = (m: Map<string, Decimal>, account = false) => {
    const out: Record<string, string> = {};
    for (const [key, v] of m) {
      const c = account ? key.split("|").at(-1)! : key;
      out[c] = d(out[c] ?? 0)
        .plus(v)
        .toFixed();
    }
    return out;
  };
  const cash = aggregate(s.cash, true),
    frozen = aggregate(s.frozen, true),
    receivables = aggregate(s.receivables, true);
  const accountCash: Record<string, Record<string, string>> = {};
  for (const [key, v] of s.cash) {
    const [account, currency] = [
      key.slice(0, key.lastIndexOf("|")),
      key.slice(key.lastIndexOf("|") + 1),
    ];
    (accountCash[account] ??= {})[currency] = v.toFixed();
  }
  let missingFx = false,
    missingPrice = false;
  const fx = (value: Decimal.Value, currency: string) => {
    const r = fxRateToCny(cfg, currency, now);
    if (!r) {
      missingFx = true;
      return d();
    }
    return d(value).times(r);
  };
  const sum = (map: Record<string, string>) =>
    Object.entries(map).reduce((t, [c, v]) => t.plus(fx(v, c)), d());
  const grouped = new Map<
    string,
    {
      quantity: Decimal;
      cost: Decimal;
      reserved: Decimal;
      locked: Decimal;
      currency: Position["currency"];
      accounts: NonNullable<Position["accounts"]>;
    }
  >();
  for (const h of s.positions.values()) {
    const inst = instruments.get(h.code) ?? {
      code: h.code,
      name: h.code,
      kind: "fund" as const,
      currency: h.currency,
      market: "CN" as const,
    };
    const settled = settledQuantity(inst, h.lots, cfg, now),
      sellable = Decimal.max(0, settled.minus(h.reserved));
    const prev = grouped.get(h.code) ?? {
      quantity: d(),
      cost: d(),
      reserved: d(),
      locked: d(),
      currency: h.currency,
      accounts: [],
    };
    prev.quantity = prev.quantity.plus(h.quantity);
    prev.cost = prev.cost.plus(h.cost);
    prev.reserved = prev.reserved.plus(h.reserved);
    prev.locked = prev.locked.plus(h.quantity.minus(settled));
    prev.accounts.push({
      account: h.account,
      quantity: h.quantity.toFixed(),
      sellable: sellable.toFixed(),
    });
    grouped.set(h.code, prev);
  }
  const positions: Position[] = [];
  let value = sum(cash).plus(sum(frozen)).plus(sum(receivables)),
    invested = d(),
    unrealized = d();
  for (const [code, h] of grouped) {
    if (h.quantity.eq(0)) continue;
    const inst = instruments.get(code) ?? {
      code,
      name: code,
      kind: "fund" as const,
      currency: h.currency,
      market: "CN" as const,
    };
    const product = store.get<ProductData>("products", code),
      o = product?.observation;
    const usable =
      o &&
      o.code === code &&
      o.currency === h.currency &&
      o.quality !== "conflict" &&
      /^\d+(\.\d+)?$/.test(o.price) &&
      d(o.price).isFinite() &&
      d(o.price).gt(0) &&
      Number.isFinite(Date.parse(o.asOf)) &&
      Date.parse(o.asOf) <= now.getTime() &&
      Number.isFinite(Date.parse(o.fetchedAt)) &&
      Date.parse(o.fetchedAt) <= now.getTime() + 60000;
    const mv = usable ? h.quantity.times(o.price) : undefined,
      pl = mv?.minus(h.cost);
    if (mv) {
      value = value.plus(fx(mv, h.currency));
      unrealized = unrealized.plus(fx(pl!, h.currency));
    } else {
      missingPrice = true;
      warnings.push(`${inst.name}缺少有效估值`);
    }
    invested = invested.plus(fx(h.cost, h.currency));
    positions.push({
      accounts: h.accounts.map((a) => ({
        ...a,
        marketValue: usable
          ? d(a.quantity).times(o.price).toFixed(2)
          : undefined,
      })),
      code,
      name: inst.name,
      currency: h.currency,
      quantity: h.quantity.toFixed(),
      sellable: h.accounts.reduce((n, a) => n.plus(a.sellable), d()).toFixed(),
      cost: h.cost.toFixed(2),
      averageCost: h.cost.div(h.quantity).toFixed(8),
      price: o?.price,
      marketValue: mv?.toFixed(2),
      pnl: pl?.toFixed(2),
      pnlPct:
        pl && h.cost.gt(0) ? pl.div(h.cost).times(100).toFixed(2) : undefined,
      observation: o,
      instrument: inst,
    });
  }
  const realized = sum(aggregate(s.realized)),
    income = sum(aggregate(s.income)),
    fees = sum(aggregate(s.fees));
  let flows = d(),
    unknownHistoricalFx = false;
  for (const t of tx.filter((x) => !x.reversedBy && !x.reverses)) {
    if (!["deposit", "withdraw", "opening"].includes(t.kind)) continue;
    const rate = t.currency === "CNY" ? "1" : t.fxRateToCny;
    if (!rate) {
      unknownHistoricalFx = true;
      continue;
    }
    flows = flows.plus(
      d(t.amount)
        .times(rate)
        .times(t.kind === "withdraw" ? -1 : 1),
    );
  }
  const foreign = tx.some((t) => t.currency !== "CNY" || t.kind === "fx");
  if (missingFx)
    warnings.push("外币资产缺少带日期的有效汇率，组合人民币估值暂不可计算");
  if (unknownHistoricalFx)
    warnings.push("缺少外币资金流的历史汇率，累计人民币收益暂不可计算");
  if (foreign)
    warnings.push("跨币种收益分项以当前汇率展示；完整历史汇率归因待补齐");
  const total = missingFx || missingPrice ? null : value.toFixed(2);
  const pnl =
    total === null || unknownHistoricalFx
      ? null
      : value.minus(flows).toFixed(2);
  const reconciliation =
    pnl !== null && !foreign
      ? d(pnl)
          .minus(realized.plus(unrealized).plus(income).minus(fees))
          .toFixed(2)
      : null;
  const id = createHash("sha256")
    .update(
      JSON.stringify({
        revision: store.revision(),
        observations: positions.map((p) => [
          p.code,
          p.sellable,
          p.accounts,
          p.observation && { ...p.observation, fetchedAt: undefined },
        ]),
        dates: [marketDate("CN", now), marketDate("US", now)],
        evidence: positions.map((p) => {
          const data = store.get<ProductData>("products", p.code);
          return [p.code, data?.exposures, data?.documents];
        }),
        news: store
          .list<{ id: string; publishedAt?: string }>("news")
          .map((n) => [n.id, n.publishedAt]),
        prompts: store
          .list<{ name: string; version: number }>("prompts")
          .map((p) => [p.name, p.version]),
        risk: cfg.risk,
        fx: cfg.fxRates,
        asOf: cfg.fxAsOf,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return {
    id,
    createdAt: now.toISOString(),
    revision: store.revision(),
    positions,
    cash,
    accountCash,
    fxRates: { ...cfg.fxRates },
    fxAsOf: cfg.fxAsOf,
    frozen,
    receivables,
    totalValue: total,
    investedCost: invested.toFixed(2),
    realizedPnl: realized.toFixed(2),
    unrealizedPnl: missingFx || missingPrice ? null : unrealized.toFixed(2),
    income: income.toFixed(2),
    fees: fees.toFixed(2),
    externalFlows: flows.toFixed(2),
    totalPnl: pnl,
    reconciliation,
    warnings,
    risk: cfg.risk,
  };
}
export function performance(store: Store) {
  return performanceMetrics(
    store.list<PortfolioSnapshot>("dailySnapshots"),
    transactions(store),
  );
}
