import { load } from "cheerio";
import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { DocumentCard } from "../shared/types.js";
export const FEEDS = [
  {
    name: "美联储货币政策",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
  },
  { name: "欧洲央行公告", url: "https://www.ecb.europa.eu/rss/press.html" },
];
export const FX_SOURCE =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
async function xml(url: string) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: {
      "User-Agent": "Finance-Local/0.1 (personal research)",
      Accept: "application/xml, application/rss+xml, text/xml",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > 2_000_000)
    throw new Error("来源文件过大");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("来源响应为空");
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    n += result.value.length;
    if (n > 2_000_000) {
      await reader.cancel();
      throw new Error("来源文件过大");
    }
    chunks.push(result.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
export function parseNews(
  content: string,
  source: (typeof FEEDS)[number],
): DocumentCard[] {
  const $ = load(content, { xml: true }),
    out: DocumentCard[] = [];
  $("item,entry").each((_, element) => {
    if (out.length >= 12) return;
    const node = $(element),
      title = node.find("title").first().text().trim().slice(0, 300),
      url =
        node.find("link").first().attr("href") ??
        node.find("link").first().text().trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const host = new URL(source.url).hostname;
    if (parsed.protocol !== "https:" || parsed.hostname !== host || !title)
      return;
    const date = node
      .find("pubDate,published,updated,dc\\:date")
      .first()
      .text()
      .trim();
    const time = Date.parse(date);
    out.push({
      id: createHash("sha256").update(url).digest("hex").slice(0, 20),
      title,
      url,
      source: source.name + " · 宏观资料",
      publishedAt: Number.isFinite(time)
        ? new Date(time).toISOString()
        : undefined,
      category: "news",
    });
  });
  return out;
}
export async function fetchNews() {
  const documents: DocumentCard[] = [],
    errors: string[] = [];
  for (const source of FEEDS) {
    try {
      documents.push(...parseNews(await xml(source.url), source));
    } catch {
      errors.push(`${source.name}本次不可读取，保留上次资料及原发布日期`);
    }
  }
  return { documents, errors, fetchedAt: new Date().toISOString() };
}
export function parseFx(content: string) {
  const $ = load(content, { xml: true }),
    rates: Record<string, string> = { EUR: "1" };
  let date = "";
  $("Cube").each((_, node) => {
    const e = $(node);
    if (e.attr("time")) date = e.attr("time")!;
    const c = e.attr("currency"),
      r = e.attr("rate");
    if (c && r && /^\d+(\.\d+)?$/.test(r) && new Decimal(r).gt(0)) rates[c] = r;
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !rates.CNY)
    throw new Error("官方汇率结构无效");
  const cnyRates: Record<string, string> = { CNY: "1" };
  for (const currency of ["USD", "HKD", "GBP", "EUR"]) {
    if (!rates[currency]) throw new Error("缺少必要汇率");
    cnyRates[currency] = new Decimal(rates.CNY).div(rates[currency]).toFixed(8);
  }
  return {
    rates: cnyRates,
    asOf: date,
    sourceUrl: FX_SOURCE,
    priceKind: "reference" as const,
  };
}
export async function fetchFx() {
  return {
    ...parseFx(await xml(FX_SOURCE)),
    fetchedAt: new Date().toISOString(),
  };
}
