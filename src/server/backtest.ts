import { Decimal } from 'decimal.js';
import { z } from 'zod';

const decimal = z.string().max(80).regex(/^\d+(?:\.\d+)?$/).refine(value => { try { const number = new Decimal(value); return number.isFinite() && number.lte('1000000000000000'); } catch { return false; } }, '数值无效或过大');
const positive = decimal.refine(value => { try { return new Decimal(value).gt(0); } catch { return false; } }, '必须大于零');
const timestamp = z.string().datetime({ offset: true });
const evidence = { observedAt: timestamp, publishedAt: timestamp };
const probability = z.number().finite().min(0).max(1);
export const replayEpisodeSchema = z.object({
  id: z.string().min(1).max(120), instrument: z.string().min(1).max(80), currency: z.enum(['CNY', 'USD', 'HKD', 'GBP', 'EUR']),
  generatedAt: timestamp,
  quote: z.object({ ...evidence, price: positive, priceKind: z.enum(['trade', 'nav', 'estimate']) }).strict(),
  portfolio: z.object({ ...evidence, cash: decimal, quantity: decimal, sellableQuantity: decimal }).strict(),
  rules: z.object({
    ...evidence, tradingAllowed: z.boolean(), buyAllowed: z.boolean(), lotSize: positive, minBuyAmount: decimal,
    maxTradeAmount: positive, minimumCash: decimal, maxPositionPct: z.number().positive().max(100),
    feeRate: z.number().min(0).max(1), fixedFee: decimal, slippageBps: z.number().min(0).max(1000),
  }).strict(),
  requestedNotional: positive,
  decision: z.object({ buy: probability, sell: probability, hold: probability, reviewConfidence: probability }).strict()
    .refine(p => Math.abs(p.buy + p.sell + p.hold - 1) <= 1e-8, 'Buy/Sell/Hold 概率之和必须为 1'),
  outcome: z.object({ ...evidence, price: positive, priceKind: z.enum(['trade', 'nav', 'estimate']) }).strict(),
}).strict();
export const replayInputSchema = z.object({
  schemaVersion: z.literal(1), asOf: timestamp,
  source: z.object({ kind: z.enum(['recorded', 'synthetic']), description: z.string().min(1).max(1000) }).strict(),
  horizonSeconds: z.number().int().min(1).max(366 * 86400),
  horizonToleranceSeconds: z.number().int().min(0).max(3600).default(0),
  maxQuoteAgeSeconds: z.number().int().min(1).max(3600).default(120),
  episodes: z.array(replayEpisodeSchema).max(10_000),
}).strict();
export type ReplayEpisode = z.infer<typeof replayEpisodeSchema>;
export type ReplayInput = z.infer<typeof replayInputSchema>;
export type ReplayAction = 'Buy' | 'Sell' | 'Hold';
export interface ReplayRejection { id: string; reason: string; }
export interface ReplayEvaluation {
  id: string; instrument: string; currency: string; generatedAt: string; action: ReplayAction; label: ReplayAction;
  quantity: string; fee: string; executionPrice: string | null; initialValue: string; holdFinalValue: string;
  simulatedFinalValue: string; excessVsHold: string; excessReturn: number; falsePositive: boolean;
  probabilities: { buy: number; sell: number; hold: number };
}
interface CalibrationBin { action: ReplayAction; bin: number; count: number; meanProbability: number; labelFrequency: number; }
export interface ReplayReport {
  schemaVersion: 1; status: 'unavailable' | 'insufficient' | 'available' | 'synthetic'; reason: string;
  minimumSamples: number; inputSamples: number; eligibleSamples: number; rejected: ReplayRejection[];
  methodology: string[]; evaluations: ReplayEvaluation[];
  performance: null | {
    byCurrency: { currency: string; samples: number; sumEpisodeExcessVsHold: string }[];
    meanExcessReturn: number; executedSignals: number; falsePositiveSignals: number; falsePositiveRate: number | null;
    worstEpisodeExcessReturn: number; transitions: number; actionSwitches: number; switchRate: number | null;
  };
  calibration: null | { label: string; brierScore: number; bins: CalibrationBin[] };
}
const METHODS = [
  '独立 episode 反事实模拟：每条使用其自己的起始账户状态，不是可复利的完整组合资金曲线。跨币种不相加。',
  '进入交易按决策前可得成交报价加声明滑点并按交易单位取整；只扣当次操作费用，期末按未来同类型价格盯市，不假设已成交或已平仓。',
  '事后标签是在同一请求金额、账户与规则约束下，Buy/Sell/Hold 中模拟扣费后期末价值最高者；没有严格正的超额则为 Hold。标签不是盈利保证或实际成交证明。',
  '校准描述概率与上述事后标签的对应关系，Brier 分数不是盈利胜率；30 条只是计算门槛，跨资产相关性和样本选择仍可能使估计不稳定。',
  '来源 recorded 为用户离线声明，工具不能替代对原始成交记录、当时模型输入和历史版本的审计；没有付费调用或模型再生成。',
];
const MINIMUM_SAMPLES = 30;
const baseReport = (reason: string): ReplayReport => ({ schemaVersion: 1, status: 'unavailable', reason, minimumSamples: MINIMUM_SAMPLES, inputSamples: 0, eligibleSamples: 0, rejected: [], methodology: METHODS, evaluations: [], performance: null, calibration: null });
const time = (value: string) => Date.parse(value);

/** Strict thresholds are deliberately not rounded for triggering. */
export function replayAction(decision: ReplayEpisode['decision']): ReplayAction {
  if (decision.reviewConfidence <= .9) return 'Hold';
  return decision.buy > .9 ? 'Buy' : decision.sell > .9 ? 'Sell' : 'Hold';
}
interface Trade { quantity: Decimal; fee: Decimal; executionPrice: Decimal | null; cash: Decimal; quantityAfter: Decimal; }
function tradeFor(episode: ReplayEpisode, action: ReplayAction): Trade {
  const r = episode.rules, p = episode.portfolio;
  const cash = new Decimal(p.cash), quantity = new Decimal(p.quantity), quote = new Decimal(episode.quote.price);
  if (action === 'Hold') return { quantity: new Decimal(0), fee: new Decimal(0), executionPrice: null, cash, quantityAfter: quantity };
  if (!r.tradingAllowed) throw new Error('当时不允许交易');
  if (action === 'Buy' && !r.buyAllowed) throw new Error('当时不可购买');
  const requested = new Decimal(episode.requestedNotional);
  if (requested.gt(r.maxTradeAmount)) throw new Error('请求金额超过当时单笔限额');
  const executionPrice = quote.mul(new Decimal(1).plus(new Decimal(r.slippageBps).div(10000).mul(action === 'Buy' ? 1 : -1)));
  const lot = new Decimal(r.lotSize), units = requested.div(executionPrice).div(lot).floor().mul(lot);
  if (units.lte(0)) throw new Error('金额不足一个交易单位');
  const notional = units.mul(executionPrice);
  const fee = notional.mul(r.feeRate).plus(r.fixedFee).toDecimalPlaces(2, Decimal.ROUND_UP);
  if (notional.plus(fee).gt(r.maxTradeAmount)) throw new Error('含费用金额超过当时单笔限额');
  if (action === 'Buy') {
    if (notional.lt(r.minBuyAmount)) throw new Error('低于当时最低申购/购买金额');
    const remaining = cash.minus(notional).minus(fee), after = quantity.plus(units);
    if (remaining.lt(0)) throw new Error('现金不足以覆盖本金与费用');
    if (remaining.lt(r.minimumCash)) throw new Error('违反最低现金要求');
    const value = remaining.plus(after.mul(quote));
    if (value.lte(0) || after.mul(quote).div(value).mul(100).gt(r.maxPositionPct)) throw new Error('超过当时最大仓位');
    return { quantity: units, fee, executionPrice, cash: remaining, quantityAfter: after };
  }
  if (units.gt(p.sellableQuantity) || units.gt(quantity)) throw new Error('卖出量超过当时可卖数量，不能绕过结算/冻结规则');
  if (cash.plus(notional).minus(fee).lt(0)) throw new Error('卖出所得不足以覆盖费用');
  return { quantity: units, fee, executionPrice, cash: cash.plus(notional).minus(fee), quantityAfter: quantity.minus(units) };
}
function validateTime(episode: ReplayEpisode, input: ReplayInput): void {
  const generated = time(episode.generatedAt);
  if (generated > time(input.asOf)) throw new Error('决策晚于回放截止时间');
  for (const [name, value] of [['报价', episode.quote], ['账户', episode.portfolio], ['规则及费用', episode.rules]] as const) {
    if (time(value.observedAt) > time(value.publishedAt) || time(value.publishedAt) > generated) throw new Error(`${name}包含决策当时尚未公开的信息（前视）`);
  }
  if (generated - time(episode.quote.observedAt) > input.maxQuoteAgeSeconds * 1000) throw new Error('决策前报价超过声明的最大时延');
  if (episode.quote.priceKind !== 'trade' || episode.outcome.priceKind !== 'trade') throw new Error('当前回放只接受同口径成交报价，基金未知申赎净值与估算值不能视为可执行成交价');
  const outcome = time(episode.outcome.observedAt);
  if (outcome <= generated || time(episode.outcome.publishedAt) < outcome || time(episode.outcome.publishedAt) > time(input.asOf)) throw new Error('事后价格日期无效、尚未发布或并非决策之后');
  if (Math.abs(outcome - generated - input.horizonSeconds * 1000) > input.horizonToleranceSeconds * 1000) throw new Error('事后价格不在预先声明的标签期限内');
  if (new Decimal(episode.portfolio.sellableQuantity).gt(episode.portfolio.quantity)) throw new Error('可卖数量不能超过持有数量');
}

/** Pure offline evaluation. Missing history returns unavailable; synthetic histories are test-only. */
export function replayDecisions(raw?: unknown, options: { allowSynthetic?: boolean; now?: Date } = {}): ReplayReport {
  if (raw === undefined || raw === null) return baseReport('没有离线真实决策历史，无法评估策略或校准');
  const parsed = replayInputSchema.safeParse(raw);
  if (!parsed.success) return baseReport(`输入格式无效：${parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}`);
  const input = parsed.data, report = baseReport('尚未完成评估'); report.inputSamples = input.episodes.length;
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || time(input.asOf) > now) { report.reason = '回放截止时间在未来或当前时间无效'; return report; }
  if (input.source.kind === 'synthetic' && !options.allowSynthetic) { report.reason = '合成数据不能作为真实决策历史进行策略验收'; return report; }
  if (!input.episodes.length) { report.reason = '没有离线真实决策历史，无法评估策略或校准'; return report; }
  const ids = new Set<string>(), occupied = new Map<string, number>();
  const episodes = [...input.episodes].sort((a, b) => time(a.generatedAt) - time(b.generatedAt));
  const evaluations: ReplayEvaluation[] = [];
  for (const episode of episodes) {
    try {
      if (ids.has(episode.id)) throw new Error('重复样本 ID'); ids.add(episode.id);
      validateTime(episode, input);
      const key = `${episode.instrument}|${episode.currency}`;
      if ((occupied.get(key) ?? -Infinity) > time(episode.generatedAt)) throw new Error('同一资产的标签窗口重叠，不能重复计算样本');
      const initial = new Decimal(episode.portfolio.cash).plus(new Decimal(episode.portfolio.quantity).mul(episode.quote.price));
      if (initial.lte(0)) throw new Error('起始资产价值不足');
      const action = replayAction(episode.decision), trade = tradeFor(episode, action);
      const future = new Decimal(episode.outcome.price);
      const hold = new Decimal(episode.portfolio.cash).plus(new Decimal(episode.portfolio.quantity).mul(future));
      const final = trade.cash.plus(trade.quantityAfter.mul(future)), excess = final.minus(hold);
      let label: ReplayAction = 'Hold', best = new Decimal(0);
      for (const alternative of ['Buy', 'Sell'] as const) {
        try { const candidate = tradeFor(episode, alternative), delta = candidate.cash.plus(candidate.quantityAfter.mul(future)).minus(hold); if (delta.gt(best)) { best = delta; label = alternative; } }
        catch { /* An action prohibited by the known rules cannot become the outcome label. */ }
      }
      evaluations.push({ id: episode.id, instrument: episode.instrument, currency: episode.currency, generatedAt: episode.generatedAt, action, label,
        quantity: trade.quantity.toFixed(), fee: trade.fee.toFixed(2), executionPrice: trade.executionPrice?.toFixed() ?? null,
        initialValue: initial.toFixed(), holdFinalValue: hold.toFixed(), simulatedFinalValue: final.toFixed(), excessVsHold: excess.toFixed(), excessReturn: excess.div(initial).toNumber(),
        falsePositive: action !== 'Hold' && excess.lte(0), probabilities: { buy: episode.decision.buy, sell: episode.decision.sell, hold: episode.decision.hold } });
      occupied.set(key, time(episode.outcome.observedAt));
    } catch (error) { report.rejected.push({ id: episode.id, reason: error instanceof Error ? error.message : '无效样本' }); }
  }
  report.eligibleSamples = evaluations.length;
  if (evaluations.length < MINIMUM_SAMPLES) { report.status = 'insufficient'; report.reason = `只有 ${evaluations.length} 条可用非重叠样本，少于 ${MINIMUM_SAMPLES} 条；不输出收益汇总或校准结论`; return report; }
  const currencies = new Map<string, { currency: string; samples: number; sum: Decimal }>();
  let transitions = 0, switches = 0, brier = 0; const priorActions = new Map<string, ReplayAction>();
  const bins = new Map<string, { action: ReplayAction; bin: number; count: number; sum: number; observed: number }>();
  for (const item of evaluations) {
    const group = currencies.get(item.currency) ?? { currency: item.currency, samples: 0, sum: new Decimal(0) }; group.samples++; group.sum = group.sum.plus(item.excessVsHold); currencies.set(item.currency, group);
    const key = `${item.instrument}|${item.currency}`, prior = priorActions.get(key); if (prior) { transitions++; if (prior !== item.action) switches++; } priorActions.set(key, item.action);
    for (const action of ['Buy', 'Sell', 'Hold'] as const) {
      const p = item.probabilities[action.toLowerCase() as 'buy' | 'sell' | 'hold'], observed = item.label === action ? 1 : 0;
      brier += (p - observed) ** 2;
      const bin = Math.min(9, Math.floor(p * 10)), id = `${action}:${bin}`;
      const bucket = bins.get(id) ?? { action, bin, count: 0, sum: 0, observed: 0 }; bucket.count++; bucket.sum += p; bucket.observed += observed; bins.set(id, bucket);
    }
  }
  const signals = evaluations.filter(row => row.action !== 'Hold'), falsePositives = signals.filter(row => row.falsePositive).length;
  report.evaluations = evaluations;
  report.performance = { byCurrency: [...currencies.values()].map(group => ({ currency: group.currency, samples: group.samples, sumEpisodeExcessVsHold: group.sum.toFixed() })),
    meanExcessReturn: evaluations.reduce((sum, row) => sum + row.excessReturn, 0) / evaluations.length,
    executedSignals: signals.length, falsePositiveSignals: falsePositives, falsePositiveRate: signals.length ? falsePositives / signals.length : null,
    worstEpisodeExcessReturn: Math.min(...evaluations.map(row => row.excessReturn)), transitions, actionSwitches: switches, switchRate: transitions ? switches / transitions : null };
  report.calibration = { label: '在当时规则与同一请求金额下，事后模拟扣费价值最高的操作；非盈利概率或成交证明', brierScore: brier / evaluations.length,
    bins: [...bins.values()].map(bin => ({ action: bin.action, bin: bin.bin, count: bin.count, meanProbability: bin.sum / bin.count, labelFrequency: bin.observed / bin.count })) };
  report.status = input.source.kind === 'synthetic' ? 'synthetic' : 'available';
  report.reason = input.source.kind === 'synthetic' ? '合成数据的计算路径测试，仅验证工具，不证明策略有效' : '可用离线历史已完成描述性回放；不代表策略有效、收益承诺或样本外表现';
  return report;
}
