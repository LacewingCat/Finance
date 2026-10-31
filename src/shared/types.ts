export type Currency = "CNY" | "USD" | "HKD" | "GBP" | "EUR";
export type InstrumentKind =
  | "fund"
  | "qdii"
  | "fof"
  | "etf"
  | "stock"
  | "money";
export type Market = "CN" | "HK" | "US" | "UK" | "EU";
export interface Instrument {
  code: string;
  name: string;
  kind: InstrumentKind;
  currency: Currency;
  market: Market;
  manager?: string;
  shareClass?: string;
  aliases?: string[];
  sourceUrl?: string;
  watched?: boolean;
  purchasable?: boolean;
  channel?: string;
  minBuy?: string;
  lotSize?: string;
  settlementDays?: number;
  channelLimit?: string;
  feeRate?: string;
  rulesVerified?: boolean;
}
export interface MarketObservation {
  code: string;
  price: string;
  accumulatedNav?: string;
  changePct?: string;
  asOf: string;
  fetchedAt: string;
  currency: Currency;
  priceKind: "nav" | "trade" | "iopv" | "estimate";
  source: string;
  sourceUrl: string;
  quality: "valid" | "stale" | "conflict" | "unverified";
  delaySeconds?: number;
}
export interface HistoryPoint {
  date: string;
  nav: string;
  accumulatedNav?: string;
  changePct?: string;
}
export interface Exposure {
  code?: string;
  name: string;
  weight: string;
  basis: "net_assets" | "total_assets";
  kind: string;
  reportDate: string;
  publishedAt?: string;
  sourceUrl: string;
  children?: Exposure[];
}
export interface DocumentCard {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt?: string;
  imageUrl?: string;
  category: "report" | "news" | "product";
}
export interface ProductData {
  instrument: Instrument;
  observation?: MarketObservation;
  historyKind?: "nav" | "trade";
  historySourceUrl?: string;
  history: HistoryPoint[];
  exposures: Exposure[];
  documents: DocumentCard[];
  errors: string[];
  fetchedAt: string;
}
export type TransactionKind =
  | "deposit"
  | "withdraw"
  | "buy"
  | "sell"
  | "subscribe"
  | "redeem"
  | "confirm"
  | "settle"
  | "cancel"
  | "dividend"
  | "reinvest"
  | "fee"
  | "tax"
  | "fx"
  | "opening";
export interface TransactionInput {
  idempotencyKey: string;
  kind: TransactionKind;
  code?: string;
  account: string;
  currency: Currency;
  date: string;
  amount: string;
  quantity?: string;
  fee?: string;
  parentId?: string;
  toCurrency?: Currency;
  toAmount?: string;
  fxRateToCny?: string;
  note?: string;
}
export interface LedgerTransaction extends TransactionInput {
  id: string;
  createdAt: string;
  reversedBy?: string;
  reverses?: string;
}
export interface InvestmentPlan {
  id: string;
  code: string;
  amount: string;
  currency: Currency;
  frequency: "daily" | "weekly" | "monthly";
  nextDate: string;
  account: string;
  active: boolean;
}
export interface RiskSettings {
  minimumCash: string;
  singleTradeLimit: string;
  maxPositionPct: string;
  configured: boolean;
}
export interface AppSettings {
  model: string;
  reasoning: string;
  apiEnabled: boolean;
  monthlyLimit: string;
  creditAmount: string;
  creditStartsAt: string;
  creditExpiresAt: string;
  creditConfirmed: boolean;
  monitoring: boolean;
  risk: RiskSettings;
  theme: "dark" | "light";
  allowedRead: boolean;
  allowedWrite: boolean;
  holidays: Record<string, string[]>;
  calendarVerifiedThrough: Record<string, string>;
  fxRates: Record<string, string>;
  fxAsOf: string;
}
export interface Position {
  code: string;
  name: string;
  currency: Currency;
  quantity: string;
  sellable: string;
  cost: string;
  averageCost: string;
  price?: string;
  marketValue?: string;
  pnl?: string;
  pnlPct?: string;
  observation?: MarketObservation;
  instrument: Instrument;
  accounts?: {
    account: string;
    quantity: string;
    sellable: string;
    marketValue?: string;
  }[];
}
export interface PortfolioSnapshot {
  id: string;
  createdAt: string;
  revision: number;
  positions: Position[];
  cash: Record<string, string>;
  frozen: Record<string, string>;
  receivables: Record<string, string>;
  totalValue: string | null;
  investedCost: string;
  realizedPnl: string;
  unrealizedPnl: string | null;
  income: string;
  fees: string;
  externalFlows: string;
  totalPnl: string | null;
  reconciliation: string | null;
  warnings: string[];
  risk: RiskSettings;
  accountCash?: Record<string, Record<string, string>>;
  /** Optional for older stored snapshots. New snapshots always carry FX evidence. */
  fxRates?: Record<string, string>;
  fxAsOf?: string;
}
export interface DecisionResult {
  code: string;
  snapshotId: string;
  asOf: string;
  generatedAt: string;
  buy: number | null;
  sell: number | null;
  hold: number | null;
  confidence: number | null;
  score: number | null;
  status: "valid" | "insufficient" | "refused" | "error" | "stale";
  reason?: string;
  model: string;
  promptVersion: number;
}
export interface AmountCandidate {
  amount: string;
  quantity?: string;
  percentage?: string;
  account?: string;
  currency?: Currency;
  estimatedFee?: string;
  estimatedNet?: string;
  cashRequired?: string;
  /** Display conversion only; allocation uses candidateCashRequiredCny(). */
  amountCny?: string;
  cashRequiredCny?: string;
  fxRateToCny?: string;
  fxAsOf?: string;
  score?: number;
  urgency?: number;
  reason?: string;
}
export interface AlertOutbox {
  id: string;
  code: string;
  direction: "Buy" | "Sell";
  snapshotId: string;
  createdAt: string;
  expiresAt: string;
  probability: number;
  reviewConfidence: number;
  candidates: AmountCandidate[];
  summary: string;
  status: "local" | "queued" | "received" | "failed" | "expired";
}
export interface BudgetSummary {
  month: string;
  spent: string;
  reserved: string;
  limit: string;
  remaining: string;
  creditRemaining: string;
  enabled: boolean;
  reason?: string;
}
export interface Brief {
  id: string;
  snapshotId: string;
  createdAt: string;
  text: string;
  model?: string;
  status: "generated" | "unavailable" | "error";
}
export interface PromptTemplate {
  name: string;
  label: string;
  text: string;
  version: number;
  updatedAt: string;
}
export interface AppState {
  snapshot: PortfolioSnapshot;
  settings: AppSettings;
  budget: BudgetSummary;
  decisions: DecisionResult[];
  alerts: AlertOutbox[];
  brief?: Brief;
  catalogCount: number;
  watched: Instrument[];
  keyConfigured: boolean;
  documents: DocumentCard[];
  notification: { state: string; message: string };
  monitor: {
    running: boolean;
    lastRefresh?: string;
    intervalSeconds: number;
    errors: string[];
  };
}
