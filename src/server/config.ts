import { z } from "zod";
import type { AppSettings } from "../shared/types.js";
import type { Store } from "./store.js";

export const DEFAULT_SETTINGS: AppSettings = {
  model: "gpt-6.1-sol",
  reasoning: "medium",
  apiEnabled: false,
  monthlyLimit: "90",
  creditAmount: "0",
  creditStartsAt: "",
  creditExpiresAt: "",
  creditConfirmed: false,
  monitoring: false,
  risk: {
    minimumCash: "0",
    singleTradeLimit: "0",
    maxPositionPct: "20",
    configured: false,
  },
  theme: "dark",
  allowedRead: true,
  allowedWrite: true,
  holidays: { CN: [], HK: [], US: [], UK: [], EU: [] },
  calendarVerifiedThrough: {},
  fxRates: { CNY: "1" },
  fxAsOf: "",
};
const nonnegative = z.string().regex(/^\d{1,12}(\.\d{1,8})?$/);
const schema = z
  .object({
    model: z.string().max(100),
    reasoning: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
    apiEnabled: z.boolean(),
    monthlyLimit: nonnegative.refine((v) => Number(v) <= 90),
    creditAmount: nonnegative,
    creditStartsAt: z.string().max(40),
    creditExpiresAt: z.string().max(40),
    creditConfirmed: z.boolean(),
    monitoring: z.boolean(),
    risk: z.object({
      minimumCash: nonnegative,
      singleTradeLimit: nonnegative,
      maxPositionPct: nonnegative.refine(
        (v) => Number(v) > 0 && Number(v) <= 100,
      ),
      configured: z.boolean(),
    }),
    theme: z.enum(["dark", "light"]),
    allowedRead: z.boolean(),
    allowedWrite: z.boolean(),
    holidays: z.record(
      z.string(),
      z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    ),
    calendarVerifiedThrough: z.record(
      z.string(),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    ),
    fxRates: z.record(
      z.string(),
      nonnegative.refine((v) => Number(v) > 0),
    ),
    fxAsOf: z.string().max(40),
  })
  .strict();
export function settings(store: Store): AppSettings {
  return (
    store.get<AppSettings>("settings", "app") ??
    structuredClone(DEFAULT_SETTINGS)
  );
}
export function updateSettings(store: Store, patch: unknown): AppSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("设置格式错误");
  const old = settings(store);
  const obj = patch as Partial<AppSettings>;
  const next = schema.parse({
    ...old,
    ...obj,
    risk: { ...old.risk, ...obj.risk },
  });
  if (next.fxRates.CNY !== "1") throw new Error("人民币基准汇率必须为1");
  if (
    next.fxAsOf &&
    (!Number.isFinite(Date.parse(next.fxAsOf)) ||
      Date.parse(next.fxAsOf) > Date.now() + 60000)
  )
    throw new Error("汇率日期必须有效且不能晚于当前时间");
  if (
    next.creditConfirmed &&
    (!Number.isFinite(Date.parse(next.creditStartsAt)) ||
      !Number.isFinite(Date.parse(next.creditExpiresAt)) ||
      Date.parse(next.creditExpiresAt) <= Date.parse(next.creditStartsAt))
  )
    throw new Error("请填写有效的额度起止日期");
  if (next.risk.configured && Number(next.risk.singleTradeLimit) <= 0)
    throw new Error("请设置大于0的单笔上限");
  store.atomic(() => {
    store.put("settings", "app", next);
    store.bump();
  });
  return next;
}
