let csrf = "";

export function setCsrf(value: string) {
  csrf = value;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" && csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = await response.text();
  let result: any;
  try {
    result = content ? JSON.parse(content) : {};
  } catch {
    throw new ApiError(
      "服务返回了无法读取的结果，请稍后重试。",
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      typeof result.error === "string"
        ? result.error
        : result.error?.message || result.message;
    throw new ApiError(
      message || `请求未完成（${response.status}）`,
      response.status,
    );
  }
  return result as T;
}

export function money(
  value: string | number | null | undefined,
  currency = "CNY",
  digits = 2,
) {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

export function number(value: string | number | null | undefined, digits = 2) {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return "—";
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
  }).format(Number(value));
}

export function percent(
  value: string | number | null | undefined,
  signed = false,
) {
  if (value == null || value === "" || !Number.isFinite(Number(value)))
    return "—";
  const n = Number(value);
  return `${signed && n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function dateTime(value?: string, short = false) {
  if (!value) return "尚未更新";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(short ? {} : { hour: "2-digit", minute: "2-digit" }),
    hour12: false,
  }).format(date);
}

export const kindLabel: Record<string, string> = {
  fund: "公募基金",
  qdii: "QDII",
  fof: "FOF",
  etf: "ETF",
  stock: "股票",
  money: "货币基金",
};
export const transactionLabel: Record<string, string> = {
  deposit: "资金转入",
  withdraw: "资金转出",
  buy: "买入成交",
  sell: "卖出成交",
  subscribe: "提交申购",
  redeem: "提交赎回",
  confirm: "份额确认",
  settle: "资金到账",
  cancel: "撤销申请",
  dividend: "现金分红",
  reinvest: "红利再投",
  fee: "费用",
  tax: "税费",
  fx: "货币兑换",
  opening: "期初持仓",
};
