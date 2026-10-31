import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type {
  Currency,
  Instrument,
  LedgerTransaction,
  TransactionInput,
} from "../shared/types.js";
import type { Store } from "./store.js";

Decimal.set({ precision: 36 });
export const d = (v: Decimal.Value = 0) => new Decimal(v);
const quantityValue = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,8})?$/, "数量必须为非负十进制数字，最多8位小数");
const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "金额必须为非负十进制数字，精确到分");
function validLedgerDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01") return false;
  const parsed = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const currencies = z.enum(["CNY", "USD", "HKD", "GBP", "EUR"]);
export const transactionSchema = z
  .object({
    idempotencyKey: z.string().min(1).max(200),
    kind: z.enum([
      "deposit",
      "withdraw",
      "buy",
      "sell",
      "subscribe",
      "redeem",
      "confirm",
      "settle",
      "cancel",
      "dividend",
      "reinvest",
      "fee",
      "tax",
      "fx",
      "opening",
    ]),
    code: z
      .string()
      .regex(/^[\w.-]{1,30}$/)
      .optional(),
    account: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(
        (v) =>
          !v.includes("|") &&
          !["__proto__", "constructor", "prototype"].includes(v),
        "账户名称不能包含分隔符或保留名称",
      ),
    currency: currencies,
    date: z
      .string()
      .refine(validLedgerDate, "请输入有效日期")
      .refine((v) => v <= today(), "未来日期请记录为计划，不得计入实际账本"),
    amount: money,
    quantity: quantityValue.optional(),
    fee: money.optional(),
    parentId: z.string().max(100).optional(),
    toCurrency: currencies.optional(),
    toAmount: money.optional(),
    fxRateToCny: quantityValue.refine((v) => Number(v) > 0).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();
type Holding = {
  code: string;
  account: string;
  currency: Currency;
  quantity: Decimal;
  cost: Decimal;
  reserved: Decimal;
  lots: { quantity: Decimal; date: string }[];
};
type Pending = {
  kind: "subscribe" | "redeem" | "receivable";
  currency: Currency;
  account: string;
  amount: Decimal;
  quantity: Decimal;
  code?: string;
  closed: boolean;
  date: string;
};
export interface LedgerState {
  cash: Map<string, Decimal>;
  frozen: Map<string, Decimal>;
  receivables: Map<string, Decimal>;
  positions: Map<string, Holding>;
  pending: Map<string, Pending>;
  realized: Map<string, Decimal>;
  income: Map<string, Decimal>;
  fees: Map<string, Decimal>;
  external: Map<string, Decimal>;
}
const add = (m: Map<string, Decimal>, k: string, v: Decimal.Value) =>
  m.set(k, (m.get(k) ?? d()).plus(v));
const check = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
export function replay(
  transactions: LedgerTransaction[],
  instruments: Map<string, Instrument> = new Map(),
): LedgerState {
  const s: LedgerState = {
    cash: new Map(),
    frozen: new Map(),
    receivables: new Map(),
    positions: new Map(),
    pending: new Map(),
    realized: new Map(),
    income: new Map(),
    fees: new Map(),
    external: new Map(),
  };
  const active = transactions
    .filter((t) => !t.reversedBy && !t.reverses)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
    );
  for (const t of active) {
    const a = d(t.amount),
      f = d(t.fee ?? 0),
      q = d(t.quantity ?? 0),
      c = t.currency,
      accountKey = t.account + "|" + c;
    check(
      a.isFinite() &&
        f.isFinite() &&
        q.isFinite() &&
        a.gte(0) &&
        f.gte(0) &&
        q.gte(0),
      "账本包含无效金额或份额",
    );
    check(
      a.decimalPlaces() <= 2 && f.decimalPlaces() <= 2,
      "账本金额必须精确到分",
    );
    check(validLedgerDate(t.date), "账本日期无效");
    if (!["confirm", "settle", "cancel"].includes(t.kind))
      check(!t.parentId, "此事件不接受关联申请");
    if (t.kind !== "fx")
      check(
        t.toCurrency === undefined && t.toAmount === undefined,
        "仅换汇事件可以填写目标币种和到账金额",
      );
    if (["opening", "redeem", "fee", "tax"].includes(t.kind))
      check(
        f.eq(0),
        "此事件不支持附加fee；费用请在成交确认或独立费用事件中登记",
      );
    const cash = (value: Decimal) => {
      check(
        (s.cash.get(accountKey) ?? d()).plus(value).gte(0),
        "账户可用现金不足",
      );
      add(s.cash, accountKey, value);
    };
    const holding = () => {
      check(!!t.code, "此交易需要产品代码");
      const product = instruments.get(t.code!);
      if (product)
        check(product.currency === c, "交易币种与产品份额币种不一致");
      const key = t.account + "|" + t.code;
      let h = s.positions.get(key);
      if (!h) {
        h = {
          code: t.code!,
          account: t.account,
          currency: c,
          quantity: d(),
          cost: d(),
          reserved: d(),
          lots: [],
        };
        s.positions.set(key, h);
      }
      check(h.currency === c, "同一份额不能混用币种");
      return h;
    };
    const acquire = (qty: Decimal, cost: Decimal) => {
      check(qty.gt(0), "确认份额必须大于0");
      const h = holding();
      h.quantity = h.quantity.plus(qty);
      h.cost = h.cost.plus(cost);
      h.lots.push({ quantity: qty, date: t.date });
    };
    const dispose = (qty: Decimal, gross: Decimal, reserved = false) => {
      const h = holding();
      check(
        qty.gt(0) &&
          qty.lte(reserved ? h.quantity : h.quantity.minus(h.reserved)),
        "可卖份额不足",
      );
      const basis = qty.eq(h.quantity)
        ? h.cost
        : h.cost
            .times(qty)
            .div(h.quantity)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      h.cost = h.cost.minus(basis);
      h.quantity = h.quantity.minus(qty);
      let left = qty;
      for (const lot of h.lots) {
        const n = Decimal.min(lot.quantity, left);
        lot.quantity = lot.quantity.minus(n);
        left = left.minus(n);
      }
      add(s.realized, c, gross.minus(basis));
      if (h.quantity.eq(0)) h.cost = d();
    };
    const parent = () => {
      const p = s.pending.get(t.parentId ?? "");
      check(!!p && !p.closed, "未找到可处理的在途申请");
      check(
        p!.account === t.account && p!.currency === c,
        "必须使用申请原账户和币种",
      );
      check(p!.date <= t.date, "确认或到账不能早于申请");
      if (p!.code) check(t.code === p!.code, "必须使用申请原产品代码");
      return p!;
    };
    switch (t.kind) {
      case "deposit":
        check(a.gt(0) && a.gte(f), "入金必须大于0且足以支付费用");
        cash(a.minus(f));
        add(s.external, c, a);
        add(s.fees, c, f);
        break;
      case "withdraw":
        check(a.gt(0), "出金必须大于0");
        cash(a.plus(f).neg());
        add(s.external, c, a.neg());
        add(s.fees, c, f);
        break;
      case "opening":
        check(a.gt(0), "期初成本必须大于0");
        acquire(q, a);
        add(s.external, c, a);
        break;
      case "buy":
        check(a.gt(0), "成交金额必须大于0");
        cash(a.plus(f).neg());
        acquire(q, a);
        add(s.fees, c, f);
        break;
      case "sell":
        check(a.gt(0), "成交金额必须大于0");
        check(a.gte(f), "费用不能超过卖出金额");
        dispose(q, a);
        cash(a.minus(f));
        add(s.fees, c, f);
        break;
      case "subscribe":
        check(a.gt(0), "申购金额必须大于0");
        check(q.eq(0), "申购申请不可填写尚未确认的份额");
        holding();
        cash(a.plus(f).neg());
        add(s.frozen, accountKey, a);
        add(s.fees, c, f);
        s.pending.set(t.id, {
          kind: "subscribe",
          currency: c,
          account: t.account,
          amount: a,
          quantity: d(),
          code: t.code,
          closed: false,
          date: t.date,
        });
        break;
      case "redeem": {
        check(a.eq(0), "赎回申请金额尚未确认，应填0并填写申请份额");
        const h = holding();
        check(q.gt(0) && q.lte(h.quantity.minus(h.reserved)), "可赎回份额不足");
        h.reserved = h.reserved.plus(q);
        s.pending.set(t.id, {
          kind: "redeem",
          currency: c,
          account: t.account,
          amount: a,
          quantity: q,
          code: t.code,
          closed: false,
          date: t.date,
        });
        break;
      }
      case "confirm": {
        const p = parent();
        check(p.kind !== "receivable", "该记录已经确认");
        if (p.kind === "subscribe") {
          check(a.gt(0) && a.lte(p.amount), "确认金额不得超过申请金额");
          add(s.frozen, accountKey, p.amount.neg());
          cash(p.amount.minus(a).minus(f));
          acquire(q, a);
          add(s.fees, c, f);
        } else {
          check(a.gte(f) && a.gt(0), "赎回确认金额无效");
          if (q.gt(0)) check(q.eq(p.quantity), "部分确认请拆分原赎回申请");
          dispose(p.quantity, a, true);
          holding().reserved = holding().reserved.minus(p.quantity);
          add(s.receivables, accountKey, a.minus(f));
          add(s.fees, c, f);
          s.pending.set(t.id, {
            ...p,
            kind: "receivable",
            amount: a.minus(f),
            closed: false,
            date: t.date,
          });
        }
        p.closed = true;
        break;
      }
      case "settle": {
        const p = parent();
        check(p.kind === "receivable", "只能结算已确认的应收款");
        check(
          a.plus(f).eq(p.amount),
          "实际到账金额加到账费用应与确认应收净额一致",
        );
        check(q.eq(0), "到账事件不能再次填写成交份额");
        add(s.receivables, accountKey, p.amount.neg());
        cash(a);
        add(s.fees, c, f);
        p.closed = true;
        break;
      }
      case "cancel": {
        const p = parent();
        check(p.kind !== "receivable", "已确认应收款不能取消申请");
        check(
          a.eq(0) && q.eq(0),
          "取消申请的金额和份额应填0，原申请将完整释放",
        );
        if (p.kind === "subscribe") {
          add(s.frozen, accountKey, p.amount.neg());
          cash(p.amount.minus(f));
        } else {
          holding().reserved = holding().reserved.minus(p.quantity);
          cash(f.neg());
        }
        add(s.fees, c, f);
        p.closed = true;
        break;
      }
      case "dividend":
        check(a.gte(f), "费用不能超过分红");
        cash(a.minus(f));
        add(s.income, c, a);
        add(s.fees, c, f);
        break;
      case "reinvest":
        check(a.gt(0), "红利再投的已确认红利金额必须大于0");
        cash(f.neg());
        acquire(q, a);
        add(s.income, c, a);
        add(s.fees, c, f);
        break;
      case "fee":
      case "tax":
        cash(a.neg());
        add(s.fees, c, a);
        break;
      case "fx":
        check(
          a.gt(0) &&
            !!t.toCurrency &&
            t.toCurrency !== c &&
            d(t.toAmount ?? 0).gt(0) &&
            d(t.toAmount!).decimalPlaces() <= 2,
          "换汇需要正的本金、不同的目标币种与实际到账金额",
        );
        cash(a.plus(f).neg());
        add(s.cash, t.account + "|" + t.toCurrency, d(t.toAmount!));
        add(s.fees, c, f);
        break;
    }
  }
  return s;
}
export function transactions(store: Store) {
  return store.list<LedgerTransaction>("transactions");
}
export function recordTransaction(
  store: Store,
  input: unknown,
): LedgerTransaction {
  const parsed = transactionSchema.parse(input);
  return store.atomic(() => {
    const prior = store.get<LedgerTransaction>(
      "idempotency",
      parsed.idempotencyKey,
    );
    if (prior) {
      const saved = { ...prior } as Record<string, unknown>;
      delete saved.id;
      delete saved.createdAt;
      delete saved.reversedBy;
      delete saved.reverses;
      check(
        JSON.stringify(saved) === JSON.stringify(parsed),
        "幂等键已经用于不同的交易",
      );
      return store.get<LedgerTransaction>("transactions", prior.id) ?? prior;
    }
    const t: LedgerTransaction = {
      ...parsed,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const productMap = new Map(
      store.list<Instrument>("instruments").map((i) => [i.code, i]),
    );
    replay([...transactions(store), t], productMap);
    store.put("transactions", t.id, t);
    store.put("idempotency", t.idempotencyKey, t);
    store.bump();
    return t;
  });
}
export function reverseTransaction(store: Store, id: string) {
  return store.atomic(() => {
    const t = store.get<LedgerTransaction>("transactions", id);
    check(!!t, "交易不存在");
    check(!t!.reverses, "冲销记录不能再次冲销");
    if (t!.reversedBy)
      return store.get<LedgerTransaction>("transactions", t!.reversedBy);
    const reverse: LedgerTransaction = {
      ...t!,
      id: randomUUID(),
      idempotencyKey: "reverse:" + id,
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString(),
      reverses: id,
      note: "冲销原交易",
    };
    const next = transactions(store).map((x) =>
      x.id === id ? { ...x, reversedBy: reverse.id } : x,
    );
    replay(
      [...next, reverse],
      new Map(store.list<Instrument>("instruments").map((i) => [i.code, i])),
    );
    store.put("transactions", id, { ...t!, reversedBy: reverse.id });
    store.put("transactions", reverse.id, reverse);
    store.bump();
    return reverse;
  });
}
