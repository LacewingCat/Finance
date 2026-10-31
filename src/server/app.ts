import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { Store } from "./store.js";
import { settings, updateSettings } from "./config.js";
import {
  recordTransaction,
  reverseTransaction,
  transactions,
  d,
} from "./ledger.js";
import { performance, snapshot, marketDate } from "./portfolio.js";
import { portfolioExposure } from "./portfolio-exposure.js";
import { amountCandidates, triggerEligible, tradeWindow, candidateCashRequiredCny } from "./risk.js";
import {
  fetchCatalog,
  fetchProduct,
  REFERENCE_INSTRUMENTS,
  fetchPublicReport,
} from "./providers.js";
import { flattenExposures, validateExposureGraph } from "./exposure.js";
import { AiService } from "./ai.js";
import { fetchNews, fetchFx } from "./feeds.js";
import { saveApiKey, deleteApiKey } from "./secrets.js";
import type {
  AlertOutbox,
  AppState,
  Brief,
  DecisionResult,
  DocumentCard,
  Instrument,
  InvestmentPlan,
  ProductData,
  PortfolioSnapshot,
} from "../shared/types.js";

export interface AppOptions {
  store?: Store;
  ai?: AiService;
  token?: string;
  port?: number;
  staticDir?: string;
  fetchProduct?: typeof fetchProduct;
  fetchCatalog?: typeof fetchCatalog;
  fetchNews?: typeof fetchNews;
  now?: () => Date;
}
const safeError = (error: unknown) => {
  const text =
    error instanceof z.ZodError
      ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；")
      : error instanceof Error
        ? error.message
        : "操作失败";
  return text.replace(/sk-[\w-]+/g, "[REDACTED]").slice(0, 1000);
};
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

export async function buildApp(options: AppOptions = {}) {
  const store = options.store ?? new Store(),
    ai = options.ai ?? new AiService(store),
    now = options.now ?? (() => new Date()),
    token = options.token ?? randomBytes(32).toString("hex");
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  const port = options.port ?? 4318;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  let loginAttempts: { at: number; count: number } = { at: 0, count: 0 };
  const monitor: AppState["monitor"] = {
    running: false,
    intervalSeconds: 60,
    errors: [],
  };
  const productFetch = options.fetchProduct ?? fetchProduct,
    catalogFetch = options.fetchCatalog ?? fetchCatalog;
  const pending = new Map<string, Promise<ProductData>>();
  let refreshPromise: Promise<unknown> | undefined;
  for (const i of REFERENCE_INSTRUMENTS)
    if (!store.get("instruments", i.code))
      store.put("instruments", i.code, { ...i, watched: true });
  await app.register(cookie);
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host ?? "";
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(host))
      return reply.code(403).send({ error: "Host 不被允许" });
    const allowedOrigins = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]);
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin))
      return reply.code(403).send({ error: "跨域请求被拒绝" });
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (!req.url.startsWith("/api/")) return;
    if (req.url.split("?")[0] === "/api/session") return;
    const session = sessions.get(req.cookies.finance_session ?? "");
    if (!session || session.expires < now().getTime())
      return reply.code(401).send({ error: "请通过本地启动入口打开工作台" });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !equal(String(req.headers["x-csrf-token"] ?? ""), session.csrf)
    )
      return reply.code(403).send({ error: "CSRF 校验失败" });
  });
  app.setErrorHandler((error, _req, reply) =>
    reply
      .code(
        error instanceof z.ZodError
          ? 400
          : ((error as { statusCode?: number }).statusCode ?? 400),
      )
      .send({ error: safeError(error) }),
  );
  app.get("/api/session", async (req) => {
    const s = sessions.get(req.cookies.finance_session ?? "");
    return s && s.expires > now().getTime()
      ? { authenticated: true, csrf: s.csrf }
      : { authenticated: false };
  });
  app.post("/api/session", async (req, reply) => {
    if (now().getTime() - loginAttempts.at > 60000)
      loginAttempts = { at: now().getTime(), count: 0 };
    if (++loginAttempts.count > 20)
      return reply.code(429).send({ error: "请稍后再尝试登录" });
    const body = z.object({ token: z.string().max(200) }).parse(req.body);
    if (!equal(body.token, token))
      return reply.code(401).send({ error: "启动令牌无效" });
    const id = randomBytes(32).toString("hex"),
      csrf = randomBytes(24).toString("hex");
    sessions.set(id, { csrf, expires: now().getTime() + 86400000 });
    for (const [sid, s] of sessions)
      if (s.expires < now().getTime()) sessions.delete(sid);
    return reply
      .setCookie("finance_session", id, {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 86400,
      })
      .send({ authenticated: true, csrf });
  });
  async function product(code: string, force = false): Promise<ProductData> {
    const instrument = store.get<Instrument>("instruments", code);
    if (!instrument) throw new Error("产品不存在，请先在目录中查找并加入");
    const old = store.get<ProductData>("products", code);
    const ttl =
      instrument.kind === "stock" || instrument.kind === "etf"
        ? 60000
        : 3600000;
    if (old && !force && now().getTime() - Date.parse(old.fetchedAt) < ttl)
      return old;
    if (pending.has(code)) return pending.get(code)!;
    const promise = productFetch(instrument)
      .then((p) => {
        const current =
          store.get<Instrument>("instruments", code) ?? instrument;
        const prior = store.get<ProductData>("products", code);
        const merged = {
          ...p,
          instrument: {
            ...current,
            ...p.instrument,
            watched: current.watched,
            purchasable: current.purchasable,
            rulesVerified: current.rulesVerified,
            channel: current.channel,
            minBuy: current.minBuy,
            lotSize: current.lotSize,
            channelLimit: current.channelLimit,
            feeRate: current.feeRate,
            settlementDays: current.settlementDays,
          },
        };
        if (!p.observation && prior?.observation) {
          merged.observation = { ...prior.observation, quality: "stale" };
          merged.errors.push("本次未取得有效估值，显示上次数据");
        }
        store.put("products", code, merged);
        store.put("instruments", code, merged.instrument);
        return merged;
      })
      .finally(() => pending.delete(code));
    pending.set(code, promise);
    return promise;
  }
  const documents = () =>
    [
      ...store.list<DocumentCard>("news"),
      ...store.list<ProductData>("products").flatMap((p) => p.documents),
    ]
      .filter((v, i, a) => a.findIndex((x) => x.url === v.url) === i)
      .slice(0, 30);
  const context = () => {
    const heldCodes=new Set(snapshot(store,now()).positions.map(p=>p.code));
    return ({
    coverage: '完整当前组合快照；最近20笔流水、20个计划及最多6个持仓/观察产品的精简证据。其余产品和更早记录未包含，请勿视为完整历史。',
    portfolioExposure: portfolioExposure(store, now()),
    transactions: transactions(store).slice(-20),
    plans: store.list("plans").slice(0, 20),
    products: store
      .list<ProductData>("products")
      .filter((p) => p.instrument.watched||heldCodes.has(p.instrument.code))
      .slice(0, 6)
      .map((p) => ({
        instrument: p.instrument,
        observation: p.observation,
        history: p.history.slice(-10),
        exposures: p.exposures.slice(0, 8),
        errors: p.errors,
      })),
  });
  };
  const chatRequests = new Map<
    string,
    { hash: string; promise: Promise<unknown> }
  >();
  async function refresh(code?: string, scheduled = false) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      monitor.running = true;
      monitor.errors = [];
      const cfg = settings(store),
        budget = ai.budget(cfg);
      const used=Number(budget.spent)+Number(budget.reserved);
      const fraction=used/Math.max(.000001,used+Number(budget.remaining));
      monitor.intervalSeconds =
        fraction > 0.94
          ? 900
          : fraction > 0.85
            ? 300
            : fraction > 0.7
              ? 120
              : 60;
      const held = new Set(snapshot(store, now()).positions.map((p) => p.code));
      const list = code
        ? [store.get<Instrument>("instruments", code)].filter(
            (i): i is Instrument => !!i,
          )
        : store
            .list<Instrument>("instruments")
            .filter((i) => i.watched || held.has(i.code));
      for (const instrument of list) {
        try {
          await product(instrument.code);
        } catch (e) {
          monitor.errors.push(`${instrument.name}：${safeError(e)}`);
        }
      }
      const newsAt = store.get<{ at: string }>("metadata", "news");
      if (!newsAt || now().getTime() - Date.parse(newsAt.at) >= 900000) {
        const news = await (options.fetchNews ?? fetchNews)();
        for (const doc of news.documents) store.put("news", doc.id, doc);
        store.put("metadata", "news", { at: news.fetchedAt });
        monitor.errors.push(...news.errors);
      }
      const snap = snapshot(store, now());
      store.put("dailySnapshots", marketDate("CN", now()), snap);
      const activeAlerts = store
        .list<AlertOutbox>("alerts")
        .filter(
          (a) =>
            a.direction === "Buy" &&
            a.snapshotId === snap.id &&
            Date.parse(a.expiresAt) > now().getTime(),
        );
      let allocated = activeAlerts.reduce((sum, a) => {
        const instrument=store.get<Instrument>('instruments',a.code);
        if(!instrument)throw new Error('有效告警缺少产品规则，暂停新增资金建议');
        const max=a.candidates.reduce((m,c)=>{const cash=d(candidateCashRequiredCny(c,instrument,snap,now()));return cash.gt(m)?cash:m;},d());
        return sum.plus(max);
      }, d());
      for (const pos of snap.positions) {
        const p = store.get<ProductData>("products", pos.code);
        if (!p) continue;
        if (
          scheduled &&
          (!settings(store).monitoring ||
            !tradeWindow(p.instrument, settings(store), now()).open)
        )
          continue;
        if (snapshot(store, now()).id !== snap.id) continue;
        const prior = store.get<DecisionResult>("decisions", pos.code);
        if (prior?.snapshotId === snap.id && prior.status === "valid") continue;
        let decision: DecisionResult;
        try {
          decision = await ai.decide(snap, p, settings(store));
        } catch (e) {
          decision = {
            code: pos.code,
            snapshotId: snap.id,
            asOf: p.observation?.asOf ?? "",
            generatedAt: now().toISOString(),
            buy: null,
            sell: null,
            hold: null,
            score: null,
            confidence: null,
            status: "error",
            reason: safeError(e),
            model: "gpt-6-luna",
            promptVersion: 1,
          };
        }
        store.put("decisions", pos.code, decision);
        if(decision.status==='valid'){
          store.put('analysis-snapshots',snap.id,snap);
          store.put('decision-history',`${pos.code}:${decision.generatedAt}`,{decision,observation:p.observation,rules:p.instrument,sourceFetchedAt:p.fetchedAt,recordedAt:now().toISOString()});
        }
        const gate = triggerEligible(decision, snap, p, settings(store), now());
        if (!gate.eligible || !gate.direction) continue;
        const recent = store
          .list<AlertOutbox>("alerts")
          .find(
            (a) =>
              a.code === pos.code &&
              a.direction === gate.direction &&
              now().getTime() - Date.parse(a.createdAt) < 1800000,
          );
        if (recent) continue;
        try {
          if (
            snapshot(store, now()).id !== snap.id ||
            (scheduled && !settings(store).monitoring)
          )
            continue;
          const review = await ai.review(snap, decision, p, settings(store));
          if (!review.eligible || review.confidence <= 0.9) continue;
          const candidates = amountCandidates(
            snap,
            p.instrument,
            gate.direction,
            allocated.toFixed(),
            now(),
          );
          if (!candidates.length) continue;
          if (
            snapshot(store, now()).id !== snap.id ||
            (scheduled && !settings(store).monitoring)
          )
            continue;
          const rated = await ai.evaluateAmounts(
            snap,
            decision,
            candidates,
            settings(store),
          );
          if (
            snapshot(store, now()).id !== snap.id ||
            !triggerEligible(decision, snap, p, settings(store), now()).eligible
          )
            continue;
          if (gate.direction === "Buy")
            allocated = allocated.plus(
              candidateCashRequiredCny(candidates.at(-1)!,p.instrument,snap,now()),
            );
          const alert: AlertOutbox = {
            id: randomUUID(),
            code: pos.code,
            direction: gate.direction,
            snapshotId: snap.id,
            createdAt: now().toISOString(),
            expiresAt: new Date(now().getTime() + 300000).toISOString(),
            probability:
              gate.direction === "Buy" ? decision.buy! : decision.sell!,
            reviewConfidence: review.confidence,
            candidates: rated,
            summary: review.summary,
            status: "local",
          };
          store.put("alerts", alert.id, alert);
        } catch (e) {
          monitor.errors.push(`决策复核：${safeError(e)}`);
        }
      }
      monitor.lastRefresh = now().toISOString();
      return { ok: true, snapshotId: snap.id, errors: monitor.errors };
    })().finally(() => {
      monitor.running = false;
      refreshPromise = undefined;
    });
    return refreshPromise;
  }
  app.get("/api/state", async (): Promise<AppState> => {
    const snap = snapshot(store, now());
    const alerts = store
      .list<AlertOutbox>("alerts")
      .map((a) => ({
        ...a,
        status:
          Date.parse(a.expiresAt) < now().getTime() || a.snapshotId !== snap.id
            ? ("expired" as const)
            : a.status,
      }));
    return {
      snapshot: snap,
      settings: settings(store),
      budget: ai.budget(settings(store)),
      keyConfigured: ai.status().configured,
      catalogCount: store.list<Instrument>("instruments").length,
      watched: store.list<Instrument>("instruments").filter((i) => i.watched),
      documents: documents(),
      brief: store.get<Brief>("brief", "latest"),
      decisions: store
        .list<DecisionResult>("decisions")
        .map((d) =>
          d.snapshotId !== snap.id ? { ...d, status: "stale" as const } : d,
        ),
      alerts,
      monitor,
      notification: {
        state: "pending",
        message:
          "ChatGPT 手机通知待完成：身份验证、隧道订阅及 iPhone 实际送达尚未验收。本地告警正常保存。",
      },
    };
  });
  app.get("/api/instruments", async (req) => {
    const query = z
      .object({
        q: z.string().max(100).default(""),
        limit: z.coerce.number().min(1).max(100).default(30),
      })
      .parse(req.query);
    const q = query.q.toLowerCase();
    const all = store
      .list<Instrument>("instruments")
      .filter((i) =>
        `${i.code} ${i.name} ${i.aliases?.join(" ") ?? ""}`
          .toLowerCase()
          .includes(q),
      );
    return { items: all.slice(0, query.limit), total: all.length };
  });
  app.post("/api/catalog/refresh", async () => {
    const meta = store.get<{ at: string }>("metadata", "catalog");
    if (meta && now().getTime() - Date.parse(meta.at) < 86400000)
      return { count: store.list("instruments").length, cached: true };
    const rows = await catalogFetch();
    store.atomic(() => {
      for (const i of rows) {
        const old = store.get<Instrument>("instruments", i.code);
        store.put("instruments", i.code, { ...i, ...old });
      }
      store.put("metadata", "catalog", {
        at: now().toISOString(),
        count: rows.length,
      });
    });
    return { count: rows.length, cached: false };
  });
  app.get<{ Params: { code: string } }>("/api/products/:code", async (req) =>
    product(req.params.code),
  );
  app.get<{ Params: { code: string } }>(
    "/api/products/:code/exposure",
    async (req) => {
      const p = await product(req.params.code);
      return {
        ...validateExposureGraph(p.exposures),
        items: flattenExposures(p.exposures),
      };
    },
  );
  app.post("/api/watch", async (req) => {
    const { code } = z
      .object({ code: z.string().min(1).max(30) })
      .parse(req.body);
    const inst = store.get<Instrument>("instruments", code);
    if (!inst) throw new Error("目录中没有该产品");
    store.put("instruments", code, { ...inst, watched: true });
    return { ok: true };
  });
  app.delete<{ Params: { code: string } }>("/api/watch/:code", async (req) => {
    const i = store.get<Instrument>("instruments", req.params.code);
    if (i) store.put("instruments", i.code, { ...i, watched: false });
    return { ok: true };
  });
  app.post("/api/instruments", async (req) => {
    const instrument = z
      .object({
        code: z.string().regex(/^[\w.-]{1,25}$/),
        name: z.string().min(1).max(150),
        kind: z.enum(["fund", "qdii", "fof", "etf", "stock", "money"]),
        currency: z.enum(["CNY", "USD", "HKD", "GBP", "EUR"]),
        market: z.enum(["CN", "HK", "US", "UK", "EU"]),
      })
      .parse(req.body);
    if (store.get("instruments", instrument.code))
      throw new Error("代码已存在");
    store.put("instruments", instrument.code, { ...instrument, watched: true });
    return instrument;
  });
  app.patch<{ Params: { code: string } }>(
    "/api/instruments/:code",
    async (req) => {
      const old = store.get<Instrument>("instruments", req.params.code);
      if (!old) throw new Error("产品不存在");
      const patch = z
        .object({
          purchasable: z.boolean().optional(),
          channel: z.string().max(100).optional(),
          minBuy: z
            .string()
            .regex(/^\d+(\.\d+)?$/)
            .optional(),
          lotSize: z
            .string()
            .regex(/^\d+(\.\d+)?$/)
            .refine((v) => Number(v) > 0)
            .optional(),
          channelLimit: z
            .string()
            .regex(/^\d+(\.\d+)?$/)
            .optional(),
          feeRate: z
            .string()
            .regex(/^0(\.\d+)?$/)
            .optional(),
          rulesVerified: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      const i = { ...old, ...patch };
      store.put("instruments", i.code, i);
      const p = store.get<ProductData>("products", i.code);
      if (p) store.put("products", i.code, { ...p, instrument: i });
      store.bump();
      return i;
    },
  );
  app.post("/api/refresh", async (req) => {
    const body = z
      .object({ code: z.string().optional() })
      .parse(req.body ?? {});
    return refresh(body.code);
  });
  app.get("/api/transactions", async () => ({
    items: transactions(store).reverse(),
  }));
  app.post("/api/transactions", async (req) =>
    recordTransaction(store, req.body),
  );
  app.post<{ Params: { id: string } }>(
    "/api/transactions/:id/reverse",
    async (req) => reverseTransaction(store, req.params.id),
  );
  app.get("/api/plans", async () => ({
    items: store.list<InvestmentPlan>("plans"),
  }));
  app.post("/api/plans", async (req) => {
    const p = z
      .object({
        id: z.string().optional(),
        code: z.string().min(1),
        amount: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/)
          .refine((v) => Number(v) > 0),
        currency: z.enum(["CNY", "USD", "HKD", "GBP", "EUR"]),
        frequency: z.enum(["daily", "weekly", "monthly"]),
        nextDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        account: z.string().min(1),
        active: z.boolean(),
      })
      .parse(req.body);
    if (!store.get("instruments", p.code)) throw new Error("请先添加产品");
    const plan = { ...p, id: p.id ?? randomUUID() };
    store.put("plans", plan.id, plan);
    return plan;
  });
  app.delete<{ Params: { id: string } }>("/api/plans/:id", async (req) => {
    store.remove("plans", req.params.id);
    return { ok: true };
  });
  app.get("/api/exposure/portfolio", async () =>
    portfolioExposure(store, now()),
  );
  app.get("/api/decisions/history",async()=>({items:store.list("decision-history").slice(-100).reverse()}));
  app.get("/api/performance", async () => performance(store));
  app.post("/api/fx/refresh", async () => {
    const result = await fetchFx();
    updateSettings(store, { fxRates: result.rates, fxAsOf: result.asOf });
    store.put("metadata", "fx", result);
    return result;
  });
  app.patch("/api/settings", async (req) => updateSettings(store, req.body));
  app.get("/api/prompts", async () => ({ items: ai.prompts() }));
  app.get("/api/prompts/history", async () => ({
    items: store.list("prompt-history"),
  }));
  app.post<{ Params: { name: string } }>("/api/prompts/:name", async (req) => {
    const { text } = z
      .object({ text: z.string().min(1).max(8000) })
      .parse(req.body);
    return ai.savePrompt(req.params.name, text);
  });
  app.post<{ Params: { name: string } }>(
    "/api/prompts/:name/reset",
    async (req) => ai.resetPrompt(req.params.name),
  );
  app.get<{ Params: { name: string } }>(
    "/api/prompts/:name/preview",
    async (req) =>
      ai.preview(
        req.params.name,
        snapshot(store, now()),
        settings(store),
        context(),
      ),
  );
  app.get("/api/ai/audit", async () => ({
    items: store.list("ai-audit").slice(-100).reverse(),
  }));
  app.get("/api/models", async () => ({ items: await ai.models() }));
  app.post("/api/key", async (req) => {
    const { key } = z
      .object({ key: z.string().min(16).max(512) })
      .parse(req.body);
    return saveApiKey(key);
  });
  app.delete("/api/key", async () => deleteApiKey());
  app.post("/api/brief", async () => {
    const s = snapshot(store, now());
    let result: Brief;
    try {
      result = await ai.brief(s, documents(), settings(store), context());
    } catch (e) {
      result = {
        id: randomUUID(),
        snapshotId: s.id,
        createdAt: now().toISOString(),
        text: safeError(e),
        status: "unavailable",
      };
    }
    store.put("brief", "latest", result);
    return result;
  });
  app.post("/api/chat", async (req) => {
    const body = z
      .object({
        requestId: z.string().min(8).max(100).optional(),
        message: z.string().min(1).max(8000),
        history: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(20000),
            }),
          )
          .max(30)
          .default([]),
        mode: z.enum(["analysis", "record"]).default("analysis"),
      })
      .parse(req.body);
    const id = body.requestId ?? randomUUID(),
      hash = createHash("sha256")
        .update(JSON.stringify({ message: body.message, mode: body.mode }))
        .digest("hex");
    const prior = chatRequests.get(id);
    if (prior) {
      if (prior.hash !== hash) throw new Error("该消息编号已用于不同指令");
      return prior.promise;
    }
    const promise = ai.chat(
      snapshot(store, now()),
      body.message,
      body.history,
      settings(store),
      body.mode,
      (input) => {
        if (!settings(store).allowedWrite || !settings(store).allowedRead)
          throw new Error("模型记账权限已撤回");
        return recordTransaction(store, input);
      },
      id,
      context(),
    );
    chatRequests.set(id, { hash, promise });
    if (chatRequests.size > 200)
      chatRequests.delete(chatRequests.keys().next().value!);
    return promise;
  });
  app.get("/api/export", async () => ({
    version: 1,
    exportedAt: now().toISOString(),
    transactions: transactions(store),
    plans: store.list("plans"),
    settings: { ...settings(store), apiEnabled: false, monitoring: false },
    instruments: store.list<Instrument>("instruments").filter((i) => i.watched),
    prompts: ai.prompts(),
  }));
  app.post("/api/import", async (req) => {
    const body = z
      .object({
        transactions: z
          .array(z.record(z.string(), z.unknown()))
          .max(10000)
          .default([]),
        plans: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
      })
      .parse(req.body);
    return store.atomic(() => {
      const ids = new Map<string, string>();
      const imported = [];
      for (const raw of body.transactions) {
        if (raw.reversedBy || raw.reverses) continue;
        const { id, createdAt, reversedBy, reverses, ...fields } = raw;
        const parent = fields.parentId as string | undefined;
        if (parent && ids.has(parent)) fields.parentId = ids.get(parent);
        const t = recordTransaction(store, fields);
        if (typeof id === "string") ids.set(id, t.id);
        imported.push(t.id);
      }
      for (const raw of body.plans) {
        const p = raw as unknown as InvestmentPlan;
        if (
          !p.id ||
          !p.code ||
          !["daily", "weekly", "monthly"].includes(p.frequency) ||
          !d(p.amount).gt(0)
        )
          throw new Error("定投计划格式错误");
        store.put("plans", p.id, p);
      }
      return { imported: imported.length };
    });
  });
  app.get<{ Params: { id: string } }>(
    "/api/preview/:id",
    async (req, reply) => {
      const doc = documents().find((x) => x.id === req.params.id);
      if (!doc) return reply.code(404).send();
      const title = escape(doc.title.slice(0, 32)),
        source = escape(doc.source.slice(0, 30));
      return reply
        .type("image/svg+xml")
        .send(
          `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#122231"/><path d="M0 280 L100 260 190 280 270 180 360 210 480 110 640 140" fill="none" stroke="#32c8bd" stroke-width="3" opacity=".4"/><text x="40" y="65" fill="#69d9cf" font-family="sans-serif" font-size="16">FINANCE · 资料卡</text><foreignObject x="40" y="105" width="560" height="160"><div xmlns="http://www.w3.org/1999/xhtml" style="font:28px sans-serif;color:#eef5f7;line-height:1.5">${title}</div></foreignObject><text x="40" y="325" fill="#9badbc" font-family="sans-serif" font-size="17">${source} · 点击查看原始资料</text></svg>`,
        );
    },
  );
  app.post("/api/reports/read", async (req) => {
    const { url } = z.object({ url: z.url().max(2000) }).parse(req.body);
    return fetchPublicReport(url);
  });
  const staticDir = options.staticDir ?? resolve("dist/web");
  if (existsSync(staticDir)) {
    await app.register(staticPlugin, {
      root: staticDir,
      index: "index.html",
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "接口不存在" })
        : reply.sendFile("index.html"),
    );
  }
  const tick = setInterval(() => {
    const cfg = settings(store);
    if (!cfg.monitoring || monitor.running) return;
    const heldCodes = new Set(
      snapshot(store, now()).positions.map((p) => p.code),
    );
    const active = store
      .list<Instrument>("instruments")
      .some(
        (i) =>
          (i.watched || heldCodes.has(i.code)) &&
          tradeWindow(i, cfg, now()).open,
      );
    const age =
      now().getTime() - Date.parse(monitor.lastRefresh ?? "1970-01-01");
    if (age >= (active ? monitor.intervalSeconds : 3600) * 1000)
      void refresh(undefined, true).catch(
        (e) => (monitor.errors = [safeError(e)]),
      );
  }, 15000);
  tick.unref();
  app.addHook("onClose", async () => {
    clearInterval(tick);
  });
  return { app, store, ai, token, refresh, product };
}
