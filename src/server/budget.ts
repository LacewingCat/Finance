import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type { AppSettings, BudgetSummary } from "../shared/types.js";

export interface BudgetStore {
  get<T>(namespace: string, key: string): T | undefined;
  put(namespace: string, key: string, value: unknown): void;
  list<T>(namespace: string): T[];
  atomic<T>(fn: () => T): T;
}
export type TaskCategory =
  | "decisions"
  | "brief"
  | "chat"
  | "review"
  | "amounts"
  | "verification";
export const CATEGORY_LIMITS: Readonly<Record<TaskCategory, number>> =
  Object.freeze({
    decisions: 45,
    brief: 15,
    chat: 10,
    review: 5,
    amounts: 5,
    verification: 5,
  });
export const PRICE_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const PRICE_VERIFIED_AT = "2026-11-01";
export const PRICE_EXPIRES_AT = "2026-12-01T00:00:00Z";
export interface ModelPricing {
  input: number;
  cached: number;
  write: number;
  output: number;
  efforts: readonly string[];
}
// Standard, short context, global endpoint, USD / million tokens. No alias guessing.
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> =
  Object.freeze({
    "gpt-6-astra": {
      input: 10,
      cached: 1,
      write: 12.5,
      output: 50,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    "gpt-6.1-sol": {
      input: 2,
      cached: 0.1,
      write: 2.5,
      output: 10,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    "gpt-6.1-terra": {
      input: 1,
      cached: 0.05,
      write: 1.25,
      output: 5,
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    "gpt-6-luna": {
      input: 0.1,
      cached: 0.01,
      write: 0.125,
      output: 0.5,
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    },
  });
export interface Usage {
  input_tokens: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
}
export interface Reservation {
  id: string;
  category: TaskCategory;
  model: string;
  endpoint: "responses" | "decisions";
  createdAt: string;
  completedAt?: string;
  reservedMicros: number;
  actualMicros?: number;
  status: "reserved" | "ambiguous" | "settled" | "released";
  reason?: string;
  usage?: Usage;
}
const NS = "ai-budget";
const MICRO = 1_000_000;
export class BudgetError extends Error {}
const dollars = (micro: number) => new Decimal(micro).div(MICRO).toFixed(6);
function micros(value: string | number): number {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative() || decimal.gt(1_000_000))
    throw new BudgetError("预算金额无效");
  return decimal.mul(MICRO).ceil().toNumber();
}
export function shanghaiMonth(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  })
    .format(date)
    .replace("/", "-");
}
function activePeriod(settings: AppSettings, now: Date): boolean {
  const start = Date.parse(settings.creditStartsAt),
    end = Date.parse(settings.creditExpiresAt);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= now.getTime() &&
    now.getTime() < end &&
    end > start &&
    end - start <= 366 * 86400_000
  );
}
export function knownPricing(model: string, now = new Date()): ModelPricing {
  const price = Object.hasOwn(MODEL_PRICING, model)
    ? MODEL_PRICING[model]
    : undefined;
  if (!price) throw new BudgetError("型号没有已核实价格，调用已阻止");
  if (now.getTime() >= Date.parse(PRICE_EXPIRES_AT))
    throw new BudgetError("价格表已过复核期限，请更新价格后再启用");
  return price;
}
export function usageCostMicros(
  model: string,
  endpoint: "responses" | "decisions",
  usage: Usage,
): number {
  const p = MODEL_PRICING[model];
  if (!p || (endpoint === "decisions" && model !== "gpt-6-luna"))
    throw new BudgetError("未知计价方式");
  const i = usage.input_tokens,
    o = usage.output_tokens,
    c = usage.input_tokens_details?.cached_tokens ?? 0,
    w = usage.input_tokens_details?.cache_write_tokens ?? 0;
  if (
    ![i, o, c, w].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    c + w > i
  )
    throw new BudgetError("用量缺失或无效，预留仍保留");
  // reasoning_tokens is a subset of output_tokens, never add it twice.
  return new Decimal(i - c - w)
    .mul(p.input)
    .plus(new Decimal(c).mul(p.cached))
    .plus(new Decimal(w).mul(p.write))
    .plus(new Decimal(o).mul(endpoint === "decisions" ? 0 : p.output))
    .ceil()
    .toNumber();
}
export function estimateReservation(
  model: string,
  endpoint: "responses" | "decisions",
  body: unknown,
  maxOutputTokens: number,
  questions = 1,
  now = new Date(),
): number {
  const p = knownPricing(model, now);
  if (endpoint === "decisions" && model !== "gpt-6-luna")
    throw new BudgetError("Decisions 仅支持 gpt-6-luna");
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (
    bytes > 48_000 ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 0 ||
    maxOutputTokens > 4096 ||
    questions < 1 ||
    questions > 10
  )
    throw new BudgetError("请求超出已核实短上下文预算边界");
  // Text-only UTF-8 byte upper bound + protocol overhead; conservatively repeat shared input per question.
  const input = (bytes + 2048) * (endpoint === "decisions" ? questions : 1);
  return Math.ceil(
    (input * Math.max(p.input, p.write) +
      maxOutputTokens * (endpoint === "decisions" ? 0 : p.output)) *
      1.25,
  );
}
export class BudgetManager {
  constructor(
    private store: BudgetStore,
    private now: () => Date = () => new Date(),
  ) {}
  records(): Reservation[] {
    return this.store.list<Reservation>(NS);
  }
  private totals(settings: AppSettings, category?: TaskCategory) {
    const now = this.now(),
      month = shanghaiMonth(now),
      start = Date.parse(settings.creditStartsAt),
      end = Date.parse(settings.creditExpiresAt);
    let spent = 0,
      reserved = 0,
      creditSpent = 0;
    for (const record of this.records()) {
      if (category && record.category !== category) continue;
      if (record.status === "reserved" || record.status === "ambiguous") {
        reserved += record.reservedMicros;
        continue;
      }
      if (record.status !== "settled") continue;
      const dates = [
        record.createdAt,
        record.completedAt ?? record.createdAt,
      ].map((s) => new Date(s));
      // A boundary-spanning request counts in both affected windows until invoice reconciliation.
      if (dates.some((d) => shanghaiMonth(d) === month))
        spent += record.actualMicros ?? record.reservedMicros;
      if (dates.some((d) => d.getTime() >= start && d.getTime() < end))
        creditSpent += record.actualMicros ?? record.reservedMicros;
    }
    return { month, spent, reserved, creditSpent };
  }
  summary(settings: AppSettings): BudgetSummary {
    const { month, spent, reserved, creditSpent } = this.totals(settings);
    let limit = 0,
      creditLimit = 0,
      reason: string | undefined;
    try {
      limit = Math.max(
        0,
        Math.min(micros(settings.monthlyLimit), 90 * MICRO) - 5 * MICRO,
      );
      creditLimit = Math.max(0, micros(settings.creditAmount) - 5 * MICRO);
    } catch {
      reason = "预算金额无效";
    }
    if (!settings.apiEnabled) reason = "API 自动调用未启用";
    else if (!settings.creditConfirmed) reason = "尚未确认本期可用 API Credit";
    else if (!activePeriod(settings, this.now()))
      reason = "API Credit 区间无效、尚未开始或已过期";
    else if (this.store.get(NS + "-state", "blocked"))
      reason = "实际费用超过预留，需核对账单后恢复";
    const creditRemaining = Math.max(0, creditLimit - creditSpent - reserved);
    const remaining = Math.max(
      0,
      Math.min(limit - spent - reserved, creditRemaining),
    );
    if (!reason && remaining <= 0) reason = "本月或本期 Credit 预算已耗尽";
    return {
      month,
      spent: dollars(spent),
      reserved: dollars(reserved),
      limit: dollars(limit),
      remaining: dollars(remaining),
      creditRemaining: dollars(creditRemaining),
      enabled: !reason,
      ...(reason ? { reason } : {}),
    };
  }
  reserve(
    settings: AppSettings,
    input: Pick<Reservation, "category" | "model" | "endpoint"> & {
      reservedMicros: number;
    },
  ): Reservation {
    return this.store.atomic(() => {
      knownPricing(input.model, this.now());
      const summary = this.summary(settings);
      if (!summary.enabled) throw new BudgetError(summary.reason);
      if (
        !Number.isSafeInteger(input.reservedMicros) ||
        input.reservedMicros <= 0
      )
        throw new BudgetError("预留金额无效");
      const category = this.totals(settings, input.category);
      if (
        input.reservedMicros > micros(summary.remaining) ||
        category.spent + category.reserved + input.reservedMicros >
          CATEGORY_LIMITS[input.category] * MICRO
      )
        throw new BudgetError("任务配额或总预算不足，本次未调用");
      const record: Reservation = {
        ...input,
        id: randomUUID(),
        createdAt: this.now().toISOString(),
        status: "reserved",
      };
      this.store.put(NS, record.id, record);
      return record;
    });
  }
  settle(id: string, usage: Usage): void {
    this.store.atomic(() => {
      const record = this.store.get<Reservation>(NS, id);
      if (!record || record.status === "released")
        throw new BudgetError("找不到有效预算预留");
      if (record.status === "settled") return;
      const cost = usageCostMicros(record.model, record.endpoint, usage);
      this.store.put(NS, id, {
        ...record,
        actualMicros: cost,
        usage,
        completedAt: this.now().toISOString(),
        status: "settled",
      });
      if (cost > record.reservedMicros)
        this.store.put(NS + "-state", "blocked", true);
    });
  }
  ambiguous(id: string): void {
    this.store.atomic(() => {
      const r = this.store.get<Reservation>(NS, id);
      if (r && r.status === "reserved")
        this.store.put(NS, id, {
          ...r,
          status: "ambiguous",
          reason: "请求已发出但费用未确认；不自动重试或释放",
        });
    });
  }
  releaseUnsent(id: string): void {
    this.store.atomic(() => {
      const r = this.store.get<Reservation>(NS, id);
      if (r?.status === "reserved")
        this.store.put(NS, id, {
          ...r,
          status: "released",
          reason: "请求尚未发出",
        });
    });
  }
}
