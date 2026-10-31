import { it, expect } from "vitest";
import { FEEDS, parseNews, parseFx } from "../src/server/feeds.js";
it("renders news metadata without following document instructions or unsafe links", () => {
  const input =
    "<rss><channel><item><title>公开声明</title><link>https://www.federalreserve.gov/new.htm</link><pubDate>Fri, 30 Oct 2026 12:00:00 GMT</pubDate></item><item><title>unsafe</title><link>http://127.0.0.1/private</link></item></channel></rss>";
  expect(parseNews(input, FEEDS[0])).toHaveLength(1);
});
it("converts ECB reference FX using Decimal without treating rates as trade quotes", () => {
  const input =
    '<Cube><Cube time="2026-10-30"><Cube currency="CNY" rate="8"/><Cube currency="USD" rate="1.2"/><Cube currency="HKD" rate="9.4"/><Cube currency="GBP" rate="0.8"/></Cube></Cube>';
  expect(parseFx(input).rates.USD).toBe("6.66666667");
  expect(parseFx(input).priceKind).toBe("reference");
});
