import { describe, expect, it, vi } from "vitest";
import {
  fundHistoryUrls,
  mergeFundHistories,
  parseCsrcNav,
  parseEastmoneyFundData,
  parseEastmoneyFundManager,
  parseEastmoneyQuote,
  parseFundCatalog,
  parseFundHistory,
  parsePdfReport,
  parseProductHtml,
  parseTencentQuote,
  PublicDataClient,
  REFERENCE_INSTRUMENTS,
  validatePublicUrl,
} from "../src/server/providers.js";
import type { Instrument } from "../src/shared/types.js";

const instrument = REFERENCE_INSTRUMENTS[2];
const page = (
  code = "161815",
  nav = "1.1470",
) => `<html><script>window.evil = true</script>
  <div>${nav} 单位净值(元) -0.78% 日涨跌 ${nav} 累计净值(元) 基金净值日期：2026-10-29</div>
  <table><tr><td>基金代码:</td><td>${code}</td></tr><tr><td>基金简称:</td><td>银华抗通胀主题(QDII-FOF-LOF)A</td></tr><tr><td>基金管理人:</td><td>银华基金管理股份有限公司</td></tr><tr><td>资产净值:</td><td>数据截至2026-09-30：844,980,076.76元</td></tr></table>
  <table><tr><th>资产类型</th><th>金额（元）</th><th>占基金总资产的比例</th></tr><tr><td>基金投资</td><td>763491996.77</td><td>88.34%</td></tr><tr><td>合计</td><td>864266290.17</td><td>100.00%</td></tr></table>
  <table><tr><th>序号</th><th>基金名称</th><th>基金代码</th><th>投资价值(元)</th><th>占基金资产净值比例</th></tr><tr><td>1</td><td>Gold ETF</td><td></td><td>90,749,653.37</td><td>10.74%</td></tr><tr><td>2</td><td>SPDR Gold</td><td>GLD</td><td>4,360,492.32</td><td>0.52%</td></tr></table>
  <a href="http://127.0.0.1/private.pdf">季度报告</a><a href="https://static.cninfo.com.cn/finalpage/report.pdf">季度报告原文</a></html>`;

describe("inert source parsers", () => {
  it("reads the catalog without executing JavaScript", () => {
    const rows = parseFundCatalog(
      'var r = [["000216","HAHJ","华安黄金ETF联接A","指数型-其他","HUANGJIN"],["017641","MGBP","摩根标普500指数(QDII)人民币A","QDII","MORGEN"]];',
    );
    expect(rows[0].kind).toBe("fund");
    expect(rows[1].kind).toBe("qdii");
    expect(rows[0].purchasable).toBeUndefined();
    expect(rows[0].watched).toBeUndefined();
    expect(() => parseFundCatalog("var r=[];globalThis.pwned=true")).toThrow();
    expect(() =>
      parseFundCatalog('var r=[["000001",(()=>1)(),"x","x"]]'),
    ).toThrow();
    expect(() => parseFundCatalog('var r=[["../a","A","x","x"]]')).toThrow();
  });
  it("merges archival and rolling history without losing the newest year", () => {
    const old = parseFundHistory(
      'mk_000216_all="0_1_2_3_4;20251230_1.1_2.1000_2.1000_0.10;20251231_1.2_2.2000_2.2000_0.20;"',
      "000216",
      "all",
    );
    const recent = parseFundHistory(
      'mk_000216_1y="0_1_2_3_4;20251231_1.2_2.2000_2.2000_0.20;20261030_1.3_2.3000_2.3000_0.30;"',
      "000216",
      "1y",
    );
    expect(mergeFundHistories(old, recent).map((x) => x.date)).toEqual([
      "2025-12-30",
      "2025-12-31",
      "2026-10-30",
    ]);
    expect(() =>
      parseFundHistory('mk_000216_all="0_1_2_3_4;20260230_1_2_2_0;"', "000216"),
    ).toThrow();
    expect(() =>
      parseFundHistory('mk_000217_all="0_1_2_3_4;20261030_1_2_2_0;"', "000216"),
    ).toThrow();
    expect(() =>
      parseFundHistory(
        'mk_000216_all="0_1_2_3_4;";fetch("/private")',
        "000216",
      ),
    ).toThrow();
  });
  it("selects only exact page-linked official history locations", () => {
    const html =
      '<script src="https://cdn.efunds.com.cn/market/2.0/000032_1y.js"></script><script src="https://cdn.efunds.com.cn/market/2.0/his/000032_all.js"></script><script src="https://127.0.0.1/000032_all.js"></script>';
    expect(fundHistoryUrls("000032", html).archive).toBe(
      "https://cdn.efunds.com.cn/market/2.0/his/000032_all.js",
    );
    expect(fundHistoryUrls("000216", html).archive).toContain("/wmfis/");
  });
  it("reads only known JSON fields from fallback NAV data and uses Shanghai dates", () => {
    const timestamp = Date.parse("2026-10-30T00:00:00+08:00");
    const script = `var fS_name="华安黄金ETF联接A";var fS_code="000216";var Data_netWorthTrend=[{"x":${timestamp},"y":2.9546,"equityReturn":-1.2,"unitMoney":""}];var Data_ACWorthTrend=[[${timestamp},2.9546]];`;
    expect(
      parseEastmoneyFundData(
        script,
        REFERENCE_INSTRUMENTS[0],
        "2026-11-01T00:00:00Z",
      ).observation,
    ).toMatchObject({
      asOf: "2026-10-30",
      price: "2.9546",
      accumulatedNav: "2.9546",
      quality: "unverified",
    });
    expect(() =>
      parseEastmoneyFundData(
        script.replace('"y":2.9546', '"y":(()=>3)()'),
        REFERENCE_INSTRUMENTS[0],
      ),
    ).toThrow();
    expect(() =>
      parseEastmoneyFundData(
        script.replace('var fS_code="000216"', 'var fS_code="000217"'),
        REFERENCE_INSTRUMENTS[0],
      ),
    ).toThrow();
  });
  it("uses explicit product company metadata and rejects a different product page", () => {
    const html =
      '<title>招商安润(000126)基金净值</title><a href="http://fund.eastmoney.com/company/80036782.html">招商基金</a>';
    expect(parseEastmoneyFundManager(html, "000126")).toEqual({
      manager: "招商基金",
      url: "https://fund.eastmoney.com/company/80036782.html",
    });
    expect(() => parseEastmoneyFundManager(html, "000125")).toThrow();
  });
  it("compares the regulator share NAV on the requested date without treating yield as NAV", () => {
    const input = {
      aaData: [
        {
          code: "000216",
          valuationDate: "2026-10-30",
          shareNetValue: "",
          gainPer: "1.23",
        },
        {
          code: "000216",
          shortName: "华安黄金ETF联接A",
          valuationDate: "2026-10-30",
          shareNetValue: "2.9546",
          totalNetValue: "2.9546",
        },
      ],
    };
    expect(parseCsrcNav(input, "000216", "2026-10-30").nav).toBe("2.9546");
    expect(() => parseCsrcNav(input, "000216", "2026-10-29")).toThrow();
    expect(() =>
      parseCsrcNav({ aaData: [input.aaData[0]] }, "000216", "2026-10-30"),
    ).toThrow();
    expect(() =>
      parseCsrcNav(
        {
          aaData: [
            ...input.aaData,
            { ...input.aaData[1], shareNetValue: "2.9547" },
          ],
        },
        "000216",
        "2026-10-30",
      ),
    ).toThrow();
  });
  it("preserves report dates, denominators and unresolved identifiers", () => {
    const data = parseProductHtml(
      page(),
      instrument,
      undefined,
      "2026-11-01T00:00:00Z",
    );
    expect(data.observation).toMatchObject({
      price: "1.147",
      asOf: "2026-10-29",
      fetchedAt: "2026-11-01T00:00:00Z",
      quality: "valid",
      priceKind: "nav",
    });
    expect(data.exposures).toHaveLength(3);
    expect(data.exposures[0]).toMatchObject({
      weight: "88.34",
      basis: "total_assets",
      kind: "asset_class",
    });
    expect(data.exposures[1]).toMatchObject({
      weight: "10.74",
      basis: "net_assets",
      reportDate: "2026-09-30",
    });
    expect(data.exposures[1].code).toBeUndefined();
    expect(data.documents.some((x) => x.url.includes("127.0.0.1"))).toBe(false);
  });
  it("rejects wrong share classes and placeholders rather than manufacturing NAV", () => {
    expect(() => parseProductHtml(page("021694"), instrument)).toThrow(
      "代码不匹配",
    );
    const empty = parseProductHtml(
      page("161815", "0.0000"),
      instrument,
      undefined,
      "2026-11-01T00:00:00Z",
    );
    expect(empty.observation).toBeUndefined();
    expect(empty.errors.length).toBeGreaterThan(0);
    expect(
      parseProductHtml(page(), instrument, undefined, "2026-12-01T00:00:00Z")
        .observation?.quality,
    ).toBe("stale");
  });
});

describe("market quotes", () => {
  const stock: Instrument = {
    code: "600000",
    name: "Sample",
    kind: "stock",
    market: "CN",
    currency: "CNY",
  };
  it("uses source precision and source time, and keeps unverified feed delay explicit", () => {
    const stamp = Date.parse("2026-10-30T06:30:00Z") / 1000;
    const quote = parseEastmoneyQuote(
      { data: { f57: "600000", f43: 12345, f59: 3, f124: stamp, f170: -123 } },
      stock,
      "2026-10-30T06:30:05Z",
    );
    expect(quote.price).toBe("12.345");
    expect(quote.changePct).toBe("-1.23");
    expect(quote.asOf).toBe("2026-10-30T06:30:00.000Z");
    expect(quote.quality).toBe("unverified");
    expect(quote.delaySeconds).toBeUndefined();
    expect(() =>
      parseEastmoneyQuote(
        { data: { f57: "600001", f43: 12345, f59: 3, f124: stamp } },
        stock,
      ),
    ).toThrow();
  });
  it("validates Tencent identity, timestamp, stale price and appended code", () => {
    const fields = Array.from({ length: 33 }, () => "");
    fields[2] = "600000";
    fields[3] = "12.340";
    fields[30] = "20261030143000";
    fields[32] = "-1.25";
    const raw = `v_sh600000="${fields.join("~")}";`;
    expect(parseTencentQuote(raw, stock, "2026-10-30T06:30:05Z")).toMatchObject(
      { price: "12.34", quality: "unverified" },
    );
    expect(parseTencentQuote(raw, stock, "2026-11-01T00:00:00Z").quality).toBe(
      "stale",
    );
    expect(() => parseTencentQuote(raw + "console.log(1)", stock)).toThrow();
  });
  it("handles observed HK slashed dates and US exchange suffixes with New York DST", () => {
    const fields = Array.from({ length: 36 }, () => "");
    fields[2] = "00700";
    fields[3] = "383.600";
    fields[30] = "2026/10/30 16:08:14";
    fields[32] = "1.59";
    const hk: Instrument = {
      code: "00700",
      name: "Tencent",
      kind: "stock",
      market: "HK",
      currency: "HKD",
    };
    expect(
      parseTencentQuote(
        `v_hk00700="${fields.join("~")}";`,
        hk,
        "2026-10-30T08:10:00Z",
      ).asOf,
    ).toBe("2026-10-30T08:08:14.000Z");
    fields[2] = "AAPL.OQ";
    fields[3] = "344.63";
    fields[30] = "2026-10-30 16:00:02";
    fields[32] = "-1.23";
    fields[35] = "USD";
    const us: Instrument = {
      code: "AAPL",
      name: "Apple",
      kind: "stock",
      market: "US",
      currency: "USD",
    };
    expect(
      parseTencentQuote(
        `v_usAAPL="${fields.join("~")}";`,
        us,
        "2026-10-30T20:01:00Z",
      ).asOf,
    ).toBe("2026-10-30T20:00:02.000Z");
  });
});

describe("read-only PDF extraction", () => {
  it("extracts a bounded text-layer report without requiring a browser", async () => {
    const content =
      "BT /F1 12 Tf 30 100 Td (Fund report 2026-09-30 NAV 1.1470) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const start = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
      .join(
        "",
      )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    const parsed = await parsePdfReport(new TextEncoder().encode(pdf));
    expect(parsed.pages).toBe(1);
    expect(parsed.text).toContain("NAV 1.1470");
    await expect(
      parsePdfReport(new Uint8Array(15_000_001)),
    ).rejects.toMatchObject({ code: "too_large" });
  });
});

describe("safe public fetching", () => {
  it("refuses SSRF, credentials, custom ports and lookalike hosts", () => {
    for (const url of [
      "http://www.efundcf.com.cn/x",
      "https://127.0.0.1/x",
      "https://www.efundcf.com.cn.evil.test/x",
      "https://user:pass@www.efundcf.com.cn/x",
      "https://www.efundcf.com.cn:8080/x",
    ])
      expect(() => validatePublicUrl(url, "report")).toThrow();
    expect(
      validatePublicUrl(
        "https://static.cninfo.com.cn/finalpage/a.PDF",
        "report",
      ).hostname,
    ).toBe("static.cninfo.com.cn");
  });
  it("coalesces same requests, caches bodies and spaces host requests by at least one second", async () => {
    let now = 100_000;
    const starts: number[] = [];
    const transport = vi.fn(async () => {
      starts.push(now);
      return new Response("ok");
    });
    const client = new PublicDataClient(
      transport as typeof fetch,
      () => now,
      async (ms) => {
        now += ms;
      },
    );
    const [a, b] = await Promise.all([
      client.read("https://www.efundcf.com.cn/a"),
      client.read("https://www.efundcf.com.cn/a"),
    ]);
    expect(a.body).toBe("ok");
    expect(b.body).toBe("ok");
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(
      client.read("https://www.efundcf.com.cn/a", { maxBytes: 1 }),
    ).rejects.toMatchObject({ code: "too_large" });
    await client.read("https://www.efundcf.com.cn/a");
    await client.read("https://www.efundcf.com.cn/b");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
  });
  it("honors rate-limit backoff and never follows a redirect to a private endpoint", async () => {
    const limited = new PublicDataClient(
      vi.fn(
        async () =>
          new Response("", { status: 429, headers: { "retry-after": "600" } }),
      ) as typeof fetch,
    );
    await expect(
      limited.read("https://www.efundcf.com.cn/a"),
    ).rejects.toMatchObject({ code: "http_429" });
    await expect(
      limited.read("https://www.efundcf.com.cn/b"),
    ).rejects.toMatchObject({ code: "backoff" });
    const redirected = new PublicDataClient(
      vi.fn(
        async () =>
          new Response("", {
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
          }),
      ) as typeof fetch,
    );
    await expect(
      redirected.read("https://www.efundcf.com.cn/a"),
    ).rejects.toMatchObject({ code: "unsafe_url" });
  });
});
