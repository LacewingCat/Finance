import { Decimal } from "decimal.js";
import type {
  AmountCandidate,
  AppSettings,
  DecisionResult,
  Instrument,
  PortfolioSnapshot,
  ProductData,
} from "../shared/types.js";
import { d } from "./ledger.js";

const executionMarket = (instrument: Instrument) =>
  ["fund", "qdii", "fof", "money"].includes(instrument.kind)
    ? "CN"
    : instrument.market;
const zone = (market: string) =>
  market === "US"
    ? "America/New_York"
    : market === "UK"
      ? "Europe/London"
      : market === "EU"
        ? "Europe/Paris"
        : "Asia/Shanghai";
const localDate = (market: string, now: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone(market),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
function nonnegative(value: unknown): Decimal | undefined {
  try {
    if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return;
    const n = d(value);
    return n.isFinite() && n.gte(0) ? n : undefined;
  } catch {
    return;
  }
}

/** One unit of original currency in CNY. Never infer or invert a missing rate. */
export function fxRateToCny(
  evidence: Pick<PortfolioSnapshot, "fxRates" | "fxAsOf">,
  currency: string,
  now = new Date(),
): Decimal | undefined {
  if (currency === "CNY") {
    const configured = evidence.fxRates?.CNY;
    return configured === undefined || nonnegative(configured)?.eq(1)
      ? d(1)
      : undefined;
  }
  const rate = nonnegative(evidence.fxRates?.[currency]);
  const asOf = evidence.fxAsOf;
  if (!rate?.gt(0) || !asOf || !validDate(asOf.slice(0, 10))) return;
  const timestamp = Date.parse(asOf),
    current = now.getTime();
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(current) ||
    timestamp > current ||
    current - timestamp > 4 * 86400000
  )
    return;
  return rate;
}

/** Mature quantities per account. Reservation subtraction must happen on that same account. */
export function settledQuantity(
  instrument: Instrument,
  lots: { quantity: Decimal.Value; date: string }[],
  cfg: AppSettings,
  now = new Date(),
): Decimal {
  const market = executionMarket(instrument),
    today = localDate(market, now),
    days = instrument.settlementDays ?? (market === "CN" ? 1 : 0);
  if (
    !Number.isInteger(days) ||
    days < 0 ||
    days > 30 ||
    (days > 0 &&
      (!validDate(cfg.calendarVerifiedThrough[market] ?? "") ||
        cfg.calendarVerifiedThrough[market] < today))
  )
    return d();
  let total = d();
  for (const lot of lots) {
    const quantity = d(lot.quantity);
    if (
      !quantity.isFinite() ||
      quantity.lt(0) ||
      !validDate(lot.date) ||
      lot.date > today
    )
      continue;
    if (days === 0) {
      total = total.plus(quantity);
      continue;
    }
    let remaining = days,
      date = lot.date;
    while (remaining > 0 && date < today) {
      const next = new Date(date + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      date = next.toISOString().slice(0, 10);
      if (
        ![0, 6].includes(next.getUTCDay()) &&
        !cfg.holidays[market]?.includes(date)
      )
        remaining--;
    }
    if (remaining === 0) total = total.plus(quantity);
  }
  return total;
}
export function tradeWindow(
  instrument: Instrument,
  cfg: AppSettings,
  now = new Date(),
): { open: boolean; reason: string } {
  const market = executionMarket(instrument),
    date = localDate(market, now);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: zone(market),
    weekday: "short",
  }).format(now);
  if (day === "Sat" || day === "Sun" || cfg.holidays[market]?.includes(date))
    return { open: false, reason: "休市或非开放日" };
  if (
    !validDate(cfg.calendarVerifiedThrough[market] ?? "") ||
    (cfg.calendarVerifiedThrough[market] ?? "") < date
  )
    return { open: false, reason: "交易日历尚未核验，自动提醒保持关闭" };
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone(market),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const minutes =
    Number(parts.find((p) => p.type === "hour")?.value) * 60 +
    Number(parts.find((p) => p.type === "minute")?.value);
  const ranges =
    market === "US"
      ? [[570, 960]]
      : market === "HK"
        ? [
            [570, 720],
            [780, 960],
          ]
        : market === "UK"
          ? [[480, 990]]
          : market === "EU"
            ? [[540, 1050]]
            : [
                [570, 690],
                [780, 900],
              ];
  const open = ranges.some(([a, b]) => minutes >= a && minutes < b);
  return { open, reason: open ? "交易窗口内" : "当前不在可执行交易窗口" };
}
export function triggerEligible(
  decision: DecisionResult,
  snap: PortfolioSnapshot,
  product: ProductData,
  cfg: AppSettings,
  now = new Date(),
): { eligible: boolean; reason: string; direction?: "Buy" | "Sell" } {
  const probabilities = [decision.buy, decision.sell, decision.hold];
  if (
    decision.status !== "valid" ||
    decision.snapshotId !== snap.id ||
    decision.code !== product.instrument.code ||
    probabilities.some(
      (p) => p === null || !Number.isFinite(p) || p < 0 || p > 1,
    ) ||
    Math.abs(probabilities.reduce<number>((s, p) => s + (p ?? 0), 0) - 1) >
      0.00001
  )
    return { eligible: false, reason: "决策与产品不匹配或概率无效" };
  const generated = Date.parse(decision.generatedAt);
  if (
    !Number.isFinite(generated) ||
    generated > now.getTime() ||
    now.getTime() - generated > 300_000
  )
    return { eligible: false, reason: "决策已超过当前交易日内的复核窗口" };
  const direction =
    decision.buy! > 0.9 ? "Buy" : decision.sell! > 0.9 ? "Sell" : undefined;
  if (!direction) return { eligible: false, reason: "未超过90%触发阈值" };
  const o = product.observation;
  if (
    !o ||
    o.quality !== "valid" ||
    o.code !== product.instrument.code ||
    o.currency !== product.instrument.currency ||
    decision.asOf !== o.asOf ||
    !nonnegative(o.price)?.gt(0) ||
    !["trade", "nav"].includes(o.priceKind)
  )
    return { eligible: false, reason: "行情质量、来源对应或价格类型尚未验证" };
  const asOf = Date.parse(o.asOf),
    fetched = Date.parse(o.fetchedAt);
  if (
    !Number.isFinite(asOf) ||
    !Number.isFinite(fetched) ||
    asOf > now.getTime() ||
    fetched > now.getTime() ||
    now.getTime() - fetched > 86400_000
  )
    return { eligible: false, reason: "行情日期无效或抓取结果过期" };
  if (
    o.priceKind === "trade" &&
    (o.delaySeconds === undefined ||
      !Number.isFinite(o.delaySeconds) ||
      o.delaySeconds < 0 ||
      o.delaySeconds > 120 ||
      now.getTime() - asOf > 120000)
  )
    return { eligible: false, reason: "盘中价格过期或时延未知" };
  if (
    o.priceKind === "nav" &&
    now.getTime() - asOf >
      86400000 * (["qdii", "fof"].includes(product.instrument.kind) ? 7 : 4)
  )
    return { eligible: false, reason: "净值超过产品预期披露窗口" };
  if (!product.instrument.rulesVerified)
    return { eligible: false, reason: "申赎、费用或交易规则尚未核验" };
  if (direction === "Buy" && !product.instrument.purchasable)
    return { eligible: false, reason: "当前账户可购买权限尚未确认" };
  if (!cfg.risk.configured)
    return { eligible: false, reason: "尚未设置资金与风险约束" };
  const window = tradeWindow(product.instrument, cfg, now);
  if (!window.open) return { eligible: false, reason: window.reason };
  return { eligible: true, reason: "触发条件通过", direction };
}
/** Gross buy cash including fees, rounded up to the currency's cent. */
export function candidateCashRequired(
  candidate: AmountCandidate,
  instrument: Instrument,
): string {
  const amount = nonnegative(candidate.amount),
    fee = nonnegative(instrument.feeRate ?? "0");
  if (
    !amount ||
    !fee ||
    fee.gt(1) ||
    (candidate.currency && candidate.currency !== instrument.currency)
  )
    throw new Error("候选金额、币种或费用无效");
  return amount
    .plus(amount.times(fee).toDecimalPlaces(2, Decimal.ROUND_UP))
    .toFixed(2);
}

/** Exact CNY amount for shared alert reservations; fee rounding happens in the original currency first. */
export function candidateCashRequiredCny(
  candidate: AmountCandidate,
  instrument: Instrument,
  snap: Pick<PortfolioSnapshot, "fxRates" | "fxAsOf">,
  now = new Date(),
): string {
  const rate = fxRateToCny(snap, instrument.currency, now);
  if (!rate) throw new Error("缺少有效参考汇率，不能预留跨币种建议金额");
  return d(candidateCashRequired(candidate, instrument)).times(rate).toFixed();
}
/** All risk limits and allocated reservations are CNY; candidates stay in the product currency. */
export function amountCandidates(
  snap: PortfolioSnapshot,
  instrument: Instrument,
  direction: "Buy" | "Sell",
  allocated = "0",
  now = new Date(),
): AmountCandidate[] {
  const total = nonnegative(snap.totalValue),
    minimum = nonnegative(snap.risk.minimumCash),
    tradeLimit = nonnegative(snap.risk.singleTradeLimit),
    maxPct = nonnegative(snap.risk.maxPositionPct),
    already = nonnegative(allocated),
    fee = nonnegative(instrument.feeRate),
    rate = fxRateToCny(snap, instrument.currency, now);
  if (
    !snap.risk.configured ||
    !instrument.rulesVerified ||
    !total ||
    !minimum ||
    !tradeLimit?.gt(0) ||
    !maxPct?.gt(0) ||
    maxPct.gt(100) ||
    !already ||
    !fee ||
    fee.gt(1) ||
    !instrument.channel ||
    !rate
  )
    return [];
  const position = snap.positions.find((p) => p.code === instrument.code),
    account = position?.accounts?.find((a) => a.account === instrument.channel);
  if (position && position.currency !== instrument.currency) return [];
  const price = nonnegative(position?.price ?? "0");
  let cap: Decimal,
    buyAvailableCny: Decimal | undefined,
    currentValueCny = d();
  // The comparison amount is floored to an original-currency cent so that fee
  // rounding cannot spend fractional cents that do not exist in the account.
  const tradeLimitOriginal = tradeLimit
    .div(rate)
    .toDecimalPlaces(2, Decimal.ROUND_DOWN);
  if (direction === "Buy") {
    if (!instrument.purchasable) return [];
    const channelCash = nonnegative(
      snap.accountCash?.[instrument.channel]?.[instrument.currency],
    );
    if (!channelCash) return [];
    let globalCashCny = d();
    for (const [currency, raw] of Object.entries(snap.cash)) {
      const value = nonnegative(raw);
      if (!value) return [];
      if (value.isZero()) continue;
      const cashRate = fxRateToCny(snap, currency, now);
      if (!cashRate) return [];
      globalCashCny = globalCashCny.plus(value.times(cashRate));
    }
    const currentValue = position ? nonnegative(position.marketValue) : d();
    if (!currentValue) return [];
    currentValueCny = currentValue.times(rate);
    buyAvailableCny = Decimal.max(
      0,
      Decimal.min(channelCash.times(rate), globalCashCny.minus(minimum)).minus(
        already,
      ),
    );
    const availableOriginal = buyAvailableCny
      .div(rate)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);
    const weight = maxPct.div(100);
    // A fee rounded upward in the original currency reduces portfolio assets by
    // at most rawAmount*fee*FX + 0.01*FX. Solve the post-fee position constraint.
    const roomCny = Decimal.max(
      0,
      total
        .times(weight)
        .minus(currentValueCny)
        .minus(fee.gt(0) ? weight.times("0.01").times(rate) : 0)
        .div(d(1).plus(weight.times(fee))),
    );
    const channelLimit = nonnegative(instrument.channelLimit ?? "999999999999");
    if (!channelLimit) return [];
    cap = Decimal.min(
      availableOriginal.div(fee.plus(1)),
      tradeLimitOriginal.div(fee.plus(1)),
      roomCny.div(rate),
      channelLimit,
    );
  } else {
    const sellable = nonnegative(account?.sellable),
      quantity = nonnegative(account?.quantity),
      totalQuantity = nonnegative(position?.quantity);
    if (
      !position ||
      !account ||
      !quantity?.gt(0) ||
      !totalQuantity ||
      quantity.gt(totalQuantity) ||
      !sellable ||
      sellable.gt(quantity) ||
      !price?.gt(0)
    )
      return [];
    cap = Decimal.min(sellable.times(price), tradeLimitOriginal);
  }
  const seen = new Set<string>(),
    out: AmountCandidate[] = [];
  for (const ratio of ["0.25", "0.5", "1"]) {
    let amount = cap.times(ratio).toDecimalPlaces(2, Decimal.ROUND_DOWN),
      quantity: Decimal | undefined;
    if (["stock", "etf"].includes(instrument.kind) || direction === "Sell") {
      if (!price?.gt(0)) continue;
      if (
        ["stock", "etf"].includes(instrument.kind) &&
        instrument.lotSize === undefined
      )
        return [];
      const lot = nonnegative(instrument.lotSize ?? "0.01");
      if (!lot?.gt(0)) return [];
      quantity = amount.div(price).div(lot).floor().times(lot);
      amount = quantity
        .times(price)
        .toDecimalPlaces(
          2,
          direction === "Buy" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN,
        );
      if (amount.gt(cap)) continue;
    }
    const minBuy = nonnegative(instrument.minBuy ?? "1");
    if (!minBuy) return [];
    const estimatedFee = amount.times(fee).toDecimalPlaces(2, Decimal.ROUND_UP),
      cashRequired = amount.plus(estimatedFee),
      cashRequiredCny = cashRequired.times(rate);
    if (
      amount.lte(0) ||
      amount.times(rate).gt(tradeLimit) ||
      (direction === "Buy" &&
        (amount.lt(minBuy) ||
          cashRequiredCny.gt(tradeLimit) ||
          cashRequiredCny.gt(buyAvailableCny!) ||
          currentValueCny
            .plus(amount.times(rate))
            .gt(
              total.minus(estimatedFee.times(rate)).times(maxPct).div(100),
            ))) ||
      seen.has(amount.toFixed(2))
    )
      continue;
    seen.add(amount.toFixed(2));
    out.push({
      amount: amount.toFixed(2),
      quantity: quantity?.toFixed(),
      percentage:
        direction === "Sell" && quantity && position
          ? quantity.div(position.quantity).times(100).toFixed(2)
          : undefined,
      account: instrument.channel,
      currency: instrument.currency,
      estimatedFee: estimatedFee.toFixed(2),
      estimatedNet:
        direction === "Sell"
          ? amount.minus(estimatedFee).toFixed(2)
          : undefined,
      cashRequired: direction === "Buy" ? cashRequired.toFixed(2) : undefined,
      amountCny: amount.times(rate).toFixed(2),
      cashRequiredCny:
        direction === "Buy" ? cashRequiredCny.toFixed() : undefined,
      fxRateToCny: rate.toFixed(),
      fxAsOf: instrument.currency === "CNY" ? undefined : snap.fxAsOf,
    });
  }
  return out;
}
