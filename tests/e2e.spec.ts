import { test, expect, type Page } from "@playwright/test";
import { buildApp } from "../src/server/app.js";
import { Store } from "../src/server/store.js";
import { AiService } from "../src/server/ai.js";
import type { AppState, TransactionKind } from "../src/shared/types.js";

// Production HTTP app, ledger, SQLite and built browser UI run together.
// CI uses an explicitly unavailable data provider (never synthetic NAVs).
// FINANCE_LIVE_DATA=1 additionally exercises public free providers.
// An isolated in-memory account and keyProvider prevent access to personal data
// and any real API credentials or paid AI requests.
const token = "finance-e2e-in-memory-session";
let server: Awaited<ReturnType<typeof buildApp>>;

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const store = new Store(":memory:");
  server = await buildApp({
    store,
    token,
    port: 4321,
    ai: new AiService(store, { keyProvider: () => undefined }),
    ...(process.env.FINANCE_LIVE_DATA === "1"
      ? {}
      : {
          fetchProduct: async (instrument) => ({
            instrument,
            history: [],
            exposures: [],
            documents: [],
            errors: ["自动化测试未连接外部数据源"],
            fetchedAt: new Date().toISOString(),
          }),
          fetchCatalog: async () => [],
          fetchNews: async () => ({
            documents: [],
            errors: ["自动化测试未连接外部新闻源"],
            fetchedAt: new Date().toISOString(),
          }),
        }),
  });
  await server.app.listen({ host: "127.0.0.1", port: 4321 });
});
test.afterAll(async () => {
  await server?.app.close();
  server?.store.close();
});

async function open(page: Page) {
  await page.goto(`/#token=${token}`);
  await expect(
    page.getByRole("heading", { name: "让每一次决策，有据可依。" }),
  ).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);
}
async function state(page: Page): Promise<AppState> {
  return (await page.request.get("/api/state")).json();
}
async function record(
  page: Page,
  kind: TransactionKind,
  fields: Record<string, string>,
) {
  await page.getByRole("button", { name: "记一笔", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "记一笔真实记录" });
  await modal.getByLabel("记录类型", { exact: true }).selectOption(kind);
  if (fields.parent) {
    await modal
      .getByLabel("关联原申请", { exact: false })
      .selectOption(fields.parent);
  }
  for (const [label, value] of Object.entries(fields)) {
    if (label === "parent") continue;
    await modal.getByLabel(label, { exact: true }).fill(value);
  }
  await modal.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(modal).not.toBeVisible();
}

test("local authentication, real empty onboarding and source-backed charts", async ({
  page,
  request,
}) => {
  expect((await request.get("/api/state")).status()).toBe(401);
  await open(page);
  const initial = await state(page);
  expect(initial.snapshot.positions).toHaveLength(0);
  expect(initial.snapshot.totalValue).toBe("0.00");
  expect(initial.watched.length).toBeGreaterThanOrEqual(6);
  expect(initial.settings.apiEnabled).toBe(false);
  expect(Number(initial.budget.spent)).toBe(0);
  await expect(page.getByText("从你的第一笔真实记录开始")).toBeVisible();
  expect(
    (await page.request.post("/api/transactions", { data: {} })).status(),
  ).toBe(403);

  // Public internet availability is not assumed: either the actual chart or
  // an explicit unavailable state must appear; data-contract tests cover NAVs.
  await expect(page.locator(".chart-panel .loading-line")).toHaveCount(0, {
    timeout: 60000,
  });
  await page.screenshot({
    path: `/tmp/finance-overview-${process.env.FINANCE_LIVE_DATA === "1" ? "live" : "offline"}-dark.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "监控中心", exact: true }).click();
  await expect(page.getByText(/ChatGPT 手机通知待完成/)).toBeVisible();
  await expect(page.getByText("暂时没有满足条件的提醒")).toBeVisible();
});

test("deposit, buy, reverse and plan creation update the actual ledger", async ({
  page,
}) => {
  await open(page);
  const code = (await state(page)).watched[0].code;
  await record(page, "deposit", { 金额: "10000", 账户名称: "测试账户" });
  expect((await state(page)).snapshot.cash.CNY).toBe("10000");
  await record(page, "buy", {
    金额: "1000",
    "份额 / 数量": "500",
    产品代码: code,
    账户名称: "测试账户",
  });
  expect((await state(page)).snapshot.positions[0].quantity).toBe("500");
  expect((await state(page)).snapshot.cash.CNY).toBe("9000");
  await page.getByRole("button", { name: "收益与账本", exact: true }).click();
  await page.getByRole("button", { name: /撤销.*买入成交/ }).click();
  await expect
    .poll(async () => (await state(page)).snapshot.positions.length)
    .toBe(0);
  expect((await state(page)).snapshot.cash.CNY).toBe("10000");
  await expect(page.getByText("已冲销", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "新增计划", exact: true }).click();
  const plan = page.getByRole("dialog", { name: "建立投资计划" });
  await plan.getByLabel("每次计划金额", { exact: true }).fill("300");
  await plan.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(plan).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "暂停计划", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂停计划", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "恢复计划", exact: true }),
  ).toBeVisible();
});

test("fund application, confirmation and settlement are separate ledger actions", async ({
  page,
}) => {
  await open(page);
  const code = (await state(page)).watched[0].code;
  await record(page, "subscribe", {
    金额: "1000",
    产品代码: code,
    账户名称: "测试账户",
  });
  expect((await state(page)).snapshot.frozen.CNY).toBe("1000");
  let txs = (await (await page.request.get("/api/transactions")).json()).items;
  await record(page, "confirm", {
    parent: txs.find((t: { kind: string }) => t.kind === "subscribe").id,
    金额: "1000",
    "份额 / 数量": "500",
  });
  expect((await state(page)).snapshot.positions[0].quantity).toBe("500");
  expect((await state(page)).snapshot.frozen.CNY).toBe("0");
  await record(page, "redeem", {
    金额: "0",
    "份额 / 数量": "100",
    产品代码: code,
    账户名称: "测试账户",
  });
  txs = (await (await page.request.get("/api/transactions")).json()).items;
  await record(page, "confirm", {
    parent: txs.find((t: { kind: string }) => t.kind === "redeem").id,
    金额: "110",
    "份额 / 数量": "100",
  });
  expect((await state(page)).snapshot.receivables.CNY).toBe("110");
  txs = (await (await page.request.get("/api/transactions")).json()).items;
  await record(page, "settle", {
    parent: txs.find((t: { kind: string }) => t.kind === "confirm").id,
  });
  expect((await state(page)).snapshot.receivables.CNY).toBe("0");
  expect((await state(page)).snapshot.cash.CNY).toBe("9110");
  await expect(
    page.getByRole("heading", { name: "组合底层暴露与重复持有" }),
  ).toBeVisible();
  await expect(page.getByText("已解析投资金额", { exact: true })).toBeVisible();
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "组合底层暴露与重复持有" }),
    })
    .screenshot({
      path: "/tmp/finance-portfolio-exposure.png",
      animations: "disabled",
    });
});

test("risk settings, prompt version, product rules and theme persist", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "偏好设置", exact: true }).click();
  await page.getByLabel("最低现金保留（CNY）", { exact: true }).fill("2000");
  await page
    .getByLabel("单笔交易金额上限（CNY）", { exact: true })
    .fill("1000");
  await page.getByRole("switch", { name: /确认使用上述资金约束/ }).check();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).settings.risk.configured)
    .toBe(true);
  const prompt = page.getByRole("textbox", { name: "编辑模型指令" });
  await expect(prompt).not.toHaveValue("");
  const original = await prompt.inputValue();
  await prompt.fill(original + "\n明确列出缺失数据。");
  await page.getByRole("button", { name: "保存指令版本", exact: true }).click();
  await expect(
    page.getByLabel("选择指令").locator('option[value="brief"]'),
  ).toContainText("v2");
  await page
    .getByRole("button", { name: "查看发送上下文", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "发送上下文预览" }),
  ).toContainText("instructions");
  await page.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(prompt).toHaveValue(original);
  await page.getByLabel("选择指令").selectOption("boundary");
  await expect(prompt).toHaveAttribute("readonly", "");
  await expect(
    page.getByRole("button", { name: "保存指令版本", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "切换浅色模式", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: "/tmp/finance-settings-light.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.getByRole("button", { name: "产品与持仓", exact: true }).click();
  await expect(page.getByText("我的可投资渠道与交易规则")).toBeVisible({
    timeout: 60000,
  });
  await page.getByText("我的可投资渠道与交易规则").click();
  await page.getByLabel("购买渠道", { exact: true }).fill("个人已核验渠道");
  await page.getByLabel("最低买入金额（CNY）", { exact: true }).fill("10");
  await page.getByLabel("最小份额 / 交易单位", { exact: true }).fill("0.01");
  await page.getByRole("switch", { name: /我的账户可买入此产品/ }).check();
  await page.getByRole("switch", { name: /已核对以上交易规则/ }).check();
  await page.getByRole("button", { name: "保存交易规则", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).watched[0].rulesVerified)
    .toBe(true);
  await page.getByRole("button", { name: "综合评级", exact: true }).click();
  await expect(page.locator(".score-number")).toContainText("—");
  expect((await state(page)).settings.apiEnabled).toBe(false);
  expect(Number((await state(page)).budget.spent)).toBe(0);
});

test("mobile navigation and session-only assistant remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  await page.getByRole("button", { name: "研究助手", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "研究助手", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "发送给研究助手的信息" }),
  ).toBeDisabled();
  await expect(page.getByText(/不建立长期用户记忆/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/finance-assistant-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});
