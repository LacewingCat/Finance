/** Explicitly authorized, isolated API contract probe. Default invocation never loads a key or calls a model. */
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseEnv } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AiService } from "../src/server/ai.js";
import { Store, dataDirectory } from "../src/server/store.js";
import { recordTransaction, d } from "../src/server/ledger.js";
import {
  fetchProduct,
  REFERENCE_INSTRUMENTS,
} from "../src/server/providers.js";
import { amountCandidates } from "../src/server/risk.js";
import type { Reservation } from "../src/server/budget.js";
import { ProbeBudgetStore } from "../src/server/probe-budget.js";
import { DEFAULT_SETTINGS } from "../src/server/config.js";
import type {
  AppSettings,
  PortfolioSnapshot,
  ProductData,
  TransactionInput,
  DecisionResult,
} from "../src/shared/types.js";

const DIRECTORY = "/private/tmp/finance-api-verification";
const DATABASE = join(DIRECTORY, "verification.sqlite");
const EVIDENCE = join(DIRECTORY, "expense-records.json");
const extendedStages = [
  ...REFERENCE_INSTRUMENTS.map((i) => `public-fund-${i.code}`),
  "default-sol-chat",
  "default-record-complete",
  "default-subscribe-unconfirmed",
  "default-record-incomplete",
  "review-structured",
  "amounts-structured",
  "default-record-complete-fixed",
  "default-subscribe-unconfirmed-fixed",
  "default-record-incomplete-fixed",
];
const allowedStages = [
  "brief",
  "decisions",
  "chat",
  "record",
  "decisions-contract",
  "record-contract",
  "decisions-contract-2",
  "record-contract-2",
  ...extendedStages,
];
type Stage = string;
const args = process.argv.slice(2);
const stageArg = args.find((a) => a.startsWith("--stage="))?.slice(8);
const limitArg =
  args.find((a) => a.startsWith("--max-usd="))?.slice(10) ?? "0.20";
if (
  !/^\d{1,2}(?:\.\d{1,2})?$/.test(limitArg) ||
  !d(limitArg).gt(0) ||
  d(limitArg).gt(20)
)
  throw new Error(
    "Explicit probe cap must be greater than zero and at most USD 20",
  );
const HARD_LIMIT_MICROS = d(limitArg).times(1_000_000).toNumber();
if (
  args.some(
    (a) =>
      !["--live", "--extended", "--retry-free-failure"].includes(a) &&
      !a.startsWith("--stage=") &&
      !a.startsWith("--max-usd="),
  ) ||
  (stageArg && !allowedStages.includes(stageArg))
)
  throw new Error("Unsupported probe argument or stage");
if (!args.includes("--live")) {
  console.log(
    JSON.stringify({
      mode: "dry-run",
      paidCalls: 0,
      hardLimitUSD: d(limitArg).toFixed(2),
      database: DATABASE,
      matrix: args.includes("--extended") ? extendedStages : undefined,
      note: "Use --live explicitly. Only synthetic ledgers. Live mode shares production budget reservations and reads budget admission fields; never holdings or transactions.",
    }),
  );
} else {
  process.umask(0o077);
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Parse only the explicitly authorized project file in memory. Never print its contents or inspect other profiles.
  const key = parseEnv(
    readFileSync(join(workspace, ".env.local"), "utf8"),
  ).OPENAI_API_KEY?.trim();
  if (!key) throw new Error("Authorized project key is not configured");
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  chmodSync(DIRECTORY, 0o700);
  const store = new Store(DATABASE);
  // Production expenses and probe membership are the single budget authority.
  // No production settings, holdings, transactions, or keys are modified.
  const production = new Store(join(dataDirectory(), "finance.sqlite"));
  const started = new Date();
  const now = () => new Date();
  const safe = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (_name, item) =>
        typeof item === "string"
          ? item
              .split(key)
              .join("[REDACTED]")
              .replace(/sk-[\w-]+/g, "[REDACTED]")
          : item,
      ),
    );
  const guardedStore = new ProbeBudgetStore(
    production,
    store,
    HARD_LIMIT_MICROS,
    now,
  );
  const accounted = () => guardedStore.accountedMicros();
  const save = () => {
    const providerUsage = store
      .list<Record<string, unknown>>("probe-provider-usage")
      .map((row) => ({
        ...row,
        syntheticOutput: Array.isArray(row.syntheticOutput)
          ? row.syntheticOutput.filter(
              (item: Record<string, unknown>) => item.type !== "reasoning",
            )
          : undefined,
      }));
    const evidence = safe({
      generatedAt: now().toISOString(),
      database: DATABASE,
      hardLimitMicros: HARD_LIMIT_MICROS,
      accountedMicros: accounted(),
      sharedProductionBudget: true,
      creditDeclaration:
        "Production monthly limit and confirmed credit admission fields only; no holdings or transactions read. Expenses reserve and settle in the shared production budget. Grant details omitted from this export.",
      reservations: guardedStore.records(),
      audits: store.list("ai-audit"),
      providerUsage,
      freeRequests: store.list("probe-free-requests"),
      previousAttempts: store.list("probe-attempts"),
      results: store.list("probe-results"),
      publicProductMetadata: store
        .list<ProductData>("probe-products")
        .map((p) => ({
          code: p.instrument.code,
          asOf: p.observation?.asOf,
          quality: p.observation?.quality,
          historyPoints: p.history.length,
          sourceUrl: p.observation?.sourceUrl,
          errors: p.errors,
        })),
    });
    writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
    });
    chmodSync(EVIDENCE, 0o600);
  };
  const settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    ...guardedStore.budgetFields(),
    apiEnabled: true,
    model: "gpt-6.1-sol",
    reasoning: "medium",
    monitoring: false,
    allowedRead: true,
    allowedWrite: true,
  };
  const transport: typeof fetch = async (input, init) => {
    const url = String(input),
      method = init?.method ?? "GET";
    if (url === "https://api.openai.com/v1/models" && method === "GET") {
      // AiService owns the bounded free-catalog retry; do not multiply retries in this transport.
      const at = now().toISOString();
      try {
        const response = await fetch(input, init);
        store.put("probe-free-requests", at, {
          at,
          endpoint: url,
          httpStatus: response.status,
        });
        return response;
      } catch (error) {
        const e = error as { name?: string; cause?: { code?: string } };
        store.put("probe-free-requests", at, {
          at,
          endpoint: url,
          errorName: e.name,
          causeCode: e.cause?.code,
        });
        throw error;
      }
    }
    if (
      ![
        "https://api.openai.com/v1/responses",
        "https://api.openai.com/v1/decisions",
      ].includes(url) ||
      method !== "POST"
    )
      throw new Error("Probe endpoint not allowed");
    const requestId = new Headers(init?.headers).get("X-Client-Request-Id");
    const reservation = requestId
      ? guardedStore.get<Reservation>("ai-budget", requestId)
      : undefined;
    // Ownership and reservation were committed together in the shared database.
    // The probe cap includes its lifetime records, even across months/restarts.
    if (
      !reservation ||
      !requestId ||
      !guardedStore.owns(requestId) ||
      reservation.status !== "reserved" ||
      accounted() > HARD_LIMIT_MICROS
    )
      throw new Error(
        "Probe hard limit or reservation check failed; request not sent",
      );
    save(); // Durable pre-request accounting, even if the process later stops.
    const response = await fetch(input, init);
    const body = (await response
      .clone()
      .json()
      .catch(() => ({}))) as Record<string, unknown>;
    const error =
      body.error && typeof body.error === "object"
        ? (body.error as Record<string, unknown>)
        : undefined;
    store.put(
      "probe-provider-usage",
      requestId!,
      safe({
        requestId,
        capturedAt: now().toISOString(),
        endpoint: url,
        httpStatus: response.status,
        providerRequestId: response.headers.get("x-request-id"),
        model: body.model,
        responseId: body.id,
        status: body.status,
        usage: body.usage,
        answers: body.answers,
        syntheticOutput: Array.isArray(body.output)
          ? body.output.filter(
              (i: Record<string, unknown>) => i.type !== "reasoning",
            )
          : undefined,
        outputTypes: Array.isArray(body.output)
          ? body.output.map((i: Record<string, unknown>) => i.type)
          : undefined,
        error: error
          ? { type: error.type, code: error.code, param: error.param }
          : undefined,
      }),
    );
    save();
    return response;
  };
  const service = new AiService(guardedStore, {
    fetch: transport,
    keyProvider: () => key,
    now,
  });
  const instrument = {
    code: "TEST-API",
    name: "合成验收基金（非真实资产）",
    kind: "fund" as const,
    currency: "CNY" as const,
    market: "CN" as const,
  };
  const snapshot: PortfolioSnapshot = {
    id: "synthetic-api-verification",
    createdAt: started.toISOString(),
    revision: 0,
    positions: [
      {
        code: instrument.code,
        name: instrument.name,
        currency: "CNY",
        quantity: "100",
        sellable: "0",
        cost: "100",
        averageCost: "1",
        price: "1",
        marketValue: "100",
        pnl: "0",
        instrument,
        accounts: [
          { account: "SYNTHETIC_VERIFICATION", quantity: "100", sellable: "0" },
        ],
      },
    ],
    cash: { CNY: "900" },
    accountCash: { SYNTHETIC_VERIFICATION: { CNY: "900" } },
    frozen: {},
    receivables: {},
    totalValue: "1000",
    investedCost: "100",
    realizedPnl: "0",
    unrealizedPnl: "0",
    income: "0",
    fees: "0",
    externalFlows: "1000",
    totalPnl: "0",
    reconciliation: "0",
    warnings: ["全部数字均为接口验收用合成资料，不代表真实价格或用户资产。"],
    risk: settings.risk,
  };
  const product: ProductData = {
    instrument,
    observation: {
      code: instrument.code,
      price: "1",
      asOf: "2026-10-30",
      fetchedAt: started.toISOString(),
      currency: "CNY",
      priceKind: "nav",
      source: "synthetic API verification fixture",
      sourceUrl: "https://example.com/synthetic-fixture",
      quality: "valid",
    },
    history: Array.from({ length: 20 }, (_, i) => ({
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      nav: "1",
    })),
    exposures: [],
    documents: [],
    errors: [],
    fetchedAt: started.toISOString(),
  };
  const stages: readonly Stage[] = stageArg
    ? [stageArg]
    : args.includes("--extended")
      ? extendedStages
      : ["brief", "decisions", "chat", "record"];
  const isExtended = (stage: Stage) => extendedStages.includes(stage);
  const publicProduct = async (code: string) => {
    const existing = store.get<ProductData>("probe-products", code);
    if (existing && now().getTime() - Date.parse(existing.fetchedAt) < 3600_000)
      return existing;
    const instrument = REFERENCE_INSTRUMENTS.find((i) => i.code === code);
    if (!instrument) throw new Error("Unknown public fixture product");
    const fetched = await fetchProduct(instrument);
    store.put("probe-products", code, fetched);
    store.put("instruments", code, fetched.instrument);
    return fetched;
  };
  const productSnapshot = (
    p: ProductData,
    configured = false,
  ): PortfolioSnapshot => {
    const price = p.observation?.price ?? "0",
      value = d(price).times(100).toFixed(2);
    const risk = {
      configured,
      minimumCash: "1000",
      singleTradeLimit: "500",
      maxPositionPct: "20",
    };
    return {
      ...snapshot,
      id: `synthetic-public-${p.instrument.code}`,
      risk,
      cash: { CNY: "10000" },
      accountCash: { SYNTHETIC_VERIFICATION: { CNY: "10000" } },
      totalValue: d(10000).plus(value).toFixed(2),
      investedCost: value,
      externalFlows: d(10000).plus(value).toFixed(2),
      warnings: [
        "行情和产品资料来自公开来源；持仓100份、现金及风险数值全部是验收夹具，不是用户真实资产或风险配置。",
      ],
      positions: [
        {
          code: p.instrument.code,
          name: p.instrument.name,
          currency: p.instrument.currency,
          quantity: "100",
          sellable: "100",
          cost: value,
          averageCost: price,
          price,
          marketValue: value,
          pnl: "0",
          instrument: p.instrument,
          observation: p.observation,
          accounts: [
            {
              account: "SYNTHETIC_VERIFICATION",
              quantity: "100",
              sellable: "100",
              marketValue: value,
            },
          ],
        },
      ],
    };
  };
  try {
    for (const stage of stages) {
      const prior = store.get<{ status: string; accountedDeltaMicros: number }>(
        "probe-results",
        stage,
      );
      if (prior) {
        if (
          args.includes("--retry-free-failure") &&
          prior.status === "failed" &&
          prior.accountedDeltaMicros === 0
        ) {
          store.put("probe-attempts", `${stage}:${now().toISOString()}`, prior);
          store.remove("probe-results", stage);
        } else {
          console.log(
            JSON.stringify({
              stage,
              skipped: "Already attempted. No automatic paid retry.",
            }),
          );
          continue;
        }
      }
      if (accounted() >= HARD_LIMIT_MICROS) break;
      const cfg =
        stage === "brief" ||
        (isExtended(stage) && !stage.startsWith("public-fund-"))
          ? settings
          : { ...settings, model: "gpt-6-luna", reasoning: "none" as const };
      store.put("settings", "app", cfg);
      const before = accounted();
      store.put("probe-results", stage, {
        stage,
        startedAt: now().toISOString(),
        status: "started",
        model: cfg.model,
      });
      save();
      try {
        let result: unknown;
        // Read-only connection probe before the two explicitly requested final contracts.
        if (stage.endsWith("-2") || isExtended(stage)) await service.models();
        if (stage.startsWith("public-fund-")) {
          service.resetPrompt("decisions");
          const p = await publicProduct(stage.slice("public-fund-".length));
          const decision = await service.decide(productSnapshot(p), p, cfg);
          if (decision.status === "error") throw new Error(decision.reason);
          result = {
            decision,
            defaultPrompt: true,
            publicSource: p.observation?.sourceUrl,
            asOf: p.observation?.asOf,
            historyPoints: p.history.length,
            exposureCount: p.exposures.length,
            sourceWarnings: p.errors,
          };
        } else if (stage === "default-sol-chat") {
          service.resetPrompt("chat");
          result = await service.chat(
            snapshot,
            "根据提供的公开基金信息，简要分析黄金、富时100、欧洲股票、标普500、纳斯达克100和抗通胀FOF在分散化上的作用及可能重复敞口。区分公开证据、推断和缺失资料；组合金额是合成验收数据，不代表我的真实资产。",
            [],
            cfg,
            "analysis",
            () => {
              throw new Error("Analysis cannot record");
            },
            "verification-default-sol-chat",
            {
              publicProducts: store
                .list<ProductData>("probe-products")
                .map((p) => ({
                  instrument: p.instrument,
                  observation: p.observation,
                  exposures: p.exposures.slice(0, 5),
                  errors: p.errors,
                })),
              ledgerScope: "synthetic test fixture; not user holdings",
            },
          );
        } else if (stage.startsWith("default-record-complete")) {
          service.resetPrompt("record");
          const day = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(started);
          const reply = await service.chat(
            snapshot,
            `请登记已发生的入金：账户SYNTHETIC_VERIFICATION，币种CNY，日期${day}，已到账金额2000.00，费用0，无产品代码和份额。`,
            [],
            cfg,
            "record",
            (input) => {
              if (
                input.kind !== "deposit" ||
                input.account !== "SYNTHETIC_VERIFICATION" ||
                input.currency !== "CNY" ||
                !d(input.amount).eq(2000) ||
                !d(input.fee ?? 0).eq(0)
              )
                throw new Error("Unexpected synthetic deposit values");
              return recordTransaction(store, input);
            },
            `verification-${stage}`,
            {
              ledgerScope:
                "Only an isolated synthetic ledger exists for this API test. Every financial fact in this request is a fixture, not user assets.",
            },
          );
          if (!reply.receipts?.length)
            throw new Error("Default record prompt returned no receipt");
          result = reply;
        } else if (stage.startsWith("default-subscribe-unconfirmed")) {
          service.resetPrompt("record");
          const day = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(started);
          recordTransaction(store, {
            idempotencyKey: "probe-subscription-funding",
            kind: "deposit",
            account: "SYNTHETIC_SUBSCRIPTION",
            currency: "CNY",
            amount: "1000",
            date: day,
            note: "隔离API验收合成入金，非真实用户资产",
          });
          const reply = await service.chat(
            {
              ...snapshot,
              accountCash: { SYNTHETIC_SUBSCRIPTION: { CNY: "1000" } },
            },
            `请记录已提交但尚未确认的基金申购申请：产品000216，账户SYNTHETIC_SUBSCRIPTION，币种CNY，申请日期${day}，已扣款申请本金100.00，费用0，确认份额和成交净值都还不知道。只记申请，不要记为成交。`,
            [],
            cfg,
            "record",
            (input) => {
              if (
                input.kind !== "subscribe" ||
                input.account !== "SYNTHETIC_SUBSCRIPTION" ||
                input.code !== "000216" ||
                input.currency !== "CNY" ||
                !d(input.amount).eq(100) ||
                !d(input.quantity ?? 0).eq(0) ||
                !d(input.fee ?? 0).eq(0)
              )
                throw new Error(
                  "Unconfirmed application must not invent a purchase or units",
                );
              return recordTransaction(store, input);
            },
            `verification-${stage}`,
            {
              ledgerScope:
                "Isolated synthetic API test only. No real user ledger or broker connection.",
            },
          );
          result = {
            ...reply,
            behavior: reply.receipts?.length
              ? "application_only_recorded"
              : "clarified_without_creating_units",
          };
        } else if (stage.startsWith("default-record-incomplete")) {
          service.resetPrompt("record");
          const reply = await service.chat(
            snapshot,
            "请帮我记一笔买基金，花了50元。",
            [],
            cfg,
            "record",
            () => {
              throw new Error(
                "Incomplete facts must not invoke a ledger mutation",
              );
            },
            `verification-${stage}`,
            {
              ledgerScope:
                "Isolated synthetic API test only. Missing account, fund code, date and confirmation facts are intentional.",
            },
          );
          if (
            reply.receipts?.length ||
            !/账户|代码|币种|日期|补充|提供|确认|哪/.test(reply.text)
          )
            throw new Error("Incomplete request did not ask for missing facts");
          result = reply;
        } else if (
          stage === "review-structured" ||
          stage === "amounts-structured"
        ) {
          service.resetPrompt(
            stage === "review-structured" ? "review" : "amounts",
          );
          const syntheticInstrument = {
            ...instrument,
            rulesVerified: true,
            purchasable: true,
            channel: "SYNTHETIC_VERIFICATION",
            feeRate: "0.01",
            minBuy: "1",
          };
          const protocol: PortfolioSnapshot = {
            ...snapshot,
            id: "synthetic-structured-protocol",
            cash: { CNY: "10000" },
            accountCash: { SYNTHETIC_VERIFICATION: { CNY: "10000" } },
            totalValue: "10100",
            risk: {
              configured: true,
              minimumCash: "1000",
              singleTradeLimit: "500",
              maxPositionPct: "20",
            },
            positions: snapshot.positions.map((p) => ({
              ...p,
              instrument: syntheticInstrument,
            })),
            warnings: [
              "仅为structured-output协议模拟；持仓、价格、费用、风险配置及下列.91决策均为合成输入，不能发送投资告警或作为真实投资建议。",
            ],
          };
          const decision: DecisionResult = {
            code: instrument.code,
            snapshotId: protocol.id,
            asOf: product.observation!.asOf,
            generatedAt: now().toISOString(),
            buy: 0.91,
            sell: 0.04,
            hold: 0.05,
            confidence: 0.95,
            score: 5,
            status: "valid",
            model: "synthetic protocol fixture, not a model result",
            promptVersion: 0,
            reason:
              "Protocol simulation only; artificial threshold input, no alert will be created",
          };
          if (stage === "review-structured")
            result = {
              protocolSimulation: true,
              review: await service.review(
                protocol,
                decision,
                { ...product, instrument: syntheticInstrument },
                cfg,
              ),
            };
          else {
            const candidates = amountCandidates(
              protocol,
              syntheticInstrument,
              "Buy",
            );
            if (candidates.length !== 3)
              throw new Error(
                "Expected three deterministic protocol candidates",
              );
            result = {
              protocolSimulation: true,
              candidates: await service.evaluateAmounts(
                protocol,
                decision,
                candidates,
                cfg,
              ),
            };
          }
        } else if (stage === "brief") {
          service.savePrompt(
            "brief",
            "这是隔离接口验收。用中文至多两句话说明输入为合成资产、当前缺少个性化风险设置；不要生成投资建议或长篇分析。",
          );
          const brief = await service.brief(snapshot, [], cfg);
          if (brief.status !== "generated") throw new Error(brief.text);
          result = brief;
        } else if (stage.startsWith("decisions")) {
          if (stage.startsWith("decisions-contract"))
            service.savePrompt(
              "decisions",
              "本次只做合成数据的API协议契约测试，所有输出都无投资意义，不为真实资产给建议。请验证已明确给出的测试夹具：选择Hold；quality问题请给等级3，用于验证离散score的解析。不要把合成数据视为真实行情。",
            );
          const decision = await service.decide(snapshot, product, cfg);
          if (decision.status !== "valid" && decision.status !== "refused")
            throw new Error(decision.reason ?? "Invalid decision");
          if (
            stage.startsWith("decisions-contract") &&
            decision.status !== "valid"
          )
            throw new Error(
              "Synthetic contract did not return choice and score",
            );
          result = decision;
        } else if (stage === "chat") {
          result = await service.chat(
            snapshot,
            "仅用一句话解释：模型的Buy/Sell/Hold选择概率是否等于投资盈利概率？",
            [],
            cfg,
            "analysis",
            () => {
              throw new Error("Analysis cannot record");
            },
          );
        } else {
          if (stage.startsWith("record-contract"))
            service.savePrompt(
              "record",
              "本次连接的是隔离的合成账本，record_transaction只登记测试数据，不接触真实账本或金融账户。用户明确报告的已发生测试入金可以登记；不要把测试数据当真实资产。若本条消息给齐账户、币种、日期、金额、费用，请调用一次record_transaction；不得虚构其他值。",
            );
          const day = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Shanghai",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(started);
          const record = (input: TransactionInput) => {
            if (
              input.account !== "SYNTHETIC_VERIFICATION" ||
              input.kind !== "deposit" ||
              input.currency !== "CNY" ||
              input.amount !== "1.23"
            )
              throw new Error("Synthetic callback rejected unexpected values");
            return recordTransaction(store, input);
          };
          const reply = await service.chat(
            snapshot,
            `请在隔离的合成账本中记录一笔已发生的测试入金：账户SYNTHETIC_VERIFICATION，币种CNY，日期${day}，金额1.23，费用0。没有产品代码或份额。全部为测试数据，仅供API工具调用验收。`,
            [],
            cfg,
            "record",
            record,
            `verification-${stage}-once`,
          );
          if (!reply.receipts?.length)
            throw new Error("No synthetic recording receipt returned");
          result = reply;
        }
        const decisionStatus = stage.startsWith("public-fund-")
          ? (result as { decision: DecisionResult }).decision.status
          : (result as { status?: string }).status;
        const status =
          (stage === "decisions" || stage.startsWith("public-fund-")) &&
          decisionStatus === "refused"
            ? "refusal_handled"
            : decisionStatus === "insufficient"
              ? "blocked_insufficient"
              : "passed";
        store.put(
          "probe-results",
          stage,
          safe({
            stage,
            startedAt: store.get<Record<string, unknown>>(
              "probe-results",
              stage,
            )?.startedAt,
            completedAt: now().toISOString(),
            status,
            model: cfg.model,
            accountedDeltaMicros: accounted() - before,
            result,
          }),
        );
        console.log(
          JSON.stringify({ stage, status, accountedMicros: accounted() }),
        );
      } catch (error) {
        store.put(
          "probe-results",
          stage,
          safe({
            stage,
            completedAt: now().toISOString(),
            status: "failed",
            model: cfg.model,
            accountedDeltaMicros: accounted() - before,
            error: error instanceof Error ? error.message : "Probe failed",
          }),
        );
        console.log(
          JSON.stringify({
            stage,
            status: "failed",
            accountedMicros: accounted(),
            note: "Inspect redacted external evidence; no automatic retry.",
          }),
        );
        if (!isExtended(stage) || !service.budget(cfg).enabled) break;
      } finally {
        save();
      }
    }
  } finally {
    save();
    console.log(
      JSON.stringify({
        database: DATABASE,
        evidence: EVIDENCE,
        accountedMicros: accounted(),
        hardLimitMicros: HARD_LIMIT_MICROS,
        productionFinancialLedgerUntouched: true,
        sharedProductionBudget: true,
      }),
    );
    store.close();
    production.close();
  }
}
