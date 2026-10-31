import { Decimal } from "decimal.js";
import type { Store } from "./store.js";
import { snapshot } from "./portfolio.js";
import { settings } from "./config.js";
import { flattenExposures } from "./exposure.js";
import type { ProductData } from "../shared/types.js";

export function portfolioExposure(store: Store, now = new Date()) {
  const snap = snapshot(store, now),
    cfg = settings(store);
  const base = {
    totalValue: snap.totalValue,
    reason:
      "仅合并同代码/同名称、占净资产口径的实际披露；不同报告期保留来源日期。FOF和联接基金未取得下层披露时仍为未穿透，指数成份不替代实际持仓。",
  };
  if (snap.totalValue === null)
    return { ...base, items: [], coveredValue: null, unresolvedValue: null };
  const rows = new Map<
    string,
    {
      key: string;
      name: string;
      code?: string;
      value: Decimal;
      sources: { fundCode: string; reportDate: string; sourceUrl: string }[];
    }
  >();
  let covered = new Decimal(0),
    invested = new Decimal(0);
  for (const position of snap.positions) {
    if (!position.marketValue) continue;
    const value = new Decimal(position.marketValue).times(
      cfg.fxRates[position.currency] ?? 0,
    );
    invested = invested.plus(value);
    if (position.instrument.kind === "stock") {
      const key =
        position.instrument.market + ":" + position.code.toUpperCase();
      const old = rows.get(key);
      if (old) old.value = old.value.plus(value);
      else
        rows.set(key, {
          key,
          name: position.name,
          code: position.code,
          value,
          sources: [],
        });
      covered = covered.plus(value);
      continue;
    }
    const data = store.get<ProductData>("products", position.code);
    if (!data) continue;
    const leaves = flattenExposures(data.exposures).filter(
      (e) =>
        e.basis === "net_assets" &&
        !e.unresolved &&
        e.effectiveWeight &&
        !["fund", "etf", "unreported"].includes(e.kind),
    );
    const sum = leaves.reduce(
      (n, e) => n.plus(e.effectiveWeight!),
      new Decimal(0),
    );
    if (sum.gt(100) || sum.lt(0)) continue;
    for (const e of leaves) {
      const weight = new Decimal(e.effectiveWeight!);
      if (weight.lte(0)) continue;
      const amount = value.times(weight).div(100),
        key = e.code
          ? "security:" + e.code.toUpperCase()
          : "name:" + e.name.trim();
      const old = rows.get(key) ?? {
        key,
        name: e.name,
        code: e.code,
        value: new Decimal(0),
        sources: [],
      };
      old.value = old.value.plus(amount);
      old.sources.push({
        fundCode: position.code,
        reportDate: e.reportDate,
        sourceUrl: e.sourceUrl,
      });
      rows.set(key, old);
      covered = covered.plus(amount);
    }
  }
  const items = [...rows.values()]
    .sort((a, b) => b.value.comparedTo(a.value))
    .map(({ value, ...row }) => ({
      ...row,
      cnyValue: value.toFixed(2),
      weight: new Decimal(snap.totalValue!).gt(0)
        ? value.div(snap.totalValue!).times(100).toFixed(2)
        : "0.00",
    }));
  return {
    ...base,
    items,
    coveredValue: covered.toFixed(2),
    unresolvedValue: Decimal.max(0, invested.minus(covered)).toFixed(2),
  };
}
