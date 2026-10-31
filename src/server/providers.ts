import { load } from "cheerio";
import { Decimal } from "decimal.js";
import { priceHistory } from "./price-history.js";
import type {
  DocumentCard,
  Exposure,
  HistoryPoint,
  Instrument,
  InstrumentKind,
  MarketObservation,
  ProductData,
} from "../shared/types.js";

export const REFERENCE_INSTRUMENTS: Instrument[] = [
  {
    code: "000216",
    name: "华安黄金ETF联接A",
    kind: "fund",
    currency: "CNY",
    market: "CN",
    manager: "华安基金管理有限公司",
    shareClass: "A",
  },
  {
    code: "539003",
    name: "建信富时100指数(QDII)A人民币",
    kind: "qdii",
    currency: "CNY",
    market: "CN",
    manager: "建信基金管理有限责任公司",
    shareClass: "A人民币",
  },
  {
    code: "161815",
    name: "银华抗通胀主题(QDII-FOF-LOF)A",
    kind: "fof",
    currency: "CNY",
    market: "CN",
    manager: "银华基金管理股份有限公司",
    shareClass: "A",
  },
  {
    code: "006282",
    name: "摩根欧洲动力策略股票(QDII)A",
    kind: "qdii",
    currency: "CNY",
    market: "CN",
    manager: "摩根基金管理(中国)有限公司",
    shareClass: "A",
  },
  {
    code: "017641",
    name: "摩根标普500指数(QDII)人民币A",
    kind: "qdii",
    currency: "CNY",
    market: "CN",
    manager: "摩根基金管理(中国)有限公司",
    shareClass: "人民币A",
  },
  {
    code: "019172",
    name: "摩根纳斯达克100指数(QDII)人民币A",
    kind: "qdii",
    currency: "CNY",
    market: "CN",
    manager: "摩根基金管理(中国)有限公司",
    shareClass: "人民币A",
  },
].map((x) => ({
  ...x,
  sourceUrl: `https://www.efundcf.com.cn/fund/${x.code.slice(0, 3)}/${x.code}.shtml`,
})) as Instrument[];

const MANAGERS: Record<string, string> = {
  华安: "https://www.huaan.com.cn/",
  建信: "https://www.ccbfund.cn/",
  银华: "https://www.yhfund.com.cn/",
  摩根: "https://am.jpmorgan.com/cn/zh/asset-management/per/",
  易方达: "https://www.efunds.com.cn/",
  华夏: "https://www.chinaamc.com/",
  南方: "https://www.nffund.com/",
  广发: "https://www.gffunds.com.cn/",
  嘉实: "https://www.jsfund.cn/",
  富国: "https://www.fullgoal.com.cn/",
  博时: "https://www.bosera.com/",
  招商: "https://www.cmfchina.com/",
  工银: "https://www.icbccs.com.cn/",
  汇添富: "https://www.99fund.com/",
  国泰: "https://www.gtfund.com/",
  鹏华: "https://www.phfund.com.cn/",
  中欧: "https://www.zofund.com/",
  万家: "https://www.wjasset.com/",
  景顺: "https://www.igwfmc.com/",
  大成: "https://www.dcfund.com.cn/",
  中银: "https://www.bocim.com/",
  长盛: "https://www.csfunds.com.cn/",
};
const SOURCE_HOSTS = new Set([
  "www.efundcf.com.cn",
  "www.efunds.com.cn",
  "cdn.efunds.com.cn",
  "fund.eastmoney.com",
  "fundf10.eastmoney.com",
  "push2.eastmoney.com",
  "push2his.eastmoney.com",
  "qt.gtimg.cn",
  "eid.csrc.gov.cn",
]);
export const REPORT_HOSTS = new Set([
  ...SOURCE_HOSTS,
  ...Object.values(MANAGERS).map((url) => new URL(url).hostname),
  "wap.huaan.com.cn",
  "m.ccbfund.cn",
  "static.cninfo.com.cn",
  "www.cninfo.com.cn",
  "www.sse.com.cn",
  "disc.static.szse.cn",
  "www.szse.cn",
  "pdf.dfcfw.com",
  "e.boc.cn",
  "www.bankofchina.com",
]);

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly sourceUrl?: string,
    public readonly retryAt?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function validatePublicUrl(
  raw: string,
  purpose: "data" | "report" = "data",
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError("unsafe_url", "无效的数据源 URL");
  }
  const hosts = purpose === "report" ? REPORT_HOSTS : SOURCE_HOSTS;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.has(url.hostname.toLowerCase())
  ) {
    throw new ProviderError(
      "unsafe_url",
      "数据源必须使用允许名单内的 HTTPS 主机，不允许本地地址、凭据或自定义端口",
    );
  }
  if (/%(?:00|0a|0d)/i.test(url.href))
    throw new ProviderError("unsafe_url", "URL 包含控制字符");
  return url;
}

type FetchFunction = typeof globalThis.fetch;
interface PublicDataResponse {
  body: string;
  contentType: string;
  bytes: Uint8Array;
}
interface CacheEntry extends PublicDataResponse {
  expires: number;
}
export class PublicDataClient {
  private cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private inFlight = new Map<string, Promise<PublicDataResponse>>();
  private tails = new Map<string, Promise<void>>();
  private lastStart = new Map<string, number>();
  private cooldown = new Map<string, number>();
  constructor(
    private readonly transport: FetchFunction = globalThis.fetch,
    private readonly now = () => Date.now(),
    private readonly pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}
  clear(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }
  async read(
    url: string,
    options: {
      ttlMs?: number;
      purpose?: "data" | "report";
      encoding?: string;
      maxBytes?: number;
    } = {},
  ): Promise<PublicDataResponse> {
    const parsed = validatePublicUrl(url, options.purpose);
    const key = `${url}|${options.encoding ?? "utf-8"}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) {
      if (cached.bytes.length > (options.maxBytes ?? 5_000_000))
        throw new ProviderError(
          "too_large",
          "缓存来源数据超过本次大小限制",
          url,
        );
      return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = (async () => {
      const host = parsed.hostname;
      const previous = this.tails.get(host) ?? Promise.resolve();
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.tails.set(
        host,
        previous.catch(() => {}).then(() => barrier),
      );
      await previous.catch(() => {});
      try {
        const blockedUntil = this.cooldown.get(host) ?? 0;
        if (blockedUntil > this.now())
          throw new ProviderError(
            "backoff",
            "来源暂时限流；已停止自动重试",
            url,
            new Date(blockedUntil).toISOString(),
          );
        const wait = 1000 - (this.now() - (this.lastStart.get(host) ?? 0));
        if (wait > 0) await this.pause(wait);
        this.lastStart.set(host, this.now());
        let current = url;
        let response: Response | undefined;
        for (let redirects = 0; redirects <= 2; redirects++) {
          validatePublicUrl(current, options.purpose);
          response = await this.transport(current, {
            redirect: "manual",
            signal: AbortSignal.timeout(20_000),
            headers: {
              Accept:
                options.purpose === "report"
                  ? "application/pdf,text/html,text/plain,application/json"
                  : "text/html,application/json,text/plain,*/*",
              "User-Agent": "FinanceLocal/0.1 (personal public-data reader)",
            },
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            await response.body?.cancel();
            if (!location || redirects === 2)
              throw new ProviderError(
                "redirect",
                "数据源重定向无效或过多",
                url,
              );
            const target = new URL(location, current);
            validatePublicUrl(target.href, options.purpose);
            // Same host only: redirects cannot bypass another host's request budget or permission.
            if (target.hostname !== parsed.hostname)
              throw new ProviderError(
                "redirect",
                "跨主机重定向须单独配置数据源",
                url,
              );
            await this.pause(1000);
            this.lastStart.set(host, this.now());
            current = target.href;
            continue;
          }
          break;
        }
        if (!response)
          throw new ProviderError("empty_response", "数据源未返回响应", url);
        if ([403, 429].includes(response.status)) {
          const retry = response.headers.get("retry-after");
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 0;
          const until = Math.max(
            this.now() + (response.status === 403 ? 3_600_000 : 300_000),
            this.now() + seconds * 1000,
            retry && !seconds ? Date.parse(retry) || 0 : 0,
          );
          this.cooldown.set(host, until);
          await response.body?.cancel();
          throw new ProviderError(
            `http_${response.status}`,
            `来源返回 ${response.status}，不绕过限制，稍后再试`,
            url,
            new Date(until).toISOString(),
          );
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new ProviderError(
            `http_${response.status}`,
            `来源响应 HTTP ${response.status}`,
            url,
          );
        }
        const maxBytes = options.maxBytes ?? 5_000_000;
        const declared = Number(response.headers.get("content-length") ?? 0);
        if (declared > maxBytes) {
          await response.body?.cancel();
          throw new ProviderError("too_large", "来源数据超过大小限制", url);
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (!reader)
          throw new ProviderError("empty_response", "来源响应正文为空", url);
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value.length;
          if (total > maxBytes) {
            await reader.cancel();
            throw new ProviderError("too_large", "来源数据超过大小限制", url);
          }
          chunks.push(next.value);
        }
        const merged = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          merged.set(chunk, at);
          at += chunk.length;
        }
        const contentType = response.headers.get("content-type") ?? "";
        const body = /pdf/i.test(contentType)
          ? ""
          : new TextDecoder(options.encoding ?? "utf-8").decode(merged);
        const value = { body, contentType, bytes: merged };
        const replaced = this.cache.get(key);
        if (replaced)
          this.cacheBytes -= replaced.bytes.length + replaced.body.length * 2;
        this.cache.set(key, {
          ...value,
          expires: this.now() + (options.ttlMs ?? 60_000),
        });
        this.cacheBytes += merged.length + body.length * 2;
        while (this.cache.size > 192 || this.cacheBytes > 64_000_000) {
          const oldestKey = this.cache.keys().next().value!;
          const oldest = this.cache.get(oldestKey)!;
          this.cacheBytes -= oldest.bytes.length + oldest.body.length * 2;
          this.cache.delete(oldestKey);
        }
        return value;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(
          "network",
          error instanceof Error ? error.message : "网络请求失败",
          url,
        );
      } finally {
        release();
      }
    })();
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }
}
export const publicDataClient = new PublicDataClient();

const clean = (value: string) => value.replace(/\s+/g, " ").trim();
function decimal(value: string, positive = false): string {
  const text = value.replace(/[,，%\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(text))
    throw new ProviderError("invalid_number", `非法数值：${text.slice(0, 40)}`);
  const result = new Decimal(text);
  if (!result.isFinite() || (positive && !result.greaterThan(0)))
    throw new ProviderError("invalid_number", "价格/净值必须大于零");
  return result.toFixed();
}
export function isoDate(raw: string): string {
  const compact = raw.replace(/[-/]/g, "");
  if (!/^\d{8}$/.test(compact))
    throw new ProviderError("invalid_date", "缺少有效数据日期");
  const normalized = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
  if (
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(normalized).toISOString().slice(0, 10) !== normalized
  )
    throw new ProviderError("invalid_date", "无效日历日期");
  return normalized;
}
function validateFundCode(code: string): void {
  if (!/^\d{6}$/.test(code))
    throw new ProviderError("invalid_code", "境内公募基金代码须为六位数字");
}
export function fundProductUrl(code: string): string {
  validateFundCode(code);
  return `https://www.efundcf.com.cn/fund/${code.slice(0, 3)}/${code}.shtml`;
}
function kindFor(name: string, type = ""): InstrumentKind {
  const text = `${name} ${type}`;
  if (/FOF|基金中基金/i.test(text)) return "fof";
  if (/QDII/i.test(text)) return "qdii";
  if (/货币/.test(text)) return "money";
  // An ETF feeder is an OTC fund, not the listed ETF it owns.
  if (/ETF/i.test(text) && !/联接/.test(text)) return "etf";
  return "fund";
}

/** Parses a single inert JSON assignment. Appended code, comments and JavaScript expressions are rejected. */
export function parseFundCatalog(script: string): Instrument[] {
  const match = /^\uFEFF?\s*(?:var\s+)?r\s*=\s*(\[[\s\S]*\])\s*;?\s*$/.exec(
    script,
  );
  if (!match)
    throw new ProviderError(
      "catalog_format",
      "基金目录不是允许的 JSON 字面量赋值",
    );
  let rows: unknown;
  try {
    rows = JSON.parse(match[1]);
  } catch {
    throw new ProviderError("catalog_format", "基金目录包含非 JSON 内容");
  }
  if (!Array.isArray(rows))
    throw new ProviderError("catalog_format", "基金目录不是数组");
  const unique = new Map<string, Instrument>();
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length < 4 ||
      row.some((x) => typeof x !== "string")
    )
      throw new ProviderError("catalog_row", "基金目录行结构变化");
    const [code, initials, name, type, fullPinyin] = row as string[];
    if (!/^\d{6}$/.test(code) || !name || name.length > 160)
      throw new ProviderError("catalog_row", "基金代码或名称无效");
    const currency = /美元/.test(name)
      ? "USD"
      : /港币|港元/.test(name)
        ? "HKD"
        : "CNY";
    unique.set(code, {
      code,
      name,
      kind: kindFor(name, type),
      currency,
      market: "CN",
      aliases: [initials, fullPinyin].filter(Boolean),
      shareClass: /([ACEIY])(?:类)?(?:人民币|美元现汇|美元现钞)?$/.exec(
        name,
      )?.[1],
      sourceUrl: fundProductUrl(code),
    });
  }
  return [...unique.values()];
}
export async function fetchCatalog(): Promise<Instrument[]> {
  const { body } = await publicDataClient.read(
    "https://fund.eastmoney.com/js/fundcode_search.js",
    { ttlMs: 86_400_000 },
  );
  return parseFundCatalog(body);
}

/** Regulatory verification only: the published CSRC landing page currently exposes HTTP.
 * This parser does not fetch HTTP or promote the result to an alert-ready market quote. */
export function parseCsrcNav(
  input: unknown,
  code: string,
  requestedDate: string,
): {
  code: string;
  name: string;
  date: string;
  nav: string;
  accumulatedNav?: string;
} {
  validateFundCode(code);
  const date = isoDate(requestedDate);
  const envelope = input as { aaData?: unknown[]; success?: boolean };
  if (
    !envelope ||
    envelope.success === false ||
    !Array.isArray(envelope.aaData)
  )
    throw new ProviderError("csrc_format", "证监会净值响应结构变化或请求失败");
  const observations: {
    code: string;
    name: string;
    date: string;
    nav: string;
    accumulatedNav?: string;
  }[] = [];
  for (const value of envelope.aaData) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (
      row.code !== code ||
      row.valuationDate !== date ||
      typeof row.shareNetValue !== "string" ||
      !row.shareNetValue.trim()
    )
      continue;
    observations.push({
      code,
      name: typeof row.shortName === "string" ? row.shortName : "",
      date,
      nav: decimal(row.shareNetValue, true),
      accumulatedNav:
        typeof row.totalNetValue === "string" && row.totalNetValue.trim()
          ? decimal(row.totalNetValue, true)
          : undefined,
    });
  }
  if (!observations.length)
    throw new ProviderError(
      "csrc_missing",
      "指定份额与日期没有正式单位净值；不以万份收益、参考净值或空记录替代",
    );
  if (
    observations.some(
      (row) =>
        row.nav !== observations[0].nav ||
        row.accumulatedNav !== observations[0].accumulatedNav,
    )
  )
    throw new ProviderError(
      "csrc_conflict",
      "官方同代码同日期存在不同净值，须核对份额或币种",
    );
  return observations[0];
}

/** The upstream file is read as data, never eval/import/vm. */
export function parseFundHistory(
  script: string,
  code: string,
  period?: "all" | "1y",
): HistoryPoint[] {
  validateFundCode(code);
  const match =
    /^\uFEFF?\s*(?:var\s+)?mk_(\d{6})_(all|1y)\s*=\s*"([0-9_.;+-]*)"\s*;?\s*$/.exec(
      script,
    );
  if (!match || match[1] !== code || (period && match[2] !== period))
    throw new ProviderError(
      "history_format",
      "净值历史文件的代码、变量或格式不匹配",
    );
  const rows = match[3].split(";");
  if (rows.shift() !== "0_1_2_3_4")
    throw new ProviderError("history_columns", "历史净值字段定义变化");
  const points = new Map<string, HistoryPoint>();
  for (const row of rows) {
    if (!row) continue;
    const cells = row.split("_");
    if (cells.length !== 5)
      throw new ProviderError("history_columns", "历史净值行字段数变化");
    const point = {
      date: isoDate(cells[0]),
      nav: decimal(cells[2], true),
      accumulatedNav: decimal(cells[3], true),
      changePct: decimal(cells[4]),
    };
    const previous = points.get(point.date);
    if (previous && previous.nav !== point.nav)
      throw new ProviderError(
        "history_duplicate",
        "同一历史文件日期存在相互矛盾的净值",
      );
    points.set(point.date, point);
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function mergeFundHistories(
  archive: HistoryPoint[],
  recent: HistoryPoint[],
): HistoryPoint[] {
  const map = new Map(archive.map((point) => [point.date, point]));
  for (const point of recent) map.set(point.date, point);
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function fundHistoryUrls(
  code: string,
  html?: string,
): { archive: string; recent: string } {
  validateFundCode(code);
  const urls = {
    archive: `https://cdn.efunds.com.cn/data-static/wmfis/index/fund/market/his/${code}_all.js`,
    recent: `https://cdn.efunds.com.cn/data-static/wmfis/index/fund/market/${code}_1y.js`,
  };
  if (html) {
    const $ = load(html);
    $("script[src]").each((_, script) => {
      const src = $(script).attr("src") ?? "";
      if (src === `https://cdn.efunds.com.cn/market/2.0/his/${code}_all.js`)
        urls.archive = src;
      if (src === `https://cdn.efunds.com.cn/market/2.0/${code}_1y.js`)
        urls.recent = src;
    });
  }
  return urls;
}
export async function fetchFundHistory(
  code: string,
  html?: string,
): Promise<HistoryPoint[]> {
  const urls = fundHistoryUrls(code, html);
  const [archive, recent] = await Promise.all([
    publicDataClient.read(urls.archive, { ttlMs: 86_400_000 }),
    publicDataClient.read(urls.recent, { ttlMs: 3_600_000 }),
  ]);
  return mergeFundHistories(
    parseFundHistory(archive.body, code, "all"),
    parseFundHistory(recent.body, code, "1y"),
  );
}

/** Extract known JSON literals only; downloaded JavaScript is never executed. */
export function parseEastmoneyFundData(
  script: string,
  instrument: Instrument,
  fetchedAt = new Date().toISOString(),
): { observation: MarketObservation; history: HistoryPoint[]; name: string } {
  validateFundCode(instrument.code);
  const literal = (name: string, array = false): unknown => {
    const expression = new RegExp(
      `\\bvar\\s+${name}\\s*=\\s*(${array ? "\\[[\\s\\S]*?\\]" : '"(?:[^"\\\\]|\\\\.)*"'})\\s*;`,
      "g",
    );
    const matches = [...script.matchAll(expression)];
    if (matches.length !== 1)
      throw new ProviderError(
        "fund_fallback_format",
        `东财基金字段 ${name} 缺失或重复`,
      );
    try {
      return JSON.parse(matches[0][1]);
    } catch {
      throw new ProviderError(
        "fund_fallback_format",
        "东财字段不属于合法 JSON 字面量",
      );
    }
  };
  if (literal("fS_code") !== instrument.code)
    throw new ProviderError("fund_fallback_identity", "东财基金份额代码不匹配");
  const name = literal("fS_name");
  const trend = literal("Data_netWorthTrend", true);
  if (typeof name !== "string" || !Array.isArray(trend) || !trend.length)
    throw new ProviderError(
      "fund_fallback_format",
      "东财没有正式净值历史；货币收益或估算值不能替代",
    );
  const dateOf = (timestamp: unknown): string => {
    if (
      typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      timestamp > Date.parse(fetchedAt) + 86_400_000
    )
      throw new ProviderError("fund_fallback_date", "东财净值日期无效");
    // The provider's x values represent midnight in Asia/Shanghai, not UTC calendar dates.
    return isoDate(
      new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10),
    );
  };
  const accumulated = new Map<string, string>();
  try {
    const rows = literal("Data_ACWorthTrend", true);
    if (Array.isArray(rows))
      for (const row of rows)
        if (
          Array.isArray(row) &&
          row.length === 2 &&
          typeof row[1] === "number"
        )
          accumulated.set(dateOf(row[0]), decimal(String(row[1]), true));
  } catch {
    /* Optional accumulated NAV is not silently substituted by unit NAV. */
  }
  const byDate = new Map<string, HistoryPoint>();
  for (const value of trend) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ProviderError(
        "fund_fallback_format",
        "东财单位净值字段结构变化",
      );
    const row = value as Record<string, unknown>;
    const date = dateOf(row.x);
    if (typeof row.y !== "number" || !Number.isFinite(row.y))
      throw new ProviderError("fund_fallback_format", "缺少正式单位净值");
    const point: HistoryPoint = {
      date,
      nav: decimal(String(row.y), true),
      accumulatedNav: accumulated.get(date),
      changePct:
        typeof row.equityReturn === "number"
          ? decimal(String(row.equityReturn))
          : undefined,
    };
    if (byDate.has(date) && byDate.get(date)!.nav !== point.nav)
      throw new ProviderError("fund_fallback_conflict", "东财同日历史净值冲突");
    byDate.set(date, point);
  }
  const history = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const latest = history.at(-1)!;
  const ageDays =
    (Date.parse(fetchedAt) - Date.parse(latest.date)) / 86_400_000;
  return {
    name,
    history,
    observation: {
      code: instrument.code,
      price: latest.nav,
      accumulatedNav: latest.accumulatedNav,
      changePct: latest.changePct,
      asOf: latest.date,
      fetchedAt,
      currency: instrument.currency,
      priceKind: "nav",
      source: "东方财富公开正式净值序列（备用来源，尚未独立核验）",
      sourceUrl: `https://fund.eastmoney.com/pingzhongdata/${instrument.code}.js`,
      quality:
        ageDays > (/QDII|FOF/i.test(name) ? 10 : 7) ? "stale" : "unverified",
    },
  };
}

export function parseEastmoneyFundManager(
  html: string,
  code: string,
): { manager: string; url: string } | undefined {
  validateFundCode(code);
  const $ = load(html);
  const title = $("title").text();
  if (!title.includes(`(${code})`) && !title.includes(`（${code}）`))
    throw new ProviderError("fund_manager_identity", "备用产品页代码不匹配");
  let result: { manager: string; url: string } | undefined;
  $("a[href]").each((_, anchor) => {
    if (result) return;
    const href = $(anchor).attr("href") ?? "";
    const manager = clean($(anchor).text());
    if (
      /^https?:\/\/fund\.eastmoney\.com\/company\/\d+\.html$/.test(href) &&
      /基金/.test(manager) &&
      !/基金公司|全部|更多|旗下|同公司/.test(manager)
    )
      result = { manager, url: href.replace(/^http:/, "https:") };
  });
  return result;
}

export function parseProductHtml(
  html: string,
  instrument: Instrument,
  sourceUrl = fundProductUrl(instrument.code),
  fetchedAt = new Date().toISOString(),
): ProductData {
  const $ = load(html);
  $("script,style,noscript").remove();
  const text = clean($.root().text());
  const metadata = new Map<string, string>();
  $("table tr").each((_, row) => {
    const cells = $(row)
      .children("th,td")
      .toArray()
      .map((cell) => clean($(cell).text()));
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = cells[i].replace(/[:：]$/, "");
      if (
        ![
          "基金代码",
          "基金简称",
          "基金管理人",
          "基金类型",
          "交易币种",
          "币种",
        ].includes(key)
      )
        continue;
      if (key === "基金代码" && !/^\d{6}$/.test(cells[i + 1])) continue;
      if (!metadata.has(key)) metadata.set(key, cells[i + 1]);
    }
  });
  const observedCode =
    metadata.get("基金代码") ?? /基金代码\s*[:：]\s*(\d{6})/.exec(text)?.[1];
  if (observedCode !== instrument.code)
    throw new ProviderError(
      "product_identity",
      "来源产品代码不匹配或返回空模板",
      sourceUrl,
    );
  const name = metadata.get("基金简称") ?? instrument.name;
  const manager = metadata.get("基金管理人") ?? instrument.manager;
  const currencyText = metadata.get("交易币种") ?? metadata.get("币种") ?? "";
  const detectedCurrency = /美元/.test(name + currencyText)
    ? "USD"
    : /港币|港元/.test(name + currencyText)
      ? "HKD"
      : "CNY";
  const productInstrument: Instrument = {
    ...instrument,
    name,
    manager,
    currency: detectedCurrency,
    kind: kindFor(name, metadata.get("基金类型") ?? ""),
    sourceUrl,
  };
  const errors: string[] = [];
  let observation: MarketObservation | undefined;
  try {
    const dateMatch = /基金净值日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(text);
    const position = dateMatch?.index ?? -1;
    const block =
      position >= 0 ? text.slice(Math.max(0, position - 350), position) : "";
    const nav = /([\d,.]+)\s*单位净值\s*[（(][^）)]*[）)]/.exec(block)?.[1];
    const accumulated = /([\d,.]+)\s*累计净值\s*[（(][^）)]*[）)]/.exec(
      block,
    )?.[1];
    const change = /([+-]?[\d,.]+)%?\s*日涨跌/.exec(block)?.[1];
    if (!dateMatch || !nav)
      throw new ProviderError(
        "nav_missing",
        "页面未提供带日期的正式单位净值；不使用占位值或万份收益替代",
      );
    const asOf = isoDate(dateMatch[1]);
    if (Date.parse(asOf) > Date.parse(fetchedAt) + 86_400_000)
      throw new ProviderError("future_date", "来源净值日期在未来");
    const age = (Date.parse(fetchedAt) - Date.parse(asOf)) / 86_400_000;
    observation = {
      code: instrument.code,
      price: decimal(nav, true),
      accumulatedNav: accumulated ? decimal(accumulated, true) : undefined,
      changePct: change ? decimal(change) : undefined,
      asOf,
      fetchedAt,
      currency: productInstrument.currency,
      priceKind: "nav",
      source: "易方达财富（基金销售机构公开披露）",
      sourceUrl,
      quality: age > (/QDII|FOF/i.test(name) ? 10 : 7) ? "stale" : "valid",
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "净值解析失败");
  }
  const reportDateRaw = /数据截至\s*(\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  const exposures: Exposure[] = [];
  if (reportDateRaw) {
    const reportDate = isoDate(reportDateRaw);
    $("table").each((_, table) => {
      const rows = $(table).find("tr").toArray();
      const headerRow = rows.findIndex(
        (row) =>
          /占基金(?:总资产|资产净值)|占净值/.test($(row).text()) &&
          /资产类型|股票名称|基金名称|债券名称/.test($(row).text()),
      );
      if (headerRow < 0) return;
      const headers = $(rows[headerRow])
        .children("td,th")
        .toArray()
        .map((cell) => clean($(cell).text()));
      const nameIndex = headers.findIndex((x) =>
        /资产类型|股票名称|基金名称|债券名称/.test(x),
      );
      const codeIndex = headers.findIndex((x) =>
        /股票代码|基金代码|债券代码/.test(x),
      );
      const weightIndex = headers.findIndex((x) =>
        /占基金(?:总资产|资产净值)|占净值/.test(x),
      );
      const allocation = headers.some((x) => /资产类型/.test(x));
      const basis = /总资产/.test(headers[weightIndex])
        ? "total_assets"
        : "net_assets";
      for (const row of rows.slice(headerRow + 1)) {
        const cells = $(row)
          .children("td,th")
          .toArray()
          .map((cell) => clean($(cell).text()));
        const label = cells[nameIndex];
        const rawWeight = cells[weightIndex];
        if (
          !label ||
          !rawWeight ||
          /合计|总计/.test(label) ||
          !/\d/.test(rawWeight)
        )
          continue;
        try {
          const code =
            codeIndex >= 0 &&
            /^[A-Za-z0-9.\-]{1,24}$/.test(cells[codeIndex] ?? "")
              ? cells[codeIndex]
              : undefined;
          exposures.push({
            code,
            name: label,
            weight: decimal(rawWeight),
            basis,
            kind: allocation
              ? "asset_class"
              : /基金名称/.test(headers[nameIndex])
                ? "fund"
                : /债券/.test(headers[nameIndex])
                  ? "bond"
                  : "stock",
            reportDate,
            sourceUrl,
          });
        } catch {
          errors.push(`无法解析穿透权重：${label}`);
        }
      }
    });
  } else errors.push("页面未提供可核实的持仓报告期，未推测穿透结果");
  const documents: DocumentCard[] = [
    {
      id: `product-${instrument.code}`,
      title: `${name} · 产品资料与净值`,
      url: sourceUrl,
      source: "易方达财富",
      category: "product",
    },
  ];
  const managerUrl = Object.entries(MANAGERS).find(([prefix]) =>
    manager?.includes(prefix),
  )?.[1];
  if (managerUrl)
    documents.push({
      id: `manager-${instrument.code}`,
      title: `${manager} · 管理人信息披露入口`,
      url: managerUrl,
      source: manager!,
      category: "product",
    });
  documents.push({
    id: `disclosure-${instrument.code}`,
    title: `${name} · 监管披露查询（代码 ${instrument.code}，公开 HTTP 网站）`,
    url: "http://eid.csrc.gov.cn/fund/disclose/index.html",
    source: "证监会基金电子披露网站",
    category: "report",
  });
  $("a[href]").each((_, anchor) => {
    const href = $(anchor).attr("href");
    const title = clean($(anchor).text());
    if (!href || !title || !/报告|招募|概要|合同|公告/.test(title)) return;
    try {
      const url = new URL(href, sourceUrl).href;
      validatePublicUrl(url, "report");
      if (!/\.pdf(?:\?|$)|公告|report|notice|upload/i.test(url)) return;
      const rawDate = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(
        clean($(anchor).closest("tr").text()),
      )?.[1];
      if (!documents.some((x) => x.url === url))
        documents.push({
          id: `doc-${instrument.code}-${documents.length}`,
          title: title.slice(0, 220),
          url,
          source: new URL(url).hostname,
          publishedAt: rawDate ? isoDate(rawDate) : undefined,
          category: "report",
        });
    } catch {
      /* External arbitrary URLs are not followed. */
    }
  });
  return {
    instrument: productInstrument,
    observation,
    history: [],
    exposures,
    documents,
    errors,
    fetchedAt,
  };
}

export async function fetchProduct(
  instrument: Instrument,
): Promise<ProductData> {
  if(instrument.kind==='stock'||(instrument.kind==='etf'&&instrument.market!=='CN')) {
    const [quote,historical]=await Promise.allSettled([fetchQuote(instrument),priceHistory(instrument,url=>publicDataClient.read(url,{ttlMs:3_600_000}))]);
    return {instrument,observation:quote.status==='fulfilled'?quote.value:undefined,history:historical.status==='fulfilled'?historical.value.history:[],historyKind:'trade',historySourceUrl:historical.status==='fulfilled'?historical.value.sourceUrl:undefined,exposures:[],documents:[],errors:[quote,historical].filter(r=>r.status==='rejected').map(r=>String((r as PromiseRejectedResult).reason?.message??'来源不可用')),fetchedAt:new Date().toISOString()};
  }
  const url = fundProductUrl(instrument.code);
  const fetchedAt = new Date().toISOString();
  const [page] = await Promise.allSettled([
    publicDataClient.read(url, { ttlMs: 300_000 }),
  ]);
  const [history] = await Promise.allSettled([
    fetchFundHistory(
      instrument.code,
      page.status === "fulfilled" ? page.value.body : undefined,
    ),
  ]);
  let product: ProductData;
  try {
    if (page.status === "rejected") throw page.reason;
    product = parseProductHtml(page.value.body, instrument, url, fetchedAt);
  } catch (error) {
    product = {
      instrument,
      history: [],
      exposures: [],
      documents: [
        {
          id: `product-${instrument.code}`,
          title: `${instrument.name} · 资料入口`,
          url,
          source: "易方达财富",
          category: "product",
        },
      ],
      errors: [error instanceof Error ? error.message : "产品解析失败"],
      fetchedAt,
    };
  }
  if (history.status === "fulfilled") product.history = history.value;
  else
    product.errors.push(
      `历史净值：${history.reason instanceof Error ? history.reason.message : "读取失败"}`,
    );
  if (!product.observation || !product.history.length) {
    try {
      const url = `https://fund.eastmoney.com/pingzhongdata/${instrument.code}.js`;
      const { body } = await publicDataClient.read(url, { ttlMs: 3_600_000 });
      const fallback = parseEastmoneyFundData(body, instrument, fetchedAt);
      if (!product.observation) product.observation = fallback.observation;
      if (!product.history.length) product.history = fallback.history;
      product.documents.push({
        id: `fallback-${instrument.code}`,
        title: `${fallback.name} · 备用净值来源`,
        url: `https://fund.eastmoney.com/${instrument.code}.html`,
        source: "东方财富",
        category: "product",
      });
      if (!product.instrument.manager) {
        try {
          const metadataUrl = `https://fund.eastmoney.com/${instrument.code}.html`;
          const metadata = await publicDataClient.read(metadataUrl, {
            ttlMs: 86_400_000,
          });
          const manager = parseEastmoneyFundManager(
            metadata.body,
            instrument.code,
          );
          if (manager) {
            product.instrument.manager = manager.manager;
            product.documents.push({
              id: `fallback-manager-${instrument.code}`,
              title: `${manager.manager} · 管理人资料`,
              url: manager.url,
              source: "东方财富",
              category: "product",
            });
          }
        } catch (error) {
          product.errors.push(
            `备用管理人资料：${error instanceof Error ? error.message : "读取失败"}`,
          );
        }
      }
    } catch (error) {
      product.errors.push(
        `备用净值来源：${error instanceof Error ? error.message : "读取失败"}`,
      );
    }
  }
  product.historyKind="nav";
  const latest = product.history.at(-1);
  if (
    product.observation &&
    latest &&
    latest.date === product.observation.asOf &&
    !new Decimal(latest.nav).equals(product.observation.price)
  ) {
    product.observation.quality = "conflict";
    product.errors.push("产品页与历史序列同日净值不一致，暂停将其用于决策");
  }
  // A source page failure does not authorize constructing current NAV from an old history file.
  if (instrument.kind === "etf") {
    try {
      product.observation = await fetchQuote(instrument);
    } catch (error) {
      product.observation = undefined;
      product.errors.push(
        `场内价格：${error instanceof Error ? error.message : "不可用"}；正式净值历史不能替代成交价`,
      );
    }
    product.instrument.kind = "etf";
  }
  return product;
}

let quotePermissions = { tencent: true, eastmoney: true };
export function configureProviderSources(
  options: Partial<typeof quotePermissions>,
): void {
  quotePermissions = { ...quotePermissions, ...options };
}
export function providerSourceStatus(): typeof quotePermissions {
  return { ...quotePermissions };
}
function quoteSymbol(instrument: Instrument): string {
  if (instrument.market === "HK" && /^\d{4,5}$/.test(instrument.code))
    return `hk${instrument.code.padStart(5, "0")}`;
  if (
    instrument.market === "US" &&
    /^[A-Z][A-Z0-9.\-]{0,14}$/.test(instrument.code)
  )
    return `us${instrument.code}`;
  if (
    instrument.market === "CN" &&
    /^(?:(?:sh|sz|bj))?\d{6}$/.test(instrument.code)
  ) {
    if (/^(sh|sz|bj)/.test(instrument.code)) return instrument.code;
    return `${/^[569]/.test(instrument.code) ? "sh" : /^[48]/.test(instrument.code) ? "bj" : "sz"}${instrument.code}`;
  }
  throw new ProviderError(
    "quote_market",
    "此市场或证券代码尚无已启用的行情适配器",
  );
}
function zonedTimestamp(value: string, market: Instrument["market"]): string {
  const digits = value.replace(/[-/ :]/g, "");
  if (!/^\d{14}$/.test(digits))
    throw new ProviderError("quote_time", "行情没有可解析的交易所时间戳");
  const date = isoDate(digits.slice(0, 8));
  const hh = Number(digits.slice(8, 10)),
    mm = Number(digits.slice(10, 12)),
    ss = Number(digits.slice(12));
  if (hh > 23 || mm > 59 || ss > 59)
    throw new ProviderError("quote_time", "行情时间戳无效");
  const wall = `${date}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12)}`;
  if (market !== "US") return new Date(`${wall}+08:00`).toISOString();
  // Tencent US timestamps are market-local; resolve daylight savings with the IANA zone.
  const target = Date.parse(`${wall}Z`);
  let result = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 3; iteration++) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(result))
        .map((part) => [part.type, part.value]),
    );
    const represented = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    result += target - represented;
  }
  return new Date(result).toISOString();
}
export function parseTencentQuote(
  body: string,
  instrument: Instrument,
  fetchedAt = new Date().toISOString(),
): MarketObservation {
  const symbol = quoteSymbol(instrument);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*v_${escaped}="([^"\\r\\n]*)";?\\s*$`).exec(
    body,
  );
  if (!match)
    throw new ProviderError("quote_format", "腾讯行情标识不匹配或响应格式变化");
  const values = match[1].split("~");
  if (values.length < 33)
    throw new ProviderError("quote_format", "腾讯行情字段不足");
  const expectedCode = symbol.slice(2);
  const matchesCode =
    values[2] === expectedCode ||
    (instrument.market === "US" &&
      [`${expectedCode}.OQ`, `${expectedCode}.N`].includes(values[2]));
  if (!matchesCode)
    throw new ProviderError(
      "quote_identity",
      "腾讯行情正文字段的证券代码不匹配",
    );
  if (instrument.market === "US" && values[35] !== instrument.currency)
    throw new ProviderError("quote_currency", "美股行情币种不匹配");
  const asOf = zonedTimestamp(values[30], instrument.market);
  if (Date.parse(asOf) > Date.parse(fetchedAt) + 300_000)
    throw new ProviderError("quote_future", "行情时间在未来");
  const age = Math.max(
    0,
    Math.floor((Date.parse(fetchedAt) - Date.parse(asOf)) / 1000),
  );
  return {
    code: instrument.code,
    price: decimal(values[3], true),
    changePct: decimal(values[32]),
    asOf,
    fetchedAt,
    currency: instrument.currency,
    priceKind: "trade",
    source: "腾讯财经公开行情（源延迟未知，未校验实时性）",
    sourceUrl: `https://qt.gtimg.cn/q=${symbol}`,
    quality: age > 900 ? "stale" : "unverified",
  };
}
export function parseEastmoneyQuote(
  input: unknown,
  instrument: Instrument,
  fetchedAt = new Date().toISOString(),
): MarketObservation {
  const envelope = input as { data?: Record<string, unknown> };
  const data = envelope?.data;
  if (!data || String(data.f57) !== instrument.code.replace(/^(sh|sz|bj)/, ""))
    throw new ProviderError("quote_identity", "东财行情代码不匹配");
  const precision = Number(data.f59);
  const raw = data.f43;
  const timestamp = Number(data.f124);
  if (
    typeof data.f59 !== "number" ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 8 ||
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    typeof data.f124 !== "number" ||
    !Number.isInteger(timestamp) ||
    timestamp < 1_000_000_000
  )
    throw new ProviderError("quote_format", "东财价格精度或时间戳缺失");
  const asOf = new Date(timestamp * 1000).toISOString();
  if (Date.parse(asOf) > Date.parse(fetchedAt) + 300_000)
    throw new ProviderError("quote_future", "行情时间在未来");
  const price = decimal(
    new Decimal(raw).div(new Decimal(10).pow(precision)).toFixed(),
    true,
  );
  const age = Math.max(
    0,
    Math.floor((Date.parse(fetchedAt) - Date.parse(asOf)) / 1000),
  );
  return {
    code: instrument.code,
    price,
    changePct:
      typeof data.f170 === "number"
        ? new Decimal(data.f170).div(100).toFixed()
        : undefined,
    asOf,
    fetchedAt,
    currency: instrument.currency,
    priceKind: "trade",
    source: "东方财富公开行情（源延迟未知，未校验实时性）",
    sourceUrl: "https://push2.eastmoney.com/api/qt/stock/get",
    quality: age > 900 ? "stale" : "unverified",
  };
}
export async function fetchQuote(
  instrument: Instrument,
): Promise<MarketObservation> {
  if (!["stock", "etf"].includes(instrument.kind)) {
    const product = await fetchProduct(instrument);
    if (!product.observation)
      throw new ProviderError("nav_missing", product.errors.join("；"));
    return product.observation;
  }
  if (!quotePermissions.tencent && !quotePermissions.eastmoney)
    throw new ProviderError(
      "source_not_enabled",
      "行情来源已关闭；当前数据不足",
    );
  const failures: string[] = [];
  if (quotePermissions.tencent) {
    try {
      const url = `https://qt.gtimg.cn/q=${quoteSymbol(instrument)}`;
      const { body } = await publicDataClient.read(url, {
        ttlMs: 55_000,
        encoding: "gb18030",
      });
      return parseTencentQuote(body, instrument);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "腾讯行情失败");
    }
  }
  if (quotePermissions.eastmoney && instrument.market === "CN") {
    try {
      const symbol = quoteSymbol(instrument);
      const secid = `${symbol.startsWith("sh") ? 1 : 0}.${symbol.slice(2)}`;
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f58,f59,f124,f170`;
      const { body } = await publicDataClient.read(url, { ttlMs: 55_000 });
      return parseEastmoneyQuote(JSON.parse(body), instrument);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "东财行情失败");
    }
  }
  throw new ProviderError(
    "quote_unavailable",
    failures.join("；") || "该市场没有启用的数据源",
  );
}

export async function parsePdfReport(
  bytes: Uint8Array,
): Promise<{ text: string; pages: number }> {
  if (bytes.length > 15_000_000)
    throw new ProviderError("too_large", "PDF 超过 15 MB 限制");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
  });
  try {
    const document = await task.promise;
    if (document.numPages > 180)
      throw new ProviderError(
        "pdf_pages",
        "PDF 超过 180 页，须选取相关页面后再导入",
      );
    const texts: string[] = [];
    let count = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
        )
        .join("");
      texts.push(text);
      count += text.length;
      page.cleanup();
      if (count > 600_000)
        throw new ProviderError("pdf_text", "PDF 文本过长，停止解析");
    }
    if (!texts.join("").trim())
      throw new ProviderError(
        "pdf_no_text",
        "此 PDF 没有可读取的文本层，需人工核对或本地 OCR",
      );
    return { text: texts.join("\n\n"), pages: document.numPages };
  } finally {
    await task.destroy();
  }
}

export async function fetchPublicReport(
  url: string,
): Promise<{
  text: string;
  contentType: string;
  url: string;
  pages?: number;
  reportDate?: string;
  publishedAt?: string;
}> {
  validatePublicUrl(url, "report");
  const { body, contentType, bytes } = await publicDataClient.read(url, {
    purpose: "report",
    ttlMs: 86_400_000,
    maxBytes: 15_000_000,
  });
  let text: string;
  let pages: number | undefined;
  if (
    /pdf/i.test(contentType) ||
    new TextDecoder().decode(bytes.slice(0, 4)) === "%PDF"
  )
    ({ text, pages } = await parsePdfReport(bytes));
  else {
    const $ = load(body);
    $("script,style,noscript").remove();
    text = clean($.root().text());
  }
  const dateValue = (match: RegExpExecArray | null): string | undefined =>
    match
      ? isoDate(
          `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`,
        )
      : undefined;
  const publishedAt = dateValue(
    /(?:报告送出日期|送出日期|公告日期)\s*[:：]?\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(
      text,
    ),
  );
  const reportDate = dateValue(
    /(?:报告期末|报告截止日|截至)\s*[:：]?\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(
      text,
    ),
  );
  return { text, contentType, url, pages, reportDate, publishedAt };
}
