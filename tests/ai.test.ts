import { describe, expect, it, vi } from "vitest";
import { AiService, SOURCE_BOUNDARY } from "../src/server/ai.js";
import type { BudgetStore, Reservation } from "../src/server/budget.js";
import type {
  AppSettings,
  DecisionResult,
  PortfolioSnapshot,
  ProductData,
} from "../src/shared/types.js";

class MemoryStore implements BudgetStore {
  values = new Map<string, unknown>();
  get<T>(ns: string, key: string): T | undefined {
    return structuredClone(this.values.get(ns + ":" + key)) as T | undefined;
  }
  put(ns: string, key: string, value: unknown) {
    this.values.set(ns + ":" + key, structuredClone(value));
  }
  list<T>(ns: string): T[] {
    return [...this.values]
      .filter(([key]) => key.startsWith(ns + ":"))
      .map(([, v]) => structuredClone(v) as T);
  }
  atomic<T>(fn: () => T): T {
    const before = new Map(this.values);
    try {
      return fn();
    } catch (e) {
      this.values = before;
      throw e;
    }
  }
}
const now = () => new Date("2026-11-01T02:00:00Z");
const risk = {
  configured: true,
  minimumCash: "1000",
  singleTradeLimit: "200",
  maxPositionPct: "20",
};
const settings: AppSettings = {
  model: "gpt-6-luna",
  reasoning: "low",
  apiEnabled: true,
  monthlyLimit: "90",
  creditAmount: "90",
  creditStartsAt: "2026-10-20T00:00:00+08:00",
  creditExpiresAt: "2026-11-20T00:00:00+08:00",
  creditConfirmed: true,
  monitoring: false,
  risk,
  theme: "dark",
  allowedRead: true,
  allowedWrite: true,
  holidays: {},
  calendarVerifiedThrough: {},
  fxRates: {},
  fxAsOf: "",
};
const snapshot: PortfolioSnapshot = {
  id: "snapshot-one",
  createdAt: now().toISOString(),
  revision: 1,
  positions: [],
  cash: { CNY: "5000" },
  frozen: {},
  receivables: {},
  totalValue: "5000",
  investedCost: "0",
  realizedPnl: "0",
  unrealizedPnl: "0",
  income: "0",
  fees: "0",
  externalFlows: "5000",
  totalPnl: "0",
  reconciliation: "0",
  warnings: [],
  risk,
};
const product: ProductData = {
  instrument: {
    code: "017641",
    name: "Example",
    kind: "qdii",
    currency: "CNY",
    market: "CN",
  },
  observation: {
    code: "017641",
    price: "1.5",
    asOf: "2026-10-29",
    fetchedAt: now().toISOString(),
    currency: "CNY",
    priceKind: "nav",
    source: "issuer",
    sourceUrl: "https://example.com",
    quality: "valid",
  },
  history: Array.from({ length: 20 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    nav: "1.5",
  })),
  exposures: [],
  documents: [],
  errors: [],
  fetchedAt: now().toISOString(),
};
const usage = {
  input_tokens: 100,
  output_tokens: 10,
  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
};
const decisionBody = () => ({
  model: "gpt-6-luna",
  usage,
  answers: [
    {
      type: "choice",
      name: "action",
      choice: "Buy",
      confidence: 0.95,
      probabilities: [
        { value: "Buy", probability: 0.91 },
        { value: "Sell", probability: 0.02 },
        { value: "Hold", probability: 0.07 },
      ],
    },
    {
      type: "score",
      name: "quality",
      score: 9,
      confidence: 0.9,
      probabilities: [],
    },
  ],
});
const responseBody = (text: string) => ({
  model: "gpt-6-luna",
  status: "completed",
  usage,
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
});
function fixture(reply: unknown = decisionBody()) {
  const store = new MemoryStore();
  const fetch = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).endsWith("/models")
            ? {
                data: [
                  { id: "gpt-6-luna" },
                  { id: "gpt-6-astra" },
                  { id: "future-model" },
                ],
              }
            : reply,
        ),
        { status: 200 },
      ),
  ) as unknown as typeof globalThis.fetch;
  const service = new AiService(store, {
    fetch,
    keyProvider: () => "injected-fixture-only",
    now,
  });
  return { store, fetch: vi.mocked(fetch), service };
}
const decision = {
  code: product.instrument.code,
  snapshotId: snapshot.id,
  asOf: "2026-10-29",
  generatedAt: now().toISOString(),
  buy: 0.95,
  sell: 0.01,
  hold: 0.04,
  confidence: 0.95,
  score: 8,
  status: "valid",
  model: "gpt-6-luna",
  promptVersion: 1,
} satisfies DecisionResult;

describe("OpenAI adapters (mock transport only)", () => {
  it("keeps the approved current-session decision horizon and scoring weights", () => {
    const { service } = fixture();
    const text = service.prompts().find((p) => p.name === "decisions")!.text;
    expect(text).toContain("当前交易日内可执行窗口");
    expect(text).toContain(
      "质量25%、风险回撤25%、流动成本20%、估值15%、组合适配15%",
    );
    expect(text).not.toMatch(/未来30|30个交易日/);
  });
  it("uses official Decisions choice/score schemas and returns five validated values", async () => {
    const { service, fetch } = fixture();
    const result = await service.decide(snapshot, product, settings);
    expect(result).toMatchObject({
      buy: 0.91,
      sell: 0.02,
      hold: 0.07,
      confidence: 0.95,
      score: 10,
      status: "valid",
    });
    const request = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(request.questions[0].choices).toEqual(
      expect.arrayContaining([
        { value: "Buy", description: expect.any(String) },
      ]),
    );
    expect(request.questions[1].levels).toHaveLength(10);
    expect(request).not.toHaveProperty("reasoning");
    expect(request).not.toHaveProperty("max_output_tokens");
    expect(Number(service.budget(settings).spent)).toBeGreaterThan(0);
    expect(service.budget(settings).reserved).toBe("0.000000");
  });
  it("never calls paid endpoints when disabled, credit unconfirmed, permissions denied or evidence missing", async () => {
    for (const patch of [
      { apiEnabled: false },
      { creditConfirmed: false },
      { allowedRead: false },
      { creditExpiresAt: "2026-10-31" },
    ]) {
      const { service, fetch } = fixture();
      expect(
        (await service.decide(snapshot, product, { ...settings, ...patch }))
          .status,
      ).toBe("error");
      expect(fetch).not.toHaveBeenCalled();
    }
    const { service, fetch } = fixture();
    expect(
      (await service.decide(snapshot, { ...product, history: [] }, settings))
        .status,
    ).toBe("insufficient");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("allows product research without confirmed risk but blocks personalized amount analysis", async () => {
    const { service } = fixture();
    const unconfigured = { ...snapshot, risk: { ...risk, configured: false } };
    expect((await service.decide(unconfigured, product, settings)).status).toBe(
      "valid",
    );
    await expect(
      service.evaluateAmounts(
        unconfigured,
        decision,
        [{ amount: "10" }, { amount: "20" }, { amount: "30" }],
        settings,
      ),
    ).rejects.toThrow();
  });
  it("handles partial refusal and rejects malformed/NaN or non-normalized probabilities", async () => {
    const body = decisionBody();
    body.answers[1] = { type: "refusal", name: "quality" } as never;
    expect(
      (await fixture(body).service.decide(snapshot, product, settings)).status,
    ).toBe("refused");
    const malformed = decisionBody();
    malformed.answers[0].probabilities = [
      { value: "Buy", probability: 0.99 },
      { value: "Sell", probability: 0.99 },
      { value: "Hold", probability: 0.99 },
    ];
    expect(
      (await fixture(malformed).service.decide(snapshot, product, settings))
        .status,
    ).toBe("error");
  });
  it("retains ambiguous reservations on network errors and never retries or leaks raw errors", async () => {
    const { service, store, fetch } = fixture();
    fetch.mockImplementation(async (url) => {
      if (String(url).endsWith("/models"))
        return new Response(JSON.stringify({ data: [{ id: "gpt-6-luna" }] }));
      throw new TypeError("secret-authorization-do-not-echo", { cause: { code: "ECONNRESET" } });
    });
    const result = await service.decide(snapshot, product, settings);
    expect(result.reason).not.toContain("secret-authorization");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.list<Reservation>("ai-budget")[0].status).toBe("ambiguous");
    expect(store.list("ai-audit")[0]).toMatchObject({ failurePhase: "transport", transportCode: "ECONNRESET", errorName: "TypeError" });
    expect(JSON.stringify(store.list("ai-audit"))).not.toContain("secret-authorization");
    expect(
      Number(
        new AiService(store, {
          fetch,
          keyProvider: () => "fixture",
          now,
        }).budget(settings).reserved,
      ),
    ).toBeGreaterThan(0);
  });
  it("distinguishes safe HTTP, malformed JSON and usage errors without storing provider error bodies", async () => {
    for (const [reply, phase, status] of [
      [() => new Response('secret-upstream-body', { status: 503 }), 'http', 503],
      [() => new Response('{invalid-json'), 'response_json', 200],
      [() => new Response(JSON.stringify({ status: 'completed' })), 'missing_usage', 200],
      [() => new Response(JSON.stringify({ usage: { input_tokens: -1, output_tokens: 0 } })), 'usage_validation', 200],
    ] as const) {
      const { service, fetch, store } = fixture();
      fetch.mockImplementation(async url => String(url).endsWith('/models') ? new Response(JSON.stringify({ data: [{ id: 'gpt-6-luna' }] })) : reply());
      expect((await service.decide(snapshot, product, settings)).status).toBe('error');
      expect(store.list('ai-audit')[0]).toMatchObject({ failurePhase: phase, httpStatus: status });
      expect(JSON.stringify(store.list('ai-audit'))).not.toContain('secret-upstream-body');
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });
  it("reports only supported model capabilities and never guesses unknown pricing", async () => {
    const { service, fetch } = fixture();
    expect(await service.models()).toContainEqual({
      id: "future-model",
      supported: false,
      reasoningEfforts: [],
      priceVerifiedAt: "2026-11-01",
    });
    expect(
      (
        await service.brief(snapshot, [], {
          ...settings,
          model: "future-model",
        })
      ).status,
    ).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (
        await service.brief(snapshot, [], {
          ...settings,
          model: "gpt-6-astra",
          reasoning: "none",
        })
      ).status,
    ).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("versions editable prompts, discloses the boundary and never reads long term memory", async () => {
    const { service, store, fetch } = fixture(responseBody("简报"));
    store.put("memories", "forbidden", { text: "DO_NOT_SEND_THIS" });
    expect(service.savePrompt("brief", "自定义简报").version).toBe(2);
    expect(store.list("prompt-history")).toHaveLength(2);
    expect(service.prompts()[0].text).toBe(SOURCE_BOUNDARY);
    expect(() => service.savePrompt("boundary", "override")).toThrow();
    await service.brief(snapshot, [], settings);
    const sent = String(fetch.mock.calls[1][1]?.body);
    expect(sent).toContain("自定义简报");
    expect(sent).not.toContain("DO_NOT_SEND_THIS");
    expect(JSON.parse(sent).store).toBe(false);
  });
  it("only executes a validated recording tool in record mode and never arbitrary tools", async () => {
    const args = {
      kind: "buy",
      code: "017641",
      account: "CMB",
      currency: "CNY",
      date: "2026-10-30",
      amount: "100",
      quantity: "50",
      fee: "0",
      parentId: null,
      toCurrency: null,
      toAmount: null,
      note: null,
    };
    const body = {
      ...responseBody(""),
      output: [
        {
          type: "function_call",
          name: "record_transaction",
          arguments: JSON.stringify(args),
          call_id: "call-1",
        },
      ],
    };
    const record = vi.fn(() => ({ id: "receipt" }));
    await expect(
      fixture(body).service.chat(
        snapshot,
        "已购买017641，金额100，份额50",
        [],
        settings,
        "analysis",
        record,
      ),
    ).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
    const { service } = fixture(body);
    const result = await service.chat(
      snapshot,
      "已购买017641，金额100，份额50",
      [],
      settings,
      "record",
      record,
    );
    expect(result.receipts).toEqual([{ id: "receipt" }]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      amount: "100",
      quantity: "50",
      idempotencyKey: expect.stringMatching(/^ai:/),
    });
    await expect(
      fixture(body).service.chat(
        snapshot,
        "我想了解股票",
        [],
        settings,
        "record",
        record,
      ),
    ).rejects.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
  });
  it("never executes ledger changes from incomplete output", async () => {
    const body = {
      ...responseBody(""),
      status: "incomplete",
      output: [
        { type: "function_call", name: "record_transaction", arguments: "{}" },
      ],
    };
    const record = vi.fn();
    await expect(
      fixture(body).service.chat(
        snapshot,
        "记录买入100",
        [],
        settings,
        "record",
        record,
      ),
    ).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
  });
  it("requires strictly over .9 for review and validates structured confidence", async () => {
    const { service, fetch } = fixture(
      responseBody(
        JSON.stringify({
          confidence: 0.91,
          eligible: true,
          summary: "需要人工复核",
        }),
      ),
    );
    expect(
      (
        await service.review(
          snapshot,
          { ...decision, buy: 0.9 },
          product,
          settings,
        )
      ).eligible,
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (await service.review(snapshot, decision, product, settings)).confidence,
    ).toBe(0.91);
    await expect(
      fixture(
        responseBody('{"confidence":1.1,"eligible":true,"summary":"x"}'),
      ).service.review(snapshot, decision, product, settings),
    ).rejects.toThrow();
  });
  it("returns only original amount candidates and rejects invented amounts or duplicate indices", async () => {
    const candidates = [
      { amount: "10", percentage: "10" },
      { amount: "20", percentage: "20" },
      { amount: "30", percentage: "30" },
    ];
    const ratings = {
      candidates: [2, 0, 1].map((index) => ({
        index,
        score: 8 - index,
        urgency: 2,
        reason: "测试",
      })),
    };
    const result = await fixture(
      responseBody(JSON.stringify(ratings)),
    ).service.evaluateAmounts(snapshot, decision, candidates, settings);
    expect(result.map((r) => r.amount)).toEqual(["10", "20", "30"]);
    expect(result.map((r) => r.percentage)).toEqual(["10", "20", "30"]);
    const invalid = {
      candidates: ratings.candidates.map((r) => ({ ...r, amount: "999" })),
    };
    await expect(
      fixture(responseBody(JSON.stringify(invalid))).service.evaluateAmounts(
        snapshot,
        decision,
        candidates,
        settings,
      ),
    ).rejects.toThrow();
  });
  it("supports one feasible lot while preserving deterministic account and fee information", async () => {
    const candidates = [
      {
        amount: "100",
        account: "CMB",
        currency: "CNY" as const,
        estimatedFee: "1.50",
        cashRequired: "101.50",
      },
    ];
    const ratings = {
      candidates: [
        { index: 0, score: 6, urgency: 2, reason: "仅一档符合交易单位" },
      ],
    };
    const result = await fixture(
      responseBody(JSON.stringify(ratings)),
    ).service.evaluateAmounts(snapshot, decision, candidates, settings);
    expect(result).toEqual([
      { ...candidates[0], score: 6, urgency: 2, reason: "仅一档符合交易单位" },
    ]);
  });
});
