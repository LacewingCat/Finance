import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  ExternalLink,
  Eye,
  FileText,
  Globe2,
  LayoutDashboard,
  Loader2,
  LockKeyhole,
  Menu,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  TrendingUp,
  Undo2,
  Wallet,
  X,
} from "lucide-react";
import type {
  AppSettings,
  AppState,
  Brief,
  DecisionResult,
  DocumentCard,
  Instrument,
  InvestmentPlan,
  LedgerTransaction,
  ProductData,
  PromptTemplate,
  TransactionInput,
  TransactionKind,
} from "../shared/types";
import {
  ApiError,
  dateTime,
  kindLabel,
  money,
  number,
  percent,
  request,
  setCsrf,
  transactionLabel,
} from "./api";
import { AllocationChart, NavChart } from "./charts";
import { Decimal } from "decimal.js";

const nav = [
  { id: "overview", label: "资产总览", icon: LayoutDashboard },
  { id: "products", label: "产品与持仓", icon: Wallet },
  { id: "performance", label: "收益与账本", icon: TrendingUp },
  { id: "assistant", label: "研究助手", icon: MessageSquare },
  { id: "monitor", label: "监控中心", icon: Activity },
  { id: "settings", label: "偏好设置", icon: Settings2 },
] as const;
type View = (typeof nav)[number]["id"];
type Toast = { text: string; error?: boolean };
type Message = {
  role: "user" | "assistant";
  content: string;
  receipts?: unknown[];
};
const colors = [
  "#a9e4c8",
  "#739bc8",
  "#bba4d9",
  "#c6b98d",
  "#6ebfc1",
  "#73867c",
];
const today = () =>
  new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请稍后重试。";
const isPositive = (value?: string | null) =>
  value != null && Number(value) >= 0;
const shorten = (text: string, length = 75) =>
  text.length > length ? `${text.slice(0, length)}…` : text;
function externalUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function convertedValue(
  values: Record<string, string>,
  settings: AppSettings,
): number | null {
  let total = new Decimal(0);
  for (const [currency, value] of Object.entries(values)) {
    if (new Decimal(value).isZero()) continue;
    const rate = settings.fxRates[currency];
    const asOf = Date.parse(settings.fxAsOf);
    const datePart = settings.fxAsOf.slice(0, 10),
      dateTimestamp = Date.parse(datePart);
    if (
      !rate ||
      (currency !== "CNY" &&
        (!settings.fxAsOf ||
          !Number.isFinite(asOf) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(datePart) ||
          !Number.isFinite(dateTimestamp) ||
          new Date(dateTimestamp).toISOString().slice(0, 10) !== datePart ||
          asOf > Date.now() ||
          Date.now() - asOf > 4 * 86400000))
    )
      return null;
    total = total.plus(new Decimal(value).times(rate));
  }
  return total.toNumber();
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber" | "blue";
}) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
function Empty({
  icon = <Database size={23} />,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{text}</p>
      {action}
    </div>
  );
}
function SectionTitle({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}
function Loading({ text = "正在读取本地数据" }: { text?: string }) {
  return (
    <div className="loading-line">
      <Loader2 className="spin" size={17} />
      {text}
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const connect = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (node) => {
      if (!isValidElement(node)) return node;
      const element = node as ReactElement<{
        children?: ReactNode;
        id?: string;
        "aria-labelledby"?: string;
        "aria-describedby"?: string;
      }>;
      if (
        typeof element.type === "string" &&
        ["input", "select", "textarea"].includes(element.type)
      )
        return cloneElement(element, {
          id,
          "aria-labelledby": `${id}-label`,
          "aria-describedby": hint ? `${id}-hint` : undefined,
        });
      return element.props.children
        ? cloneElement(element, {}, connect(element.props.children))
        : element;
    });
  return (
    <label className="field" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      {connect(children)}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </label>
  );
}

function SourceCards({
  documents,
  limit = 3,
}: {
  documents: DocumentCard[];
  limit?: number;
}) {
  if (!documents.length)
    return (
      <div className="quiet-empty">
        <FileText size={17} />
        <span>完成产品同步后，相关资料会显示在这里。</span>
      </div>
    );
  return (
    <div className="source-grid">
      {documents.slice(0, limit).map((doc) => (
        <a
          key={doc.id}
          className="source-card"
          href={externalUrl(doc.url)}
          target="_blank"
          rel="noopener noreferrer"
        >
          <div className="source-image">
            <img
              src={`/api/preview/${encodeURIComponent(doc.id)}`}
              alt={`${doc.source} · ${doc.title}资料预览`}
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
            <span className="source-image-fallback">
              <FileText size={28} />
              <span>{doc.source}</span>
            </span>
            <span className="source-kind">
              {doc.category === "news"
                ? "市场资讯"
                : doc.category === "report"
                  ? "公开报告"
                  : "产品资料"}
            </span>
          </div>
          <div className="source-body">
            <div className="source-meta">
              <span>{doc.source}</span>
              <span>
                {doc.publishedAt ? dateTime(doc.publishedAt, true) : "公开资料"}
              </span>
            </div>
            <h3>{doc.title}</h3>
            <span className="source-link">
              查看原始资料 <ArrowUpRight size={14} />
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}

function DecisionIndicators({
  decision,
  mode = "probability",
}: {
  decision?: DecisionResult;
  mode?: "probability" | "rating";
}) {
  const valid = decision?.status === "valid";
  const p = (v: number | null | undefined) =>
    valid && v != null ? `${(v * 100).toFixed(1)}%` : "—";
  return (
    <div className="decision-box">
      <div className="decision-values">
        {mode === "probability" ? (
          <>
            <div>
              <span>
                <i className="dot green" /> Buy
              </span>
              <b>{p(decision?.buy)}</b>
            </div>
            <div>
              <span>
                <i className="dot rose" /> Sell
              </span>
              <b>{p(decision?.sell)}</b>
            </div>
            <div>
              <span>
                <i className="dot blue" /> Hold
              </span>
              <b>{p(decision?.hold)}</b>
            </div>
          </>
        ) : (
          <div className="score-number">
            <span>综合评级</span>
            <b>
              {valid && decision?.score != null
                ? number(decision.score, 1)
                : "—"}
              <small> / 10</small>
            </b>
          </div>
        )}
        <div className="confidence">
          <span>
            置信度 <CircleHelp size={12} />
          </span>
          <b>{p(decision?.confidence)}</b>
        </div>
      </div>
      <p>
        {valid
          ? `交易日内行动偏好 · ${dateTime(decision?.generatedAt)}，并非盈利概率`
          : decision?.reason || "完成数据同步并启用 API 后评估，尚无有效决策。"}
      </p>
    </div>
  );
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [view, setView] = useState<View>("overview");
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState<Record<string, ProductData>>({});
  const [selected, setSelected] = useState("");
  const [productLoading, setProductLoading] = useState<string | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [revision, setRevision] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const startup = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((text: string, error = false) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 8000 : 4500);
  }, []);

  const loadState = useCallback(async () => {
    try {
      const next = await request<AppState>("/api/state");
      setState(next);
      setConnectionError("");
      setSelected(
        (previous) =>
          previous ||
          next.watched[0]?.code ||
          next.snapshot.positions[0]?.code ||
          "",
      );
      return next;
    } catch (error) {
      setConnectionError(errorText(error));
      if (error instanceof ApiError && error.status === 401)
        setAuthenticated(false);
      throw error;
    }
  }, []);

  const loadProduct = useCallback(
    async (code: string, force = false) => {
      if (!code) return;
      if (!force && products[code]) return;
      setProductLoading(code);
      try {
        const result = await request<ProductData>(
          `/api/products/${encodeURIComponent(code)}`,
        );
        setProducts((previous) => ({ ...previous, [code]: result }));
      } catch (error) {
        notify(errorText(error), true);
      } finally {
        setProductLoading((previous) => (previous === code ? null : previous));
      }
    },
    [products, notify],
  );

  const refresh = useCallback(
    async (includeBrief = true, code?: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await request("/api/refresh", "POST", code ? { code } : {});
        const next = await loadState();
        setRevision((value) => value + 1);
        setProducts({});
        if (
          includeBrief &&
          next.settings.apiEnabled &&
          next.keyConfigured &&
          next.settings.allowedRead
        ) {
          await request<Brief>("/api/brief", "POST", {});
          await loadState();
        }
        notify("已检查最新可得数据；各产品以披露日期为准。");
      } catch (error) {
        notify(errorText(error), true);
      } finally {
        setBusy(false);
      }
    },
    [busy, loadState, notify],
  );

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const params = new URLSearchParams(location.hash.slice(1));
        const token = params.get("token");
        if (token) {
          history.replaceState(null, "", location.pathname + location.search);
          const session = await request<{
            authenticated: boolean;
            csrf?: string;
          }>("/api/session", "POST", { token });
          if (session.csrf) setCsrf(session.csrf);
        }
        const session = await request<{
          authenticated: boolean;
          csrf?: string;
        }>("/api/session");
        if (session.csrf) setCsrf(session.csrf);
        if (cancelled) return;
        setAuthenticated(session.authenticated);
        if (session.authenticated) await loadState();
      } catch (error) {
        if (!cancelled) {
          setAuthenticated(false);
          notify(errorText(error), true);
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [loadState, notify]);

  useEffect(() => {
    if (!authenticated || !state || startup.current) return;
    startup.current = true;
    void refresh(true);
  }, [authenticated, state, refresh]);

  useEffect(() => {
    if (!authenticated) return;
    const timer = setInterval(() => {
      void loadState().catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, [authenticated, loadState]);

  useEffect(() => {
    if (selected && authenticated) void loadProduct(selected);
  }, [selected, authenticated, loadProduct]);
  useEffect(() => {
    document.documentElement.dataset.theme = state?.settings.theme || "dark";
  }, [state?.settings.theme]);

  const mutate = useCallback(
    async (
      path: string,
      method: string,
      body?: unknown,
      success = "已保存",
    ) => {
      try {
        const result = await request(path, method, body);
        await loadState();
        setRevision((v) => v + 1);
        notify(success);
        return result;
      } catch (error) {
        notify(errorText(error), true);
        throw error;
      }
    },
    [loadState, notify],
  );
  const goto = (next: View) => {
    setView(next);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (authenticated === null)
    return (
      <div className="boot-screen">
        <Brand />
        <Loading />
      </div>
    );
  if (!authenticated)
    return (
      <>
        <Login
          onSuccess={async () => {
            setAuthenticated(true);
            await loadState();
          }}
          notify={notify}
        />
        {toast && <ToastView toast={toast} close={() => setToast(null)} />}
      </>
    );
  if (!state)
    return (
      <div className="boot-screen">
        <Brand />
        <Loading />
        <button
          className="text-button"
          onClick={() =>
            void loadState().catch((error) => notify(errorText(error), true))
          }
        >
          重新读取
        </button>
        {toast && <ToastView toast={toast} close={() => setToast(null)} />}
      </div>
    );

  const light = state.settings.theme === "light";
  const product = products[selected];
  const pageTitle = nav.find((item) => item.id === view)!.label;
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <Brand />
        <div className="workspace-chip">
          <div className="avatar">
            <span>L</span>
          </div>
          <div>
            <b>我的投资工作台</b>
            <span>个人空间 · 本地运行</span>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-eyebrow">WORKSPACE</span>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => goto(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <item.icon size={18} strokeWidth={1.6} />
              <span>{item.label}</span>
              {item.id === "monitor" &&
                state.alerts.filter(
                  (a) => a.status === "local" || a.status === "queued",
                ).length > 0 && (
                  <span className="nav-count">
                    {
                      state.alerts.filter(
                        (a) => a.status === "local" || a.status === "queued",
                      ).length
                    }
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-budget" title={state.budget.reason}>
            <span>
              本月 API 费用 <b>{money(state.budget.spent, "USD")}</b>
            </span>
            <span>
              可用预算 <b>{money(state.budget.remaining, "USD")}</b>
            </span>
          </div>
          <div className="privacy-box">
            <ShieldCheck size={18} />
            <b>数据属于你</b>
            <p>
              持仓与账本保存在这台 Mac，
              <br />
              仅向你授权的 API 发送。
            </p>
            <span>
              <i className="status-dot" />
              本地私有连接
            </span>
          </div>
          <button className="sidebar-help" onClick={() => goto("settings")}>
            <CircleHelp size={16} />
            权限与数据设置
            <ArrowUpRight size={14} />
          </button>
          <div className="version">
            FINANCE <span>v0.1 · OPEN SOURCE</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="打开导航"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={20} />
            </button>
            <span>个人空间</span>
            <ChevronRight size={14} />
            <b>{pageTitle}</b>
          </div>
          <div className="topbar-actions">
            <span className="local-status">
              <i className="status-dot" />
              本地工作台
            </span>
            <button
              className="icon-button"
              aria-label={light ? "切换深色模式" : "切换浅色模式"}
              onClick={() =>
                void mutate(
                  "/api/settings",
                  "PATCH",
                  { theme: light ? "dark" : "light" },
                  "已更新显示主题",
                ).catch(() => {})
              }
            >
              {light ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <button
              className="icon-button"
              aria-label="查看监控提醒"
              onClick={() => goto("monitor")}
            >
              <Bell size={18} />
              {state.alerts.length > 0 && <i className="notification-dot" />}
            </button>
            <span className="profile-avatar">L</span>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR CAPITAL, IN PERSPECTIVE</div>
              <h1>
                {view === "overview" ? "让每一次决策，有据可依。" : pageTitle}
              </h1>
              <p>
                {view === "overview"
                  ? "看清资产全貌，理解收益来源，在自己的节奏里投资。"
                  : view === "products"
                    ? "从产品到持仓，从净值到真实的底层资产。"
                    : view === "performance"
                      ? "每一笔资金流动都有记录，每一份收益都能追溯。"
                      : view === "assistant"
                        ? "基于你的真实数据与公开资料，保持理性讨论。"
                        : view === "monitor"
                          ? "让条件触发提醒，把最终决策留给你。"
                          : "模型、预算、权限与研究指令，都由你掌控。"}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => void refresh()}
                disabled={busy}
              >
                <RefreshCw size={15} className={busy ? "spin" : ""} />
                {busy ? "正在同步" : "刷新数据"}
              </button>
              <button
                className="button primary"
                onClick={() => setRecordOpen(true)}
              >
                <Plus size={16} />
                记一笔
              </button>
            </div>
          </div>
          {connectionError && (
            <div role="alert" className="notice amber">
              <CircleHelp size={16} />
              <span>
                本地数据读取中断，当前展示上次读取的快照。请检查本机服务并刷新：
                {connectionError}
              </span>
            </div>
          )}
          {state.snapshot.warnings.length > 0 && (
            <div className="notice amber">
              <CircleHelp size={16} />
              <span>{state.snapshot.warnings.join("；")}</span>
            </div>
          )}
          {view === "overview" && (
            <Overview
              state={state}
              product={product}
              selected={selected}
              select={setSelected}
              loading={productLoading === selected}
              light={light}
              goto={goto}
              record={() => setRecordOpen(true)}
            />
          )}
          {view === "products" && (
            <Products
              state={state}
              product={product}
              selected={selected}
              select={setSelected}
              loading={productLoading === selected}
              light={light}
              mutate={mutate}
              refresh={refresh}
              notify={notify}
              record={() => setRecordOpen(true)}
            />
          )}
          {view === "performance" && (
            <Performance
              state={state}
              revision={revision}
              mutate={mutate}
              notify={notify}
              record={() => setRecordOpen(true)}
            />
          )}
          {view === "assistant" && (
            <Assistant
              state={state}
              messages={messages}
              setMessages={setMessages}
              onChange={loadState}
              notify={notify}
            />
          )}
          {view === "monitor" && <Monitor state={state} mutate={mutate} />}
          {view === "settings" && (
            <Settings state={state} mutate={mutate} notify={notify} />
          )}
          <footer className="footer">
            <span>
              <LockKeyhole size={12} />
              个人数据本地保存
            </span>
            <span>
              最后检查 {dateTime(state.monitor.lastRefresh)} · 时间均为北京时间
            </span>
            <span>研究辅助工具 · 交易由你确认执行</span>
          </footer>
        </main>
      </div>
      {recordOpen && (
        <TransactionModal
          initialCode={selected}
          watched={state.watched}
          onClose={() => setRecordOpen(false)}
          onSave={async (input) => {
            await mutate(
              "/api/transactions",
              "POST",
              input,
              "已记入账本，可在收益与账本中撤销。",
            );
            setRecordOpen(false);
          }}
        />
      )}
      {toast && <ToastView toast={toast} close={() => setToast(null)} />}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <i />
        <i />
        <i />
      </span>
      <span>
        finance<span className="brand-period">.</span>
      </span>
    </div>
  );
}
function ToastView({ toast, close }: { toast: Toast; close: () => void }) {
  return (
    <div
      role={toast.error ? "alert" : "status"}
      className={`toast ${toast.error ? "toast-error" : ""}`}
    >
      {toast.error ? <CircleHelp size={18} /> : <CheckCircle2 size={18} />}
      <span>{toast.text}</span>
      <button className="icon-button" aria-label="关闭提示" onClick={close}>
        <X size={15} />
      </button>
    </div>
  );
}

function Login({
  onSuccess,
  notify,
}: {
  onSuccess: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const session = await request<{ authenticated: boolean; csrf?: string }>(
        "/api/session",
        "POST",
        { token },
      );
      if (!session.authenticated) throw new Error("访问令牌无效。");
      setCsrf(session.csrf || "");
      setToken("");
      await onSuccess();
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-screen">
      <div className="login-decoration">
        <div />
        <div />
        <div />
      </div>
      <div className="login-card">
        <Brand />
        <span className="eyebrow">YOUR PRIVATE FINANCIAL WORKSPACE</span>
        <h1>
          你的资产，
          <br />
          你的掌控。
        </h1>
        <p>
          使用本机启动时提供的访问链接打开工作台，或输入本机服务的访问令牌。
        </p>
        <form onSubmit={submit}>
          <Field label="本地访问令牌">
            <input
              autoComplete="off"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="输入本机服务的访问令牌"
              required
            />
          </Field>
          <button className="button primary" disabled={busy || !token}>
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <LockKeyhole size={16} />
            )}
            进入工作台
            <ArrowRight size={16} />
          </button>
        </form>
        <div className="login-note">
          <ShieldCheck size={16} />
          此处不是 OpenAI API Key，也不是银行密码。
        </div>
      </div>
    </div>
  );
}

function Overview({
  state,
  product,
  selected,
  select,
  loading,
  light,
  goto,
  record,
}: {
  state: AppState;
  product?: ProductData;
  selected: string;
  select: (code: string) => void;
  loading: boolean;
  light: boolean;
  goto: (view: View) => void;
  record: () => void;
}) {
  const snapshot = state.snapshot;
  const values =
    snapshot.totalValue === null
      ? []
      : snapshot.positions
          .filter((p) => p.marketValue && Number(p.marketValue) > 0)
          .map((p) => ({
            name: p.name,
            value: convertedValue(
              { [p.currency]: p.marketValue! },
              state.settings,
            )!,
          }));
  const cash = convertedValue(snapshot.cash, state.settings);
  if (snapshot.totalValue !== null)
    for (const [name, balances] of [
      ["可用现金", snapshot.cash],
      ["申购在途", snapshot.frozen],
      ["待到账资金", snapshot.receivables],
    ] as const) {
      const value = convertedValue(balances, state.settings);
      if (value !== null && value > 0) values.push({ name, value });
    }
  const decision = state.decisions.find((d) => d.code === selected);
  return (
    <>
      <div className="metrics-grid">
        <div className="metric-card metric-primary">
          <div className="metric-label">
            总资产估值 <Eye size={14} />
            <span>CNY</span>
          </div>
          <div className="metric-value">{money(snapshot.totalValue)}</div>
          <div className="metric-detail">
            <span>现金 + 持仓 + 在途资金</span>
            <span className="mini-arrow">
              <ArrowUpRight size={15} />
            </span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            累计盈亏 <TrendingUp size={15} />
          </div>
          <div
            className={`metric-value ${snapshot.totalPnl == null ? "" : isPositive(snapshot.totalPnl) ? "text-green" : "text-rose"}`}
          >
            {money(snapshot.totalPnl)}
          </div>
          <div className="metric-detail">
            <span>含资产变动、分红与费用</span>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            可用现金 <Wallet size={15} />
          </div>
          <div className="metric-value">{money(cash)}</div>
          <div className="metric-detail">
            <span>保留现金底线</span>
            <b>
              {state.settings.risk.configured
                ? money(state.settings.risk.minimumCash)
                : "待设置"}
            </b>
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            持有产品 <Database size={15} />
          </div>
          <div className="metric-value">
            {snapshot.positions.length}
            <small> 项</small>
          </div>
          <div className="metric-detail">
            <span>
              另有{" "}
              {
                state.watched.filter(
                  (item) =>
                    !snapshot.positions.some(
                      (position) => position.code === item.code,
                    ),
                ).length
              }{" "}
              项参考产品
            </span>
            <button onClick={() => goto("products")} className="text-button">
              查看 <ArrowRight size={13} />
            </button>
          </div>
        </div>
      </div>
      {!snapshot.positions.length && cash === 0 && (
        <div className="onboarding-banner">
          <span className="onboarding-icon">
            <Wallet size={22} />
          </span>
          <div>
            <b>从你的第一笔真实记录开始</b>
            <p>
              先记入可用资金或已有持仓。下方参考产品用于研究，不代表你已持有。
            </p>
          </div>
          <button className="button secondary" onClick={record}>
            建立我的账本
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      <div className="overview-main-grid">
        <section className="panel chart-panel">
          <SectionTitle
            eyebrow="MARKET OBSERVATION"
            title="把波动放回时间里"
            action={
              <Pill tone="green">
                <i className="status-dot" />
                真实披露数据
              </Pill>
            }
          />
          <div className="chart-toolbar">
            <select
              aria-label="选择参考产品"
              value={selected}
              onChange={(e) => select(e.target.value)}
            >
              {state.watched.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </select>
            <span className="subtle-label">
              {product?.historyKind === "trade" ? "日收盘价" : "单位净值"} ·
              最近一年
            </span>
          </div>
          <div className="nav-quote">
            <strong>
              {product?.observation
                ? number(product.observation.price, 4)
                : "—"}
            </strong>
            <span
              className={
                isPositive(product?.observation?.changePct)
                  ? "text-green"
                  : "text-rose"
              }
            >
              {percent(product?.observation?.changePct, true)}
            </span>
            <span className="quote-date">
              {product?.observation?.asOf
                ? product.observation.priceKind === "trade"
                  ? `报价时间 ${dateTime(product.observation.asOf)}`
                  : `净值日期 ${product.observation.asOf.slice(0, 10)}`
                : "等待首次同步"}
            </span>
          </div>
          {loading && !product ? (
            <Loading text="正在读取参考产品" />
          ) : product?.history.length ? (
            <NavChart
              history={product.history.slice(-250)}
              light={light}
              seriesLabel={
                product.historyKind === "trade" ? "日收盘价" : "单位净值"
              }
            />
          ) : (
            <Empty
              icon={<TrendingUp size={23} />}
              title="让真实数据绘出曲线"
              text="同步完成后展示该产品的可核实历史数据，不使用模拟行情。"
            />
          )}
          <div className="chart-bottom-note">
            <span>
              <i className="dot green" />
              {product?.instrument.name || "参考产品"}
            </span>
            <span>历史数据不代表未来收益</span>
          </div>
        </section>
        <section className="panel allocation-panel">
          <SectionTitle
            eyebrow="ASSET ALLOCATION"
            title="资产配置"
            action={
              <button
                className="icon-button"
                aria-label="查看全部持仓"
                onClick={() => goto("products")}
              >
                <ArrowUpRight size={17} />
              </button>
            }
          />
          {values.length ? (
            <>
              <div className="allocation-visual">
                <AllocationChart values={values} light={light} />
                <div>
                  <span>资产类别</span>
                  <strong>{values.length}</strong>
                  <small>项配置</small>
                </div>
              </div>
              <div className="allocation-legend">
                {values.slice(0, 5).map((item, index) => (
                  <div key={item.name}>
                    <span>
                      <i
                        style={{ background: colors[index % colors.length] }}
                      />
                      {shorten(item.name, 14)}
                    </span>
                    <b>
                      {percent(
                        (item.value / values.reduce((s, x) => s + x.value, 0)) *
                          100,
                      )}
                    </b>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="allocation-placeholder">
                <div>
                  <Wallet size={24} />
                  <b>
                    {snapshot.totalValue === null
                      ? "等待完整估值"
                      : "等待资产记录"}
                  </b>
                  <span>
                    {snapshot.totalValue === null
                      ? "请补齐价格或有效汇率"
                      : "建立账本后自动生成"}
                  </span>
                </div>
              </div>
              <div className="quiet-note">
                配置比例按实际持仓与现金计算，
                <br />
                参考产品不会计入你的资产。
              </div>
            </>
          )}
          <button
            className="full-width text-button allocation-link"
            onClick={() => goto("performance")}
          >
            查看资产流水
            <ArrowRight size={14} />
          </button>
        </section>
      </div>
      <div className="insights-grid">
        <section className="panel brief-panel">
          <SectionTitle
            eyebrow="AI RESEARCH BRIEF"
            title="今日研究简报"
            action={
              <span className="ai-badge">
                <Sparkles size={13} />
                AI 辅助
              </span>
            }
          />
          <BriefContent
            brief={state.brief}
            enabled={state.settings.apiEnabled}
          />
          <div className="brief-footer">
            <span>
              {state.brief?.createdAt
                ? dateTime(state.brief.createdAt)
                : "等待你的数据与模型配置"}
            </span>
            <button
              className="text-button"
              onClick={() =>
                goto(state.settings.apiEnabled ? "assistant" : "settings")
              }
            >
              {state.settings.apiEnabled ? "继续讨论" : "配置研究助手"}
              <ArrowUpRight size={14} />
            </button>
          </div>
        </section>
        <section className="panel decision-panel">
          <SectionTitle
            eyebrow="DECISION SIGNAL"
            title="日内决策观察"
            action={<Pill>Decisions API</Pill>}
          />
          <div className="decision-product">
            <span>{product?.instrument.name || "当前参考产品"}</span>
            <small>{selected}</small>
          </div>
          <DecisionIndicators decision={decision} />
          <div className="decision-note">
            <ShieldCheck size={15} />
            <span>信号与置信度分别展示，执行权始终在你。</span>
          </div>
        </section>
      </div>
      {snapshot.positions.length > 0 && (
        <PortfolioExposure snapshotId={snapshot.id} />
      )}
      <section className="sources-section">
        <SectionTitle
          eyebrow="READ THE SOURCE"
          title="相关资料，直达来源"
          action={
            <button className="text-button" onClick={() => goto("products")}>
              查看产品资料
              <ArrowRight size={14} />
            </button>
          }
        />
        <SourceCards
          documents={
            state.documents.length ? state.documents : product?.documents || []
          }
        />
      </section>
      <div className="bottom-strip">
        <span>
          <Globe2 size={16} />
          境内市场 · QDII · 全球资产视角
        </span>
        <span>
          <Database size={15} />
          {number(state.catalogCount, 0)} 条产品索引
        </span>
        <span>
          <ShieldCheck size={15} />
          原始数据与分析结果分开标注
        </span>
      </div>
    </>
  );
}

function PortfolioExposure({ snapshotId }: { snapshotId: string }) {
  const [data, setData] = useState<{
    items: {
      key: string;
      name: string;
      code?: string;
      weight: string;
      cnyValue: string;
      sources: { fundCode: string; reportDate: string; sourceUrl: string }[];
    }[];
    unresolvedValue: string | null;
    coveredValue: string | null;
    totalValue: string | null;
    reason: string;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void request<NonNullable<typeof data>>("/api/exposure/portfolio")
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotId]);
  return (
    <section className="panel">
      <SectionTitle
        eyebrow="PORTFOLIO LOOK THROUGH"
        title="组合底层暴露与重复持有"
        action={<Pill>仅真实持仓</Pill>}
      />
      <p className="section-description">
        权重以组合总资产为分母，包含现金与在途资金；同一已确认标的合并展示。基金叶节点不代表已穿透到下层资产。
      </p>
      {error ? (
        <p role="status" className="section-description">
          暂时无法读取组合穿透汇总：{error}
        </p>
      ) : !data ? (
        <Loading text="正在核对已披露的底层资产" />
      ) : (
        <>
          <div className="coverage-grid">
            <div>
              <span>已解析投资金额</span>
              <b>{money(data.coveredValue)}</b>
            </div>
            <div>
              <span>未解析投资金额</span>
              <b>{money(data.unresolvedValue)}</b>
            </div>
          </div>
          {data.items.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>已确认标的</th>
                    <th>组合权重</th>
                    <th>对应估值（CNY）</th>
                    <th>来源份额 / 报告期</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.slice(0, 10).map((item) => (
                    <tr key={item.key}>
                      <td>
                        <b>{item.name}</b>
                        <small>
                          {item.code || "未提供独立代码"}
                          {new Set(
                            item.sources.map((source) => source.fundCode),
                          ).size > 1
                            ? " · 多产品重复暴露"
                            : ""}
                        </small>
                      </td>
                      <td>{percent(item.weight)}</td>
                      <td>{money(item.cnyValue)}</td>
                      <td>
                        {!item.sources.length && (
                          <span className="muted">直接持有</span>
                        )}
                        {item.sources.map((source, index) => (
                          <a
                            className="exposure-source-link"
                            href={externalUrl(source.sourceUrl)}
                            target="_blank"
                            rel="noopener noreferrer"
                            key={`${source.fundCode}-${index}`}
                          >
                            {source.fundCode} · {source.reportDate}
                            <ArrowUpRight size={11} />
                          </a>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="quiet-note">
              尚无可核实的组合底层标的，不推测未披露资产。
            </div>
          )}
          <p className="section-description">
            {data.reason}
            {data.items.length > 10
              ? ` 显示估值最高的 10 项，共 ${data.items.length} 项。`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}

function BriefContent({ brief, enabled }: { brief?: Brief; enabled: boolean }) {
  return brief?.text ? (
    <div
      className={`brief-text ${brief.status !== "generated" ? "muted" : ""}`}
    >
      {brief.text}
    </div>
  ) : (
    <div className="brief-placeholder">
      <span className="sparkle-tile">
        <Sparkles size={21} />
      </span>
      <div>
        <h3>{enabled ? "研究助手正在等待有效数据" : "给研究一个清晰的起点"}</h3>
        <p>
          配置 API
          与预算后，每次打开工作台自动整理资产变化、相关资料和需要关注的问题。
        </p>
      </div>
    </div>
  );
}

type Mutate = (
  path: string,
  method: string,
  body?: unknown,
  success?: string,
) => Promise<unknown>;
function Products({
  state,
  product,
  selected,
  select,
  loading,
  light,
  mutate,
  refresh,
  notify,
  record,
}: {
  state: AppState;
  product?: ProductData;
  selected: string;
  select: (code: string) => void;
  loading: boolean;
  light: boolean;
  mutate: Mutate;
  refresh: (brief?: boolean, code?: string) => Promise<void>;
  notify: (text: string, error?: boolean) => void;
  record: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Instrument[]>([]);
  const [searching, setSearching] = useState(false);
  const [mode, setMode] = useState<"probability" | "rating">("probability");
  const [period, setPeriod] = useState<"3m" | "1y" | "all">("1y");
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await request<{ items: Instrument[] }>(
          `/api/instruments?q=${encodeURIComponent(query)}&limit=12`,
        );
        if (!cancelled) setResults(data.items);
      } catch (error) {
        if (!cancelled) notify(errorText(error), true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, notify]);
  const watched = state.watched;
  const history = product?.history || [];
  const points =
    period === "all" ? history : history.slice(period === "3m" ? -65 : -250);
  const decision = state.decisions.find((d) => d.code === selected);
  return (
    <div className="products-layout">
      <section className="panel product-list">
        <SectionTitle
          title="关注与持仓"
          action={<Pill>{watched.length}</Pill>}
        />
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索产品"
            placeholder="输入名称或基金代码"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              aria-label="清空搜索"
              className="icon-button"
              onClick={() => setQuery("")}
            >
              <X size={13} />
            </button>
          )}
        </div>
        {query ? (
          <div className="search-results">
            {searching && <Loading text="检索产品目录" />}
            {!searching && !results.length && (
              <div className="quiet-note">
                未找到匹配产品。可先在设置中同步产品目录。
              </div>
            )}
            {results.map((item) => (
              <div className="search-result" key={item.code}>
                <button
                  onClick={() => {
                    select(item.code);
                    setQuery("");
                  }}
                >
                  <b>{item.name}</b>
                  <span>
                    {item.code} · {kindLabel[item.kind]}
                  </span>
                </button>
                <button
                  className="icon-button"
                  aria-label={`关注${item.name}`}
                  disabled={watched.some((x) => x.code === item.code)}
                  onClick={() =>
                    void mutate(
                      "/api/watch",
                      "POST",
                      { code: item.code },
                      "已加入参考产品",
                    )
                      .then(() => {
                        select(item.code);
                        setQuery("");
                      })
                      .catch(() => {})
                  }
                >
                  {watched.some((x) => x.code === item.code) ? (
                    <Check size={16} />
                  ) : (
                    <Plus size={16} />
                  )}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="watch-list">
            {watched.map((item) => {
              const position = state.snapshot.positions.find(
                (p) => p.code === item.code,
              );
              return (
                <button
                  key={item.code}
                  className={`watch-item ${selected === item.code ? "selected" : ""}`}
                  onClick={() => select(item.code)}
                >
                  <span className={`product-monogram kind-${item.kind}`}>
                    {item.kind === "qdii" ? (
                      <Globe2 size={17} />
                    ) : item.kind === "stock" ? (
                      <TrendingUp size={17} />
                    ) : (
                      <span>{item.name.slice(0, 1)}</span>
                    )}
                  </span>
                  <span className="watch-item-body">
                    <b>{item.name}</b>
                    <span>
                      {item.code} <i>·</i> {kindLabel[item.kind]}
                    </span>
                  </span>
                  <span className="watch-item-state">
                    {position ? "持有" : "参考"}
                    <ChevronRight size={13} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <button
          className="button secondary full-width add-product-button"
          onClick={() => setAddOpen(true)}
        >
          <Plus size={14} />
          添加股票 / 其他产品
        </button>
        <div className="list-footnote">
          <Database size={14} />
          目录已收录 {number(state.catalogCount, 0)} 条代码记录
        </div>
      </section>
      <div className="product-detail">
        {loading && !product ? (
          <section className="panel">
            <Loading text="读取产品资料" />
          </section>
        ) : product ? (
          <>
            <section className="panel">
              <div className="product-heading">
                <div>
                  <div className="product-tags">
                    <Pill tone="blue">
                      {kindLabel[product.instrument.kind]}
                    </Pill>
                    <span>
                      {product.instrument.code} · {product.instrument.currency}
                    </span>
                    {state.snapshot.positions.some(
                      (p) => p.code === selected,
                    ) ? (
                      <Pill tone="green">已持有</Pill>
                    ) : (
                      <Pill>参考产品</Pill>
                    )}
                  </div>
                  <h2>{product.instrument.name}</h2>
                  <p>{product.instrument.manager || "管理人资料待核验"}</p>
                </div>
                <button className="button secondary compact" onClick={record}>
                  <Plus size={14} />
                  记录交易
                </button>
              </div>
              <div className="product-stats">
                <div>
                  <span>
                    {product.observation?.priceKind === "trade"
                      ? "最新参考价格"
                      : "最新披露净值"}
                  </span>
                  <strong>{number(product.observation?.price, 4)}</strong>
                  <small>
                    {product.observation?.priceKind === "trade"
                      ? dateTime(product.observation.asOf)
                      : product.observation?.asOf?.slice(0, 10) || "尚未同步"}
                  </small>
                </div>
                <div>
                  <span>单日变动</span>
                  <strong
                    className={
                      isPositive(product.observation?.changePct)
                        ? "text-green"
                        : "text-rose"
                    }
                  >
                    {percent(product.observation?.changePct, true)}
                  </strong>
                  <small>以来源披露口径为准</small>
                </div>
                <div>
                  <span>累计净值</span>
                  <strong>
                    {number(product.observation?.accumulatedNav, 4)}
                  </strong>
                  <small>{product.observation?.source || "等待数据源"}</small>
                </div>
                <div>
                  <span>数据状态</span>
                  <strong className="small-stat">
                    {product.observation?.quality === "valid"
                      ? "已同步"
                      : product.observation?.quality === "conflict"
                        ? "来源冲突"
                        : product.observation
                          ? "需核验"
                          : "待同步"}
                  </strong>
                  <small>检查于 {dateTime(product.fetchedAt)}</small>
                </div>
              </div>
              <div className="chart-toolbar">
                <h3>
                  {product.historyKind === "trade"
                    ? "历史日收盘价"
                    : "历史净值"}
                </h3>
                <div className="segmented" aria-label="走势时间范围">
                  {(["3m", "1y", "all"] as const).map((value) => (
                    <button
                      className={period === value ? "active" : ""}
                      key={value}
                      onClick={() => setPeriod(value)}
                    >
                      {value === "3m"
                        ? "近三月"
                        : value === "1y"
                          ? "近一年"
                          : "全部"}
                    </button>
                  ))}
                </div>
              </div>
              {points.length ? (
                <NavChart
                  history={points}
                  light={light}
                  seriesLabel={
                    product.historyKind === "trade" ? "日收盘价" : "单位净值"
                  }
                />
              ) : (
                <Empty
                  title="暂无可用历史曲线"
                  text="同步后展示可核实的净值或日收盘价；缺失数据不会填充为模拟走势。"
                />
              )}
              <div className="chart-bottom-note">
                <span>
                  {points.length} 个数据点 ·{" "}
                  {product.historyKind === "trade"
                    ? "日收盘价并非盘中逐笔行情"
                    : "基金净值并非盘中成交价"}
                </span>
                {product.historySourceUrl && (
                  <a
                    className="text-button"
                    href={externalUrl(product.historySourceUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    历史数据来源
                    <ArrowUpRight size={12} />
                  </a>
                )}
                <button
                  className="text-button"
                  onClick={() => void refresh(false, selected)}
                >
                  同步此产品
                  <RefreshCw size={12} />
                </button>
              </div>
              {product.errors.length > 0 && (
                <details className="data-errors">
                  <summary>查看数据来源说明（{product.errors.length}）</summary>
                  {product.errors.map((error, i) => (
                    <p key={i}>{error}</p>
                  ))}
                </details>
              )}
            </section>
            <section className="panel">
              <SectionTitle
                title="日内决策与评级"
                action={
                  <div className="segmented">
                    <button
                      className={mode === "probability" ? "active" : ""}
                      onClick={() => setMode("probability")}
                    >
                      决策概率
                    </button>
                    <button
                      className={mode === "rating" ? "active" : ""}
                      onClick={() => setMode("rating")}
                    >
                      综合评级
                    </button>
                  </div>
                }
              />
              <DecisionIndicators decision={decision} mode={mode} />
            </section>
            <section className="panel">
              <SectionTitle
                eyebrow="LOOK THROUGH"
                title="持仓穿透"
                action={<Pill>按已披露资料</Pill>}
              />
              <ExposureCoverage key={selected} code={selected} />
              {product.exposures.length ? (
                <div className="exposure-list">
                  {product.exposures.map((exposure, i) => (
                    <div className="exposure-row" key={`${exposure.name}-${i}`}>
                      <span className="exposure-number">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div>
                        <b>{exposure.name}</b>
                        <small>
                          {exposure.code || exposure.kind} · 报告期{" "}
                          {exposure.reportDate}
                        </small>
                        {exposure.children?.map((child) => (
                          <div className="exposure-child" key={child.name}>
                            {child.name}
                            <span>{percent(child.weight)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="exposure-weight">
                        <b>{percent(exposure.weight)}</b>
                        <small>
                          {exposure.basis === "net_assets"
                            ? "占基金净资产"
                            : "占基金总资产"}
                        </small>
                      </div>
                      <a
                        href={externalUrl(exposure.sourceUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`${exposure.name}来源`}
                      >
                        <ArrowUpRight size={16} />
                      </a>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="quiet-empty">
                  <FileText size={18} />
                  <span>
                    暂无已解析的穿透数据。请查看下方管理人报告；未披露部分不会推断成完整持仓。
                  </span>
                </div>
              )}
            </section>
            <ProductRules
              key={selected}
              instrument={
                state.watched.find((i) => i.code === selected) ||
                product.instrument
              }
              mutate={mutate}
            />
            <section>
              <SectionTitle title="产品资料与报告" />
              <SourceCards documents={product.documents} limit={6} />
            </section>
            {watched.some((item) => item.code === selected) &&
              !state.snapshot.positions.some((p) => p.code === selected) && (
                <button
                  className="text-button muted"
                  onClick={() =>
                    void mutate(
                      `/api/watch/${encodeURIComponent(selected)}`,
                      "DELETE",
                      undefined,
                      "已取消关注",
                    ).catch(() => {})
                  }
                >
                  从参考列表移除
                </button>
              )}
          </>
        ) : (
          <section className="panel">
            <Empty
              title="选择一个产品，开始研究"
              text="可以搜索目录中的产品，或从左侧选择参考产品。"
            />
          </section>
        )}
      </div>
      {addOpen && (
        <InstrumentModal
          onClose={() => setAddOpen(false)}
          onSave={async (instrument) => {
            await mutate(
              "/api/instruments",
              "POST",
              instrument,
              "已添加产品，将尝试获取可用行情",
            );
            select(instrument.code);
            setAddOpen(false);
          }}
        />
      )}
    </div>
  );
}

function InstrumentModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (instrument: Instrument) => Promise<void>;
}) {
  const [form, setForm] = useState<Instrument>({
    code: "",
    name: "",
    kind: "stock",
    currency: "CNY",
    market: "CN",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({ ...form, code: form.code.trim(), name: form.name.trim() });
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="添加研究产品"
      subtitle="先查目录；股票可录入交易所代码。添加产品不会增加你的资产。"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field
            label="产品代码"
            hint="A 股建议带市场前缀，如 sh600519、sz000001；港股 00700；美股 AAPL。"
          >
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              required
            />
          </Field>
          <Field label="产品名称">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Field>
          <Field label="产品类型">
            <select
              value={form.kind}
              onChange={(e) =>
                setForm({ ...form, kind: e.target.value as Instrument["kind"] })
              }
            >
              {Object.entries(kindLabel).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="市场">
            <select
              value={form.market}
              onChange={(e) => {
                const market = e.target.value as Instrument["market"];
                setForm({
                  ...form,
                  market,
                  currency:
                    market === "US"
                      ? "USD"
                      : market === "HK"
                        ? "HKD"
                        : market === "UK"
                          ? "GBP"
                          : market === "EU"
                            ? "EUR"
                            : "CNY",
                });
              }}
            >
              {[
                ["CN", "境内"],
                ["HK", "香港"],
                ["US", "美国"],
                ["UK", "英国"],
                ["EU", "欧洲"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="份额 / 交易币种">
            <select
              value={form.currency}
              onChange={(e) =>
                setForm({
                  ...form,
                  currency: e.target.value as Instrument["currency"],
                })
              }
            >
              {["CNY", "USD", "HKD", "GBP", "EUR"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
        </div>
        <p className="section-description">
          QDII 人民币份额使用 CNY
          与境内市场。免费行情覆盖不保证完整，未获取的项目明确保留为空。
        </p>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <Loader2 className="spin" size={14} />}添加产品
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProductRules({
  instrument,
  mutate,
}: {
  instrument: Instrument;
  mutate: Mutate;
}) {
  const [form, setForm] = useState({
    purchasable: instrument.purchasable || false,
    channel: instrument.channel || "",
    minBuy: instrument.minBuy || "",
    lotSize: instrument.lotSize || "",
    channelLimit: instrument.channelLimit || "",
    feeRate: instrument.feeRate || "",
    rulesVerified: instrument.rulesVerified || false,
  });
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const body = Object.fromEntries(
        Object.entries(form).filter(([, value]) => value !== ""),
      );
      await mutate(
        `/api/instruments/${encodeURIComponent(instrument.code)}`,
        "PATCH",
        body,
        "已保存该产品的渠道与交易约束",
      );
    } catch {
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel">
      <details className="product-rules">
        <summary>
          <span>我的可投资渠道与交易规则</span>
          <Pill tone={instrument.rulesVerified ? "green" : "amber"}>
            {instrument.rulesVerified ? "已核验" : "待配置"}
          </Pill>
          <ChevronDown size={16} />
        </summary>
        <p className="section-description">
          请依据你的实际银行或证券账户填写。公开目录与行情可见，不代表该账户可以买入；未核验不生成买入金额建议。
        </p>
        <form onSubmit={save}>
          <div className="form-grid">
            <Field
              label="购买渠道"
              hint="填写账本中完全一致的账户名称。金额建议只使用此账户的余额和可卖份额。"
            >
              <input
                value={form.channel}
                onChange={(e) => setForm({ ...form, channel: e.target.value })}
                placeholder="与记账账户名称一致"
              />
            </Field>
            <Field label={`最低买入金额（${instrument.currency}）`}>
              <input
                type="number"
                min="0"
                step="any"
                value={form.minBuy}
                onChange={(e) => setForm({ ...form, minBuy: e.target.value })}
              />
            </Field>
            <Field label="最小份额 / 交易单位">
              <input
                type="number"
                min="0.00000001"
                step="any"
                value={form.lotSize}
                onChange={(e) => setForm({ ...form, lotSize: e.target.value })}
              />
            </Field>
            <Field label={`渠道单次限额（${instrument.currency}）`}>
              <input
                type="number"
                min="0"
                step="any"
                value={form.channelLimit}
                onChange={(e) =>
                  setForm({ ...form, channelLimit: e.target.value })
                }
              />
            </Field>
            <Field
              label="最高适用费率（小数）"
              hint="例如 0.001 表示 0.1%。分档赎回费需人工核对，此处保守预留费用。"
            >
              <input
                type="number"
                min="0"
                max="0.999999"
                step="any"
                value={form.feeRate}
                onChange={(e) => setForm({ ...form, feeRate: e.target.value })}
              />
            </Field>
          </div>
          <Toggle
            label="我的账户可买入此产品"
            description="由你核对账户资格、申购状态与渠道额度。"
            checked={form.purchasable}
            onChange={(value) => setForm({ ...form, purchasable: value })}
          />
          <Toggle
            label="已核对以上交易规则"
            description="用于金额候选校验，不授权系统交易。"
            checked={form.rulesVerified}
            onChange={(value) => setForm({ ...form, rulesVerified: value })}
          />
          <button className="button secondary" disabled={saving}>
            {saving && <Loader2 size={14} className="spin" />}保存交易规则
          </button>
        </form>
      </details>
    </section>
  );
}

function ExposureCoverage({ code }: { code: string }) {
  const [error, setError] = useState("");
  const [data, setData] = useState<{
    valid: boolean;
    coverage: {
      basis: string;
      reportDate: string;
      scope: string;
      reportedWeight: string;
      unreportedWeight: string | null;
    }[];
    issues: { message: string }[];
    items: {
      name: string;
      effectiveWeight?: string;
      reportDate: string;
      unresolved?: string;
      path: string[];
    }[];
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void request<NonNullable<typeof data>>(
      `/api/products/${encodeURIComponent(code)}/exposure`,
    )
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);
  if (error)
    return (
      <p role="status" className="section-description">
        穿透覆盖率暂不可读取，不能据此判断完整持仓：{error}
      </p>
    );
  if (!data?.coverage.length) return null;
  return (
    <div className="coverage-summary">
      <span className="eyebrow">DISCLOSURE COVERAGE</span>
      <div className="coverage-grid">
        {data.coverage.map((group, index) => (
          <div key={index}>
            <span>
              {group.scope === "allocation" ? "资产类别披露" : "投资标的披露"} ·{" "}
              {group.basis === "net_assets" ? "净资产口径" : "总资产口径"}
            </span>
            <b>
              {percent(group.reportedWeight)} <small>已披露</small>
            </b>
            <small>
              未披露 {percent(group.unreportedWeight)} · {group.reportDate}
            </small>
          </div>
        ))}
      </div>
      <p>不同分母与报告期分开呈现，不将已披露部分归一化为完整持仓。</p>
      {data.issues.map((issue, i) => (
        <p className="text-amber" key={i}>
          {issue.message}
        </p>
      ))}
      {data.items.some((item) => item.path.length > 1) && (
        <details className="flattened-exposures">
          <summary>查看逐层穿透后的组合权重</summary>
          {data.items
            .filter((item) => item.path.length > 1)
            .map((item, i) => (
              <div key={i}>
                <span>
                  {item.path.join(" › ")}
                  <small>{item.unresolved || item.reportDate}</small>
                </span>
                <b>{percent(item.effectiveWeight)}</b>
              </div>
            ))}
        </details>
      )}
    </div>
  );
}

function Performance({
  state,
  revision,
  mutate,
  notify,
  record,
}: {
  state: AppState;
  revision: number;
  mutate: Mutate;
  notify: (text: string, error?: boolean) => void;
  record: () => void;
}) {
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [plans, setPlans] = useState<InvestmentPlan[]>([]);
  const [returns, setReturns] = useState<{
    curve: { date: string; value: string; unit: string }[];
    twr: string | null;
    estimatedTwr?: string | null;
    xirr: string | null;
    maxDrawdown: string | null;
    volatility: string | null;
    reason: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [planOpen, setPlanOpen] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      request<{ items: LedgerTransaction[] }>("/api/transactions"),
      request<{ items: InvestmentPlan[] }>("/api/plans"),
    ])
      .then(([txs, ps]) => {
        if (!cancelled) {
          setTransactions(txs.items);
          setPlans(ps.items);
        }
      })
      .catch((error) => notify(errorText(error), true))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revision, notify]);
  useEffect(() => {
    let cancelled = false;
    void request<NonNullable<typeof returns>>("/api/performance")
      .then((data) => {
        if (!cancelled) setReturns(data);
      })
      .catch((error) => notify(errorText(error), true));
    return () => {
      cancelled = true;
    };
  }, [revision, notify]);
  const s = state.snapshot;
  return (
    <>
      <section className="panel">
        <SectionTitle
          eyebrow="RETURN ATTRIBUTION"
          title="收益从哪里来"
          action={<Pill>CNY 口径</Pill>}
        />
        <div className="attribution-grid">
          {[
            { label: "已实现盈亏", value: s.realizedPnl },
            { label: "未实现盈亏", value: s.unrealizedPnl },
            { label: "分红与收入", value: s.income },
            { label: "费用支出", value: s.fees },
          ].map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              <strong
                className={
                  item.label === "费用支出"
                    ? ""
                    : isPositive(item.value)
                      ? "text-green"
                      : "text-rose"
                }
              >
                {money(item.value)}
              </strong>
            </div>
          ))}
        </div>
        <div className="reconciliation">
          <ShieldCheck size={16} />
          <span>
            净外部投入 {money(s.externalFlows)} · 账本核对差额{" "}
            {money(s.reconciliation)}
          </span>
          <span>收益率需要完整现金流与估值历史，暂不以盈亏金额替代。</span>
        </div>
      </section>
      <section className="panel">
        <SectionTitle
          eyebrow="PERFORMANCE IN CONTEXT"
          title="收益与风险指标"
          action={<Pill>真实估值快照</Pill>}
        />
        <div className="attribution-grid">
          {[
            { label: "时间加权收益 TWR", value: returns?.twr },
            { label: "资金加权年化 XIRR", value: returns?.xirr },
            { label: "最大回撤", value: returns?.maxDrawdown },
            { label: "波动率", value: returns?.volatility },
          ].map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              <strong>{percent(item.value)}</strong>
            </div>
          ))}
        </div>
        {returns && returns.curve.length >= 2 ? (
          <NavChart
            history={returns.curve.map((point) => ({
              date: point.date,
              nav: point.value,
            }))}
            light={state.settings.theme === "light"}
            seriesLabel="组合总资产（CNY）"
          />
        ) : (
          <div className="quiet-note">
            建立完整现金流记录后，系统逐日积累估值历史。缺少依据的指标显示为空。
          </div>
        )}
        <p className="section-description">
          {returns?.reason || "正在核对可用历史…"}
          {returns?.estimatedTwr != null
            ? ` 日度现金流近似收益 ${percent(returns.estimatedTwr)}，与精确 TWR 分开标注。`
            : ""}
        </p>
      </section>
      <section className="panel">
        <SectionTitle
          title="当前持仓"
          action={
            <button className="text-button" onClick={record}>
              新增交易
              <Plus size={14} />
            </button>
          }
        />
        {s.positions.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>产品</th>
                  <th>份额 / 可卖</th>
                  <th>成本</th>
                  <th>估值</th>
                  <th>浮动盈亏</th>
                </tr>
              </thead>
              <tbody>
                {s.positions.map((p) => (
                  <tr key={p.code}>
                    <td>
                      <b>{p.name}</b>
                      <small>
                        {p.code} · {p.currency}
                      </small>
                    </td>
                    <td>
                      {number(p.quantity, 4)}
                      <small>可卖 {number(p.sellable, 4)}</small>
                    </td>
                    <td>{money(p.cost, p.currency)}</td>
                    <td>
                      {money(p.marketValue, p.currency)}
                      <small>
                        {p.observation?.priceKind === "trade"
                          ? dateTime(p.observation.asOf)
                          : p.observation?.asOf?.slice(0, 10) || "待取得价格"}
                      </small>
                    </td>
                    <td
                      className={isPositive(p.pnl) ? "text-green" : "text-rose"}
                    >
                      {money(p.pnl, p.currency)}
                      <small>{percent(p.pnlPct, true)}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon={<Wallet size={23} />}
            title="还没有持仓记录"
            text="已有持仓可用“期初持仓”录入；新发生的交易请按真实成交或申赎状态记录。"
            action={
              <button className="button secondary" onClick={record}>
                <Plus size={14} />
                记录资产
              </button>
            }
          />
        )}
      </section>
      <section className="panel">
        <SectionTitle
          title="资金与交易流水"
          action={<Pill>{transactions.length} 条</Pill>}
        />
        {loading ? (
          <Loading />
        ) : transactions.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>日期 / 账户</th>
                  <th>类型 / 产品</th>
                  <th>金额</th>
                  <th>份额</th>
                  <th>状态</th>
                  <th>
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr
                    key={tx.id}
                    className={tx.reversedBy ? "reversed-row" : ""}
                  >
                    <td>
                      {tx.date}
                      <small>{tx.account}</small>
                      <details className="transaction-id">
                        <summary>记录 ID</summary>
                        <code>{tx.id}</code>
                      </details>
                    </td>
                    <td>
                      <b>{transactionLabel[tx.kind] || tx.kind}</b>
                      <small>{tx.code || tx.note || "现金账户"}</small>
                    </td>
                    <td>
                      {money(tx.amount, tx.currency)}
                      {tx.fee && Number(tx.fee) > 0 && (
                        <small>费用 {money(tx.fee, tx.currency)}</small>
                      )}
                    </td>
                    <td>{number(tx.quantity, 4)}</td>
                    <td>
                      <Pill
                        tone={
                          tx.reversedBy || tx.reverses ? "neutral" : "green"
                        }
                      >
                        {tx.reversedBy
                          ? "已冲销"
                          : tx.reverses
                            ? "冲销记录"
                            : "已记录"}
                      </Pill>
                    </td>
                    <td>
                      {!tx.reversedBy && !tx.reverses && (
                        <button
                          className="icon-button"
                          title="撤销这笔记录（保留冲销轨迹）"
                          aria-label={`撤销${tx.date}${transactionLabel[tx.kind]}`}
                          onClick={() =>
                            void mutate(
                              `/api/transactions/${encodeURIComponent(tx.id)}/reverse`,
                              "POST",
                              {},
                              "已生成冲销记录，账本已更新。",
                            ).catch(() => {})
                          }
                        >
                          <Undo2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="quiet-empty">
            <BookOpen size={18} />
            <span>真实交易会显示在这里。参考产品没有生成任何虚构流水。</span>
          </div>
        )}
      </section>
      <section className="panel">
        <SectionTitle
          title="投资计划"
          action={
            <button
              className="button secondary compact"
              onClick={() => setPlanOpen(true)}
            >
              <Plus size={14} />
              新增计划
            </button>
          }
        />
        <p className="section-description">
          计划用于记录节奏与复盘，不会自动下单或自动生成成交。
        </p>
        {plans.length ? (
          <div className="plan-grid">
            {plans.map((plan) => (
              <div className="plan-card" key={plan.id}>
                <Pill tone={plan.active ? "green" : "neutral"}>
                  {plan.active ? "执行中" : "已暂停"}
                </Pill>
                <b>
                  {state.watched.find((p) => p.code === plan.code)?.name ||
                    plan.code}
                </b>
                <strong>
                  {money(plan.amount, plan.currency)}
                  <small>
                    {" "}
                    /{" "}
                    {plan.frequency === "daily"
                      ? "日"
                      : plan.frequency === "weekly"
                        ? "周"
                        : "月"}
                  </small>
                </strong>
                <span>下次计划 {plan.nextDate}</span>
                <button
                  className="text-button"
                  onClick={() =>
                    void mutate(
                      "/api/plans",
                      "POST",
                      { ...plan, active: !plan.active },
                      plan.active ? "计划已暂停" : "计划已恢复",
                    ).catch(() => {})
                  }
                >
                  {plan.active ? "暂停计划" : "恢复计划"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="quiet-note">
            尚未建立计划。先明确可用资金与风险约束，再安排投入节奏。
          </div>
        )}
      </section>
      {planOpen && (
        <PlanModal
          watched={state.watched}
          onClose={() => setPlanOpen(false)}
          onSave={async (plan) => {
            await mutate("/api/plans", "POST", plan, "投资计划已保存");
            setPlanOpen(false);
          }}
        />
      )}
    </>
  );
}

function Assistant({
  state,
  messages,
  setMessages,
  onChange,
  notify,
}: {
  state: AppState;
  messages: Message[];
  setMessages: (next: Message[] | ((previous: Message[]) => Message[])) => void;
  onChange: () => Promise<AppState>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"analysis" | "record">("analysis");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const failedRequest = useRef<{
    content: string;
    mode: string;
    id: string;
  } | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, busy]);
  const available =
    state.keyConfigured &&
    state.settings.apiEnabled &&
    state.settings.allowedRead &&
    state.budget.enabled &&
    (mode !== "record" || state.settings.allowedWrite);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!input.trim() || busy || !available) return;
    const content = input.trim();
    const history = messages
      .slice(-30)
      .map(({ role, content }) => ({ role, content }));
    const requestId =
      failedRequest.current?.content === content &&
      failedRequest.current.mode === mode
        ? failedRequest.current.id
        : crypto.randomUUID();
    failedRequest.current = { content, mode, id: requestId };
    setMessages((previous) => [...previous, { role: "user", content }]);
    setInput("");
    setBusy(true);
    try {
      const response = await request<{ text: string; receipts?: unknown[] }>(
        "/api/chat",
        "POST",
        { message: content, history, mode, requestId },
      );
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: response.text,
          receipts: response.receipts,
        },
      ]);
      failedRequest.current = null;
      await onChange();
    } catch (error) {
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: `本次请求未得到可验证回复：${errorText(error)}${mode === "record" ? " 请先核对账本，重复发送同一内容将复用请求编号。" : ""}`,
        },
      ]);
      notify(errorText(error), true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="assistant-layout">
      <section className="panel chat-panel">
        <div className="chat-heading">
          <span className="sparkle-tile">
            <Sparkles size={20} />
          </span>
          <div>
            <h2>与你一起，理解资产</h2>
            <span>
              {state.settings.model} · {state.settings.reasoning} reasoning
            </span>
          </div>
          <button
            className="text-button"
            onClick={() => setMessages([])}
            disabled={busy || !messages.length}
          >
            清空会话
          </button>
        </div>
        <div className="chat-messages">
          {!messages.length && (
            <div className="chat-welcome">
              <span className="large-sparkle">
                <Sparkles size={31} />
              </span>
              <h3>从一个值得研究的问题开始。</h3>
              <p>
                我会读取已授权的持仓、数据日期和风险约束。
                <br />
                分析过程不会自动执行交易。
              </p>
              <div className="suggestion-grid">
                {[
                  "我当前的资产有哪些集中度风险？",
                  "解释我关注的 QDII 净值为什么延迟。",
                  "梳理最近披露的基金持仓与变化。",
                  "今天有哪些数据需要先核实？",
                ].map((text) => (
                  <button key={text} onClick={() => setInput(text)}>
                    {text}
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message, index) => (
            <div className={`chat-message ${message.role}`} key={index}>
              <span className="message-avatar">
                {message.role === "user" ? "我" : <Sparkles size={15} />}
              </span>
              <div className="message-content">
                <span>{message.role === "user" ? "你" : "研究助手"}</span>
                <div>{message.content}</div>
                {message.receipts?.length ? (
                  <details className="receipt-details">
                    <summary>
                      <CheckCircle2 size={14} />
                      查看 {message.receipts.length} 项记账回执
                    </summary>
                    <pre>{JSON.stringify(message.receipts, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            </div>
          ))}
          {busy && (
            <div className="chat-message assistant">
              <span className="message-avatar">
                <Sparkles size={15} />
              </span>
              <Loading text="正在结合当前快照分析" />
            </div>
          )}
          <div ref={end} />
        </div>
        <form className="chat-compose" onSubmit={submit}>
          <div className="compose-toolbar">
            <div className="segmented">
              <button
                type="button"
                className={mode === "analysis" ? "active" : ""}
                onClick={() => setMode("analysis")}
              >
                研究讨论
              </button>
              <button
                type="button"
                className={mode === "record" ? "active" : ""}
                onClick={() => setMode("record")}
              >
                记录交易
              </button>
            </div>
            <span>
              {mode === "record"
                ? "明确指令将直接更新账本，可撤销"
                : "此模式只读资产，不修改账本"}
            </span>
          </div>
          <textarea
            aria-label="发送给研究助手的信息"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              available
                ? mode === "record"
                  ? "例如：今天向主账户转入人民币 5000 元。"
                  : "描述你的问题，也可以引用产品代码…"
                : "请先在设置中配置密钥、Credit 与 API 权限。"
            }
            rows={3}
            disabled={!available || busy}
          />
          <div className="compose-bottom">
            <span>
              <LockKeyhole size={12} />
              本次会话上下文 · 不建立长期用户记忆
            </span>
            <button
              className="button primary compact"
              disabled={!available || busy || !input.trim()}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Send size={15} />
              )}
              发送
            </button>
          </div>
        </form>
      </section>
      <aside className="assistant-context">
        <section className="panel">
          <SectionTitle title="本次研究上下文" />
          <div className="context-row">
            <span>持有产品</span>
            <b>{state.snapshot.positions.length} 项</b>
          </div>
          <div className="context-row">
            <span>参考产品</span>
            <b>{state.watched.length} 项</b>
          </div>
          <div className="context-row">
            <span>风险参数</span>
            <Pill tone={state.settings.risk.configured ? "green" : "amber"}>
              {state.settings.risk.configured ? "已设置" : "待设置"}
            </Pill>
          </div>
          <div className="context-row">
            <span>读取权限</span>
            <b>{state.settings.allowedRead ? "已授权" : "关闭"}</b>
          </div>
          <div className="context-row">
            <span>记账权限</span>
            <b>{state.settings.allowedWrite ? "已授权" : "关闭"}</b>
          </div>
          <div className="context-footnote">
            数据快照 #{state.snapshot.revision}
            <br />
            {dateTime(state.snapshot.createdAt)}
          </div>
        </section>
        <section className="panel compact-panel">
          <span className="eyebrow">KEEP A CLEAR HEAD</span>
          <h3>先看证据，再看结论。</h3>
          <p>
            关注数据时效、未知信息与决策代价。模型表达的信心，不等于投资结果的保证。
          </p>
        </section>
      </aside>
    </div>
  );
}

function Monitor({ state, mutate }: { state: AppState; mutate: Mutate }) {
  const currencyFor = (code: string) =>
    state.snapshot.positions.find((p) => p.code === code)?.currency ||
    state.watched.find((p) => p.code === code)?.currency ||
    "CNY";
  return (
    <>
      <div className="monitor-grid">
        <section className="panel">
          <SectionTitle
            eyebrow="BACKGROUND MONITOR"
            title="本地监控"
            action={
              <Pill
                tone={
                  state.monitor.running || state.settings.monitoring
                    ? "green"
                    : "neutral"
                }
              >
                {state.monitor.running
                  ? "同步中"
                  : state.settings.monitoring
                    ? "已启用"
                    : "已暂停"}
              </Pill>
            }
          />
          <div className="monitor-status">
            <span
              className={`monitor-orbit ${state.monitor.running ? "running" : ""}`}
            >
              <Activity size={27} />
            </span>
            <div>
              <h3>
                {state.settings.monitoring
                  ? "后台任务已启用"
                  : "按自己的节奏开启监控"}
              </h3>
              <p>
                Mac 保持唤醒、登录且联网时运行。
                <br />
                休眠或关机期间暂停，不补发过期信号。
              </p>
            </div>
          </div>
          <div className="context-row">
            <span>当前检查间隔</span>
            <b>{state.monitor.intervalSeconds} 秒</b>
          </div>
          <div className="context-row">
            <span>最近检查</span>
            <b>{dateTime(state.monitor.lastRefresh)}</b>
          </div>
          <button
            className={`button full-width ${state.settings.monitoring ? "secondary" : "primary"}`}
            onClick={() =>
              void mutate(
                "/api/settings",
                "PATCH",
                { monitoring: !state.settings.monitoring },
                state.settings.monitoring ? "已暂停后台监控" : "已启用后台监控",
              ).catch(() => {})
            }
          >
            {state.settings.monitoring ? "暂停监控" : "启用监控"}
          </button>
        </section>
        <section className="panel">
          <SectionTitle
            eyebrow="CHATGPT NOTIFICATIONS"
            title="手机通知"
            action={
              <Pill
                tone={
                  state.notification.state === "connected" ? "green" : "amber"
                }
              >
                {state.notification.state === "connected"
                  ? "已验证连接"
                  : "待端到端验证"}
              </Pill>
            }
          />
          <div className="monitor-status">
            <span className="monitor-orbit">
              <Bell size={25} />
            </span>
            <div>
              <h3>只通过 ChatGPT 通知你</h3>
              <p>{state.notification.message}</p>
            </div>
          </div>
          <div className="notification-steps">
            <span className="completed">
              <Check size={12} />
              本地事件记录
            </span>
            <ChevronRight size={12} />
            <span>认证与订阅</span>
            <ChevronRight size={12} />
            <span>iPhone 实际送达</span>
          </div>
          <p className="section-description">
            页面中出现提醒，不代表手机已收到。认证与真实送达测试通过前，提醒仅留在本地。
          </p>
        </section>
      </div>
      <section className="panel">
        <SectionTitle title="决策触发流程" />
        <div className="trigger-flow">
          <div>
            <span>01</span>
            <b>市场与数据有效</b>
            <p>交易窗口内、价格和披露数据满足时效要求</p>
          </div>
          <ChevronRight size={19} />
          <div>
            <span>02</span>
            <b>Buy / Sell &gt; 90%</b>
            <p>Decisions API 信号达到触发门槛</p>
          </div>
          <ChevronRight size={19} />
          <div>
            <span>03</span>
            <b>独立复核 &gt; 90%</b>
            <p>研究模型核查事实、反例与置信度</p>
          </div>
          <ChevronRight size={19} />
          <div>
            <span>04</span>
            <b>金额与风险校验</b>
            <p>生成合法候选、评分与紧迫度，由你执行</p>
          </div>
        </div>
      </section>
      <section className="panel">
        <SectionTitle
          title="提醒记录"
          action={<Pill>{state.alerts.length} 条</Pill>}
        />
        {state.alerts.length ? (
          <div className="alert-list">
            {state.alerts.map((alert) => (
              <article className="alert-card" key={alert.id}>
                <div className="alert-title">
                  <span
                    className={`alert-direction ${alert.direction.toLowerCase()}`}
                  >
                    {alert.direction === "Buy" ? (
                      <ArrowDownLeft size={17} />
                    ) : (
                      <ArrowUpRight size={17} />
                    )}
                    {alert.direction}
                  </span>
                  <b>
                    {state.watched.find((p) => p.code === alert.code)?.name ||
                      alert.code}
                  </b>
                  <Pill
                    tone={
                      alert.status === "received"
                        ? "green"
                        : alert.status === "expired"
                          ? "neutral"
                          : "amber"
                    }
                  >
                    {
                      {
                        local: "仅本地",
                        queued: "待发送",
                        received: "服务已接收",
                        failed: "发送失败",
                        expired: "已过期",
                      }[alert.status]
                    }
                  </Pill>
                  <small>{dateTime(alert.createdAt)}</small>
                </div>
                <p>{alert.summary}</p>
                <div className="alert-evidence">
                  动作概率 {percent(alert.probability * 100)} · 复核置信度{" "}
                  {percent(alert.reviewConfidence * 100)} · 过期时间{" "}
                  {dateTime(alert.expiresAt)}
                </div>
                <div className="candidate-grid">
                  {alert.candidates.map((candidate, index) => (
                    <div key={index}>
                      <span>
                        方案 {index + 1}
                        {candidate.percentage
                          ? ` · 总持仓的 ${candidate.percentage}%`
                          : ""}
                      </span>
                      <strong>
                        {money(
                          candidate.amount,
                          candidate.currency || currencyFor(alert.code),
                        )}
                      </strong>
                      <small>
                        {candidate.account ? `${candidate.account} · ` : ""}
                        {candidate.currency || currencyFor(alert.code)}
                      </small>
                      {candidate.estimatedFee != null && (
                        <small>
                          预留费用{" "}
                          {money(
                            candidate.estimatedFee,
                            candidate.currency || currencyFor(alert.code),
                          )}
                          {candidate.estimatedNet != null
                            ? ` · 预计净额 ${money(candidate.estimatedNet, candidate.currency || currencyFor(alert.code))}`
                            : ""}
                        </small>
                      )}
                      {candidate.cashRequired != null && (
                        <small>
                          预计占用现金{" "}
                          {money(
                            candidate.cashRequired,
                            candidate.currency || currencyFor(alert.code),
                          )}
                        </small>
                      )}
                      {candidate.currency &&
                        candidate.currency !== "CNY" &&
                        candidate.amountCny != null && (
                          <small>
                            参考折合 {money(candidate.amountCny)} · 汇率{" "}
                            {number(candidate.fxRateToCny, 6)}（
                            {dateTime(candidate.fxAsOf, true)}），不自动换汇
                          </small>
                        )}
                      <small>
                        Score {candidate.score ?? "—"} / 10 · Urgency{" "}
                        {candidate.urgency ?? "—"} / 10
                      </small>
                      <p>{candidate.reason}</p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Bell size={23} />}
            title="暂时没有满足条件的提醒"
            text="只有数据、信号、复核与资金约束全部通过后，才产生提醒。安静也是一种状态。"
          />
        )}
      </section>
      {state.monitor.errors.length > 0 && (
        <section className="panel">
          <SectionTitle title="最近运行说明" />
          <div className="error-list">
            {state.monitor.errors.map((error, i) => (
              <p key={i}>
                <CircleHelp size={14} />
                {error}
              </p>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Settings({
  state,
  mutate,
  notify,
}: {
  state: AppState;
  mutate: Mutate;
  notify: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(state.settings);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<
    { id: string; reasoningEfforts?: string[] }[]
  >([]);
  const [modelError, setModelError] = useState("");
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [promptName, setPromptName] = useState("");
  const [promptText, setPromptText] = useState("");
  const [promptPreview, setPromptPreview] = useState<unknown | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft((old) => ({ ...old, theme: state.settings.theme }));
  }, [state.settings.theme]);
  useEffect(() => {
    void request<{ items: PromptTemplate[] }>("/api/prompts")
      .then((data) => {
        setPrompts(data.items);
        const first =
          data.items.find((p) => p.name === "brief") || data.items[0];
        setPromptName(first?.name || "");
        setPromptText(first?.text || "");
      })
      .catch((error) => notify(errorText(error), true));
  }, [notify]);
  useEffect(() => {
    if (!state.keyConfigured) {
      setModelError("");
      return;
    }
    void request<{ items: { id: string; reasoningEfforts?: string[] }[] }>(
      "/api/models",
    )
      .then((data) => {
        setModels(data.items);
        setModelError("");
      })
      .catch((error) => setModelError(errorText(error)));
  }, [state.keyConfigured]);
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const efforts = models.find((m) => m.id === draft.model)
    ?.reasoningEfforts || ["none", "low", "medium", "high"];
  const budgetUsed = Math.min(
    100,
    Number(state.budget.limit) > 0
      ? ((Number(state.budget.spent) + Number(state.budget.reserved)) /
          Number(state.budget.limit)) *
          100
      : 0,
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await mutate(
        "/api/settings",
        "PATCH",
        {
          ...draft,
          holidays: Object.fromEntries(
            Object.entries(draft.holidays).map(([market, dates]) => [
              market,
              dates.map((d) => d.trim()).filter(Boolean),
            ]),
          ),
        },
        "偏好与权限已保存",
      );
    } catch {
    } finally {
      setSaving(false);
    }
  }
  async function saveKey() {
    if (!key.trim()) return;
    setSaving(true);
    try {
      await mutate(
        "/api/key",
        "POST",
        { key: key.trim() },
        "API Key 已交给本机安全存储",
      );
      setKey("");
      void request<{ items: { id: string; reasoningEfforts?: string[] }[] }>(
        "/api/models",
      )
        .then((data) => {
          setModels(data.items);
          setModelError("");
        })
        .catch((error) => setModelError(errorText(error)));
    } catch {
    } finally {
      setSaving(false);
    }
  }
  async function exportData() {
    try {
      const data = await request("/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `finance-export-${today()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("已导出个人数据，请妥善保管文件。");
    } catch (error) {
      notify(errorText(error), true);
    }
  }
  async function importData(file?: File) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      await mutate(
        "/api/import",
        "POST",
        { transactions: parsed.transactions || [], plans: parsed.plans || [] },
        "已导入，重复记录由账本幂等校验处理。",
      );
    } catch (error) {
      notify(errorText(error), true);
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }
  return (
    <div className="settings-layout">
      <form onSubmit={save} className="settings-main">
        <section className="panel">
          <SectionTitle
            eyebrow="MODEL & ACCESS"
            title="研究模型与权限"
            action={
              <Pill tone={state.keyConfigured ? "green" : "amber"}>
                {state.keyConfigured ? "密钥已配置" : "待配置密钥"}
              </Pill>
            }
          />
          <div className="form-grid">
            <Field label="分析模型">
              <input
                list="model-options"
                value={draft.model}
                onChange={(e) => update("model", e.target.value)}
                placeholder="输入模型 ID"
                required
              />
              <datalist id="model-options">
                {models.map((model) => (
                  <option value={model.id} key={model.id} />
                ))}
              </datalist>
            </Field>
            <Field
              label="Reasoning 强度"
              hint="实际支持范围由模型能力与服务端校验决定。"
            >
              <select
                value={draft.reasoning}
                onChange={(e) => update("reasoning", e.target.value)}
              >
                {[...new Set([draft.reasoning, ...efforts])].map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {modelError && (
            <p role="status" className="section-description">
              模型目录暂不可读取：{modelError}。当前保留已保存的模型
              ID，调用前仍须通过服务端能力校验。
            </p>
          )}
          <div className="toggle-list">
            <Toggle
              label="启用 OpenAI API"
              description="简报、对话和决策评估计入统一预算。"
              checked={draft.apiEnabled}
              onChange={(value) => update("apiEnabled", value)}
            />
            <Toggle
              label="允许读取资产数据"
              description="向授权模型发送持仓、交易与相关资料。"
              checked={draft.allowedRead}
              onChange={(value) => update("allowedRead", value)}
            />
            <Toggle
              label="允许按我的指令记账"
              description="仅明确的用户指令可更新账本，保留回执和撤销记录。"
              checked={draft.allowedWrite}
              onChange={(value) => update("allowedWrite", value)}
            />
          </div>
          <div className="key-field">
            <Field
              label={state.keyConfigured ? "更换 API Key" : "配置 API Key"}
              hint="仅发送到本地服务安全保存，不写入浏览器存储或 Git。"
            >
              <div className="inline-input">
                <input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-…"
                />
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void saveKey()}
                  disabled={saving || !key.trim()}
                >
                  安全保存
                </button>
              </div>
            </Field>
          </div>
        </section>
        <section className="panel">
          <SectionTitle eyebrow="CREDIT CONTROL" title="Credit 与费用边界" />
          <div className="budget-summary">
            <div>
              <span>本月已计费 / 预留</span>
              <strong>
                {money(state.budget.spent, "USD")}
                <small> + {money(state.budget.reserved, "USD")}</small>
              </strong>
            </div>
            <div>
              <span>应用可用预算</span>
              <strong>{money(state.budget.remaining, "USD")}</strong>
            </div>
          </div>
          <div className="budget-track">
            <i style={{ width: `${budgetUsed}%` }} />
          </div>
          {state.budget.reason && (
            <p className="budget-reason">
              <CircleHelp size={14} />
              {state.budget.reason}
            </p>
          )}
          <div className="form-grid">
            <Field label="每月应用费用上限（USD）">
              <input
                type="number"
                min="0"
                max="90"
                step="0.01"
                value={draft.monthlyLimit}
                onChange={(e) => update("monthlyLimit", e.target.value)}
                required
              />
            </Field>
            <Field label="已获 Credit 总额（USD）">
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.creditAmount}
                onChange={(e) => update("creditAmount", e.target.value)}
                required
              />
            </Field>
            <Field label="Credit 开始时间">
              <input
                type="date"
                value={draft.creditStartsAt?.slice(0, 10) || ""}
                onChange={(e) => update("creditStartsAt", e.target.value)}
              />
            </Field>
            <Field label="Credit 失效时间">
              <input
                type="date"
                value={draft.creditExpiresAt?.slice(0, 10) || ""}
                onChange={(e) => update("creditExpiresAt", e.target.value)}
              />
            </Field>
          </div>
          <Toggle
            label="我已核对 Platform 中的 Credit"
            description="请填写实际领取额度和有效期；套餐名称本身不会自动证明额度可用。"
            checked={draft.creditConfirmed}
            onChange={(value) => update("creditConfirmed", value)}
          />
          <p className="section-description">
            本程序统一统计分析与 Decisions 调用。接近预算时降频或停用；同一
            Credit 被其他应用消耗的部分仍需在 Platform 核对。
          </p>
        </section>
        <section className="panel">
          <SectionTitle
            eyebrow="INVESTMENT GUARDRAILS"
            title="先定义你的资金边界"
          />
          <div className="form-grid">
            <Field label="最低现金保留（CNY）">
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.risk.minimumCash}
                onChange={(e) =>
                  update("risk", { ...draft.risk, minimumCash: e.target.value })
                }
                required
              />
            </Field>
            <Field label="单笔交易金额上限（CNY）">
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.risk.singleTradeLimit}
                onChange={(e) =>
                  update("risk", {
                    ...draft.risk,
                    singleTradeLimit: e.target.value,
                  })
                }
                required
              />
            </Field>
            <Field label="单产品最大仓位（%）">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={draft.risk.maxPositionPct}
                onChange={(e) =>
                  update("risk", {
                    ...draft.risk,
                    maxPositionPct: e.target.value,
                  })
                }
                required
              />
            </Field>
            <div className="field">
              <span>可用资金来源</span>
              <div className="readonly-field">以实际现金账本为准</div>
              <small>通过“记一笔 → 资金转入”更新。</small>
            </div>
          </div>
          <Toggle
            label="确认使用上述资金约束"
            description="未完成约束配置时，不生成买卖金额建议。"
            checked={draft.risk.configured}
            onChange={(value) =>
              update("risk", { ...draft.risk, configured: value })
            }
          />
        </section>
        <section className="panel">
          <SectionTitle
            title="外币换算"
            action={
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void mutate(
                    "/api/fx/refresh",
                    "POST",
                    {},
                    "已读取 ECB 官方参考汇率",
                  )
                    .then((result) => {
                      const fx = result as {
                        rates: Record<string, string>;
                        asOf: string;
                      };
                      setDraft((old) => ({
                        ...old,
                        fxRates: fx.rates,
                        fxAsOf: fx.asOf,
                      }));
                    })
                    .catch(() => {})
                }
              >
                <RefreshCw size={13} />
                同步 ECB 参考汇率
              </button>
            }
          />
          <p className="section-description">
            用于人民币组合估值与金额候选校验。填写 1
            单位外币对应的人民币金额，保留汇率日期；金额建议只使用指定账户现有原币资金，不自动换汇。
          </p>
          <div className="form-grid">
            {["USD", "HKD", "GBP", "EUR"].map((currency) => (
              <Field key={currency} label={`${currency} → CNY`}>
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  placeholder="未配置"
                  value={draft.fxRates[currency] || ""}
                  onChange={(e) => {
                    const rates = { ...draft.fxRates };
                    if (e.target.value) rates[currency] = e.target.value;
                    else delete rates[currency];
                    update("fxRates", rates);
                  }}
                />
              </Field>
            ))}
            <Field label="汇率数据日期">
              <input
                type="date"
                value={draft.fxAsOf?.slice(0, 10) || ""}
                onChange={(e) => update("fxAsOf", e.target.value)}
              />
            </Field>
          </div>
        </section>
        <section className="panel">
          <SectionTitle title="交易日历核验" />
          <p className="section-description">
            常规时段由系统判断。请按交易所日历填写核验截止日与休市日期，日历未核验或已过期时不会触发高置信提醒。
          </p>
          <div className="calendar-settings">
            {[
              ["CN", "境内市场"],
              ["HK", "香港市场"],
              ["US", "美国市场"],
              ["UK", "英国市场"],
              ["EU", "欧洲市场"],
            ].map(([market, label]) => (
              <div className="calendar-row" key={market}>
                <b>{label}</b>
                <Field label={`${label}日历核验至`}>
                  <input
                    type="date"
                    value={draft.calendarVerifiedThrough[market] || ""}
                    onChange={(e) => {
                      const dates = { ...draft.calendarVerifiedThrough };
                      if (e.target.value) dates[market] = e.target.value;
                      else delete dates[market];
                      update("calendarVerifiedThrough", dates);
                    }}
                  />
                </Field>
                <Field
                  label={`${label}休市日期`}
                  hint="每行一个 YYYY-MM-DD 日期；不要填写正常交易日。"
                >
                  <textarea
                    rows={2}
                    value={(draft.holidays[market] || []).join("\n")}
                    onChange={(e) =>
                      update("holidays", {
                        ...draft.holidays,
                        [market]: e.target.value.split("\n"),
                      })
                    }
                    placeholder="2026-12-25"
                  />
                </Field>
              </div>
            ))}
          </div>
        </section>
        <div className="save-bar">
          <span>所有偏好保存在本机，可随时修改。</span>
          <button className="button primary" disabled={saving}>
            {saving ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}
            保存设置
          </button>
        </div>
      </form>
      <aside className="settings-side">
        <section className="panel">
          <SectionTitle
            title="透明的研究指令"
            action={<FileText size={17} />}
          />
          <p className="section-description">
            查看并修改实际使用的 Prompt。每次修改生成新版本，决策保留所用版本。
          </p>
          <Field label="选择指令">
            <select
              value={promptName}
              onChange={(e) => {
                setPromptName(e.target.value);
                setPromptText(
                  prompts.find((p) => p.name === e.target.value)?.text || "",
                );
              }}
            >
              {prompts.map((prompt) => (
                <option key={prompt.name} value={prompt.name}>
                  {prompt.label} · v{prompt.version}
                </option>
              ))}
            </select>
          </Field>
          <textarea
            className="prompt-editor"
            aria-label="编辑模型指令"
            readOnly={promptName === "boundary"}
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            rows={15}
            spellCheck={false}
          />
          <button
            className="button secondary full-width"
            disabled={
              !promptName || promptName === "boundary" || !promptText.trim()
            }
            onClick={() =>
              void mutate(
                `/api/prompts/${encodeURIComponent(promptName)}`,
                "POST",
                { text: promptText },
                "指令已保存为新版本",
              )
                .then(async () => {
                  const result = await request<{ items: PromptTemplate[] }>(
                    "/api/prompts",
                  );
                  setPrompts(result.items);
                })
                .catch(() => {})
            }
          >
            保存指令版本
          </button>
          <div className="prompt-actions">
            <button
              className="text-button"
              disabled={!promptName}
              onClick={() =>
                void request(
                  `/api/prompts/${encodeURIComponent(promptName)}/preview`,
                )
                  .then(setPromptPreview)
                  .catch((error) => notify(errorText(error), true))
              }
            >
              <Eye size={13} />
              查看发送上下文
            </button>
            <button
              className="text-button muted"
              disabled={!promptName || promptName === "boundary"}
              onClick={() =>
                void mutate(
                  `/api/prompts/${encodeURIComponent(promptName)}/reset`,
                  "POST",
                  {},
                  "已恢复默认指令并保留版本轨迹",
                )
                  .then(async () => {
                    const result = await request<{ items: PromptTemplate[] }>(
                      "/api/prompts",
                    );
                    setPrompts(result.items);
                    setPromptText(
                      result.items.find((p) => p.name === promptName)?.text ||
                        "",
                    );
                  })
                  .catch(() => {})
              }
            >
              <Undo2 size={13} />
              恢复默认
            </button>
          </div>
        </section>
        <section className="panel">
          <SectionTitle title="本地数据管理" />
          <button className="data-action" onClick={() => void exportData()}>
            <ArrowDownToLine size={18} />
            <span>
              <b>导出账本与计划</b>
              <small>下载个人 JSON 数据文件</small>
            </span>
            <ArrowUpRight size={14} />
          </button>
          <button
            className="data-action"
            onClick={() => inputRef.current?.click()}
          >
            <BookOpen size={18} />
            <span>
              <b>导入交易记录</b>
              <small>支持本工作台 JSON 格式</small>
            </span>
            <ArrowUpRight size={14} />
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="sr-only"
            aria-label="导入个人账本"
            onChange={(e) => void importData(e.target.files?.[0])}
          />
          <button
            className="data-action"
            onClick={() =>
              void mutate(
                "/api/catalog/refresh",
                "POST",
                {},
                "产品目录已检查更新",
              ).catch(() => {})
            }
          >
            <Database size={18} />
            <span>
              <b>同步产品目录</b>
              <small>当前 {number(state.catalogCount, 0)} 条索引</small>
            </span>
            <RefreshCw size={14} />
          </button>
          <p className="section-description">
            导出文件包含个人数据，请勿提交到公开仓库。删除浏览器会话不会删除账本。
          </p>
        </section>
        <section className="panel compact-panel">
          <ShieldCheck size={22} className="text-green" />
          <h3>权限属于你</h3>
          <p>
            研究模式不修改资产。后台分析不拥有记账权限。新闻与报告内容不能授权任何写入操作。
          </p>
        </section>
      </aside>
      {promptPreview !== null && (
        <Modal
          title="发送上下文预览"
          subtitle="当前快照与实际指令的只读预览；具体聊天内容由每次请求加入，不包含密钥。"
          onClose={() => setPromptPreview(null)}
        >
          <pre className="context-preview">
            {JSON.stringify(promptPreview, null, 2)}
          </pre>
        </Modal>
      )}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <b>{label}</b>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("input,select,button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const items = panel.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        );
        if (!items?.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = before;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭对话框"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TransactionModal({
  initialCode,
  watched,
  onClose,
  onSave,
}: {
  initialCode: string;
  watched: Instrument[];
  onClose: () => void;
  onSave: (input: TransactionInput) => Promise<void>;
}) {
  const [form, setForm] = useState<TransactionInput>({
    idempotencyKey: crypto.randomUUID(),
    kind: "deposit",
    code: initialCode,
    account: "主账户",
    currency: "CNY",
    date: today(),
    amount: "",
    fee: "0",
    quantity: "",
    note: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  useEffect(() => {
    void request<{ items: LedgerTransaction[] }>("/api/transactions")
      .then((data) => setTransactions(data.items))
      .catch((error) =>
        setError(`待处理记录读取失败，暂不能关联申赎申请：${errorText(error)}`),
      );
  }, []);
  const productRequired = [
    "buy",
    "sell",
    "subscribe",
    "redeem",
    "confirm",
    "settle",
    "cancel",
    "dividend",
    "reinvest",
    "opening",
  ].includes(form.kind);
  const quantityRequired = [
    "buy",
    "sell",
    "confirm",
    "reinvest",
    "opening",
    "redeem",
  ].includes(form.kind);
  const parentRequired = ["confirm", "settle", "cancel"].includes(form.kind);
  const parents = transactions.filter(
    (t) =>
      !t.reversedBy &&
      !t.reverses &&
      (form.kind === "settle"
        ? t.kind === "confirm"
        : ["subscribe", "redeem"].includes(t.kind)) &&
      !transactions.some(
        (child) =>
          child.parentId === t.id && !child.reversedBy && !child.reverses,
      ),
  );
  const update = <K extends keyof TransactionInput>(
    key: K,
    value: TransactionInput[K],
  ) => setForm((old) => ({ ...old, [key]: value }));
  function selectParent(id: string) {
    const tx = parents.find((t) => t.id === id);
    if (!tx) return;
    setForm((old) => ({
      ...old,
      parentId: id,
      code: tx.code,
      currency: tx.currency,
      account: tx.account,
      quantity: tx.quantity || "",
      amount:
        old.kind === "settle"
          ? new Decimal(tx.amount).minus(tx.fee || 0).toFixed()
          : tx.amount,
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const input = {
        ...form,
        code: productRequired ? form.code : undefined,
        quantity: quantityRequired ? form.quantity : undefined,
        parentId: parentRequired ? form.parentId : undefined,
        toCurrency: form.kind === "fx" ? form.toCurrency || "USD" : undefined,
        toAmount: form.kind === "fx" ? form.toAmount : undefined,
        fxRateToCny:
          form.currency !== "CNY" && form.fxRateToCny
            ? form.fxRateToCny
            : undefined,
      };
      await onSave(input);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="记一笔真实记录"
      subtitle="只更新你的本地账本，不向银行或券商下单。"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="记录类型">
            <select
              value={form.kind}
              onChange={(e) =>
                update("kind", e.target.value as TransactionKind)
              }
            >
              {Object.entries(transactionLabel).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="发生日期">
            <input
              type="date"
              value={form.date}
              onChange={(e) => update("date", e.target.value)}
              required
            />
          </Field>
          {parentRequired && (
            <Field
              label="关联原申请"
              hint="选中后带入产品、账户与币种；请按真实结果核对金额。"
            >
              <select
                value={form.parentId || ""}
                onChange={(e) => selectParent(e.target.value)}
                required
              >
                <option value="">选择待处理记录</option>
                {parents.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.date} · {transactionLabel[t.kind]} · {t.code} ·{" "}
                    {money(t.amount, t.currency)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="账户名称">
            <input
              value={form.account}
              onChange={(e) => update("account", e.target.value)}
              placeholder="例如：招商银行"
              required
            />
          </Field>
          <Field label="记账币种">
            <select
              value={form.currency}
              onChange={(e) =>
                update(
                  "currency",
                  e.target.value as TransactionInput["currency"],
                )
              }
            >
              {["CNY", "USD", "HKD", "GBP", "EUR"].map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </Field>
          {productRequired && (
            <Field label="产品代码">
              <input
                list="transaction-products"
                value={form.code || ""}
                onChange={(e) => update("code", e.target.value)}
                placeholder="准确的份额代码"
                required
              />
              <datalist id="transaction-products">
                {watched.map((item) => (
                  <option value={item.code} key={item.code}>
                    {item.name}
                  </option>
                ))}
              </datalist>
            </Field>
          )}
          <Field
            label={form.kind === "opening" ? "期初总成本" : "金额"}
            hint={
              form.kind === "redeem"
                ? "未确认赎回款可填 0；确认时再录入实际金额。"
                : ["subscribe", "cancel"].includes(form.kind)
                  ? "以真实申请信息记录，确认后更新成交状态。"
                  : undefined
            }
          >
            <input
              type="number"
              step="any"
              min="0"
              value={form.amount}
              onChange={(e) => update("amount", e.target.value)}
              placeholder="0.00"
              required
            />
          </Field>
          {quantityRequired && (
            <Field label="份额 / 数量">
              <input
                type="number"
                step="any"
                min="0"
                value={form.quantity || ""}
                onChange={(e) => update("quantity", e.target.value)}
                required
              />
            </Field>
          )}
          {[
            "buy",
            "sell",
            "subscribe",
            "redeem",
            "confirm",
            "deposit",
            "withdraw",
            "dividend",
            "reinvest",
            "fx",
          ].includes(form.kind) && (
            <Field label="已知费用">
              <input
                type="number"
                step="any"
                min="0"
                value={form.fee || "0"}
                onChange={(e) => update("fee", e.target.value)}
              />
            </Field>
          )}
          {form.currency !== "CNY" &&
            ["deposit", "withdraw", "opening"].includes(form.kind) && (
              <Field
                label="发生日汇率（外币 → CNY）"
                hint="缺失时保留原币记录，累计人民币盈亏显示为未知。"
              >
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={form.fxRateToCny || ""}
                  onChange={(e) => update("fxRateToCny", e.target.value)}
                  placeholder="可选：1 外币对应人民币"
                />
              </Field>
            )}
          {form.kind === "fx" && (
            <>
              <Field label="换入币种">
                <select
                  value={form.toCurrency || "USD"}
                  onChange={(e) =>
                    update(
                      "toCurrency",
                      e.target.value as TransactionInput["toCurrency"],
                    )
                  }
                >
                  {["USD", "CNY", "HKD", "GBP", "EUR"].map((currency) => (
                    <option key={currency}>{currency}</option>
                  ))}
                </select>
              </Field>
              <Field label="实际换入金额">
                <input
                  type="number"
                  step="any"
                  min="0"
                  value={form.toAmount || ""}
                  onChange={(e) => update("toAmount", e.target.value)}
                  required
                />
              </Field>
            </>
          )}
        </div>
        <Field label="备注（可选）">
          <textarea
            rows={2}
            value={form.note || ""}
            onChange={(e) => update("note", e.target.value)}
            placeholder="可记录成交来源或需要复核的信息"
          />
        </Field>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <span>
            <ShieldCheck size={14} />
            保留记录轨迹，支持冲销撤销
          </span>
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Check size={15} />
            )}
            保存记录
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PlanModal({
  watched,
  onClose,
  onSave,
}: {
  watched: Instrument[];
  onClose: () => void;
  onSave: (plan: Omit<InvestmentPlan, "id">) => Promise<void>;
}) {
  const [plan, setPlan] = useState<Omit<InvestmentPlan, "id">>({
    code: watched[0]?.code || "",
    amount: "",
    currency: "CNY",
    frequency: "monthly",
    nextDate: today(),
    account: "主账户",
    active: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave(plan);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="建立投资计划"
      subtitle="计划只用于记录，不会自动发起交易。"
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="产品代码">
            <input
              list="plan-products"
              value={plan.code}
              onChange={(e) => setPlan({ ...plan, code: e.target.value })}
              required
            />
            <datalist id="plan-products">
              {watched.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="每次计划金额">
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={plan.amount}
              onChange={(e) => setPlan({ ...plan, amount: e.target.value })}
              required
            />
          </Field>
          <Field label="币种">
            <select
              value={plan.currency}
              onChange={(e) =>
                setPlan({
                  ...plan,
                  currency: e.target.value as InvestmentPlan["currency"],
                })
              }
            >
              {["CNY", "USD", "HKD", "GBP", "EUR"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="频率">
            <select
              value={plan.frequency}
              onChange={(e) =>
                setPlan({
                  ...plan,
                  frequency: e.target.value as InvestmentPlan["frequency"],
                })
              }
            >
              <option value="daily">每个交易日</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </Field>
          <Field label="下次计划日期">
            <input
              type="date"
              value={plan.nextDate}
              onChange={(e) => setPlan({ ...plan, nextDate: e.target.value })}
              required
            />
          </Field>
          <Field label="账户">
            <input
              value={plan.account}
              onChange={(e) => setPlan({ ...plan, account: e.target.value })}
              required
            />
          </Field>
        </div>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <Loader2 size={14} className="spin" />}保存计划
          </button>
        </div>
      </form>
    </Modal>
  );
}
