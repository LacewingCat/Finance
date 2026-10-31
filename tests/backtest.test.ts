import { describe, expect, it } from 'vitest';
import { replayAction, replayDecisions, type ReplayInput, type ReplayEpisode } from '../src/server/backtest.js';

// These are invented contract fixtures, never claimed as genuine strategy history.
function fixture(count = 30): ReplayInput {
  return {
    schemaVersion: 1, asOf: '2026-03-01T00:00:00Z', source: { kind: 'synthetic', description: 'Invented unit-test examples; not investment evidence' },
    horizonSeconds: 86400, horizonToleranceSeconds: 0, maxQuoteAgeSeconds: 120,
    episodes: Array.from({ length: count }, (_, index): ReplayEpisode => {
      const generatedAt = new Date(Date.UTC(2026, 0, index + 1, 1)).toISOString();
      const end = new Date(Date.UTC(2026, 0, index + 2, 1)).toISOString();
      return { id: `invented-${index}`, instrument: 'TEST', currency: 'CNY', generatedAt,
        quote: { observedAt: generatedAt, publishedAt: generatedAt, price: '10', priceKind: 'trade' },
        portfolio: { observedAt: generatedAt, publishedAt: generatedAt, cash: '10000', quantity: '1000', sellableQuantity: '1000' },
        rules: { observedAt: generatedAt, publishedAt: generatedAt, tradingAllowed: true, buyAllowed: true, lotSize: '1', minBuyAmount: '1', maxTradeAmount: '5000', minimumCash: '100', maxPositionPct: 90, feeRate: .01, fixedFee: '1', slippageBps: 0 },
        requestedNotional: '1000', decision: { buy: .95, sell: .02, hold: .03, reviewConfidence: .95 },
        outcome: { observedAt: end, publishedAt: end, price: '11', priceKind: 'trade' } };
    }),
  };
}
const evaluate = (data: ReplayInput) => replayDecisions(data, { allowSynthetic: true, now: new Date('2026-03-02T00:00:00Z') });

describe('offline historical replay', () => {
  it('does not create evidence from missing or synthetic decision history', () => {
    expect(replayDecisions().status).toBe('unavailable');
    expect(replayDecisions(fixture()).status).toBe('unavailable');
    const result = evaluate(fixture(29));
    expect(result.status).toBe('insufficient'); expect(result.performance).toBeNull(); expect(result.calibration).toBeNull();
  });
  it('returns unavailable for malformed values rather than crashing or coercing them', () => {
    const data = fixture(); data.episodes[0].quote.price = 'NaN';
    expect(evaluate(data).status).toBe('unavailable');
    data.episodes[0].quote.price = '0'; expect(evaluate(data).status).toBe('unavailable');
    expect(replayDecisions({ ...fixture(), unknownFutureFeature: 1 }).status).toBe('unavailable');
  });
  it('requires both raw action and review confidence strictly greater than 90%', () => {
    expect(replayAction({ buy: .9, sell: .05, hold: .05, reviewConfidence: .99 })).toBe('Hold');
    expect(replayAction({ buy: .95, sell: .02, hold: .03, reviewConfidence: .9 })).toBe('Hold');
    expect(replayAction({ buy: .90000001, sell: .04999999, hold: .05, reviewConfidence: .90000001 })).toBe('Buy');
  });
  it('compares against Hold using only known fees and integer trading units', () => {
    const result = evaluate(fixture()); expect(result.status).toBe('synthetic');
    expect(result.evaluations[0]).toMatchObject({ action: 'Buy', label: 'Buy', quantity: '100', fee: '11.00', initialValue: '20000', holdFinalValue: '21000', simulatedFinalValue: '21089', excessVsHold: '89' });
    expect(result.performance?.byCurrency[0].sumEpisodeExcessVsHold).toBe('2670');
    expect(result.calibration?.brierScore).toBeCloseTo(.0038);
  });
  it('rejects prices, account states or fee rules first published after the decision', () => {
    for (const field of ['quote', 'portfolio', 'rules'] as const) {
      const data = fixture(); data.episodes[0][field].publishedAt = '2026-01-01T01:00:01Z';
      const result = evaluate(data); expect(result.status).toBe('insufficient');
      expect(result.rejected[0].reason).toContain('前视'); expect(result.eligibleSamples).toBe(29);
    }
  });
  it('does not use future prices to pick quantity, fees or determine trade feasibility', () => {
    const up = fixture(), down = fixture(); for (const row of down.episodes) row.outcome.price = '1';
    const a = evaluate(up), b = evaluate(down);
    expect(a.evaluations[0].quantity).toBe(b.evaluations[0].quantity); expect(a.evaluations[0].fee).toBe(b.evaluations[0].fee);
    expect(b.evaluations[0].excessVsHold).toBe('-911'); expect(b.performance?.falsePositiveRate).toBe(1);
    for (const row of up.episodes) row.rules.maxTradeAmount = '1005';
    expect(evaluate(up).eligibleSamples).toBe(0); expect(evaluate(up).rejected[0].reason).toContain('含费用');
  });
  it('rejects unsettled sells, insufficient cash, closed markets and stale or wrong-type prices', () => {
    const cases: [string, (row: ReplayEpisode) => void][] = [
      ['可卖', row => { row.decision = { buy: .02, sell: .95, hold: .03, reviewConfidence: .95 }; row.portfolio.sellableQuantity = '99'; }],
      ['现金不足', row => { row.portfolio.cash = '1000'; }],
      ['不允许交易', row => { row.rules.tradingAllowed = false; }],
      ['最大时延', row => { row.quote.observedAt = '2025-12-31T00:00:00Z'; }],
      ['成交报价', row => { row.quote.priceKind = 'nav'; }],
    ];
    for (const [reason, mutate] of cases) { const data = fixture(); mutate(data.episodes[0]); const result = evaluate(data); expect(result.rejected[0].reason).toContain(reason); expect(result.eligibleSamples).toBe(29); }
  });
  it('rejects incorrect label horizons, unreleased outcomes, duplicates and overlapping windows', () => {
    const horizon = fixture(); horizon.episodes[0].outcome.observedAt = '2026-01-02T02:00:00Z'; horizon.episodes[0].outcome.publishedAt = '2026-01-02T02:00:00Z';
    expect(evaluate(horizon).rejected[0].reason).toContain('标签期限');
    const future = fixture(); future.episodes[0].outcome.publishedAt = '2026-03-02T00:00:00Z';
    expect(evaluate(future).rejected[0].reason).toContain('尚未发布');
    const duplicate = fixture(); duplicate.episodes.push(structuredClone(duplicate.episodes[0]));
    expect(evaluate(duplicate).rejected.some(row => row.reason.includes('重复'))).toBe(true);
    const overlap = fixture(); const extra = structuredClone(overlap.episodes[0]); extra.id = 'invented-overlap'; overlap.episodes.push(extra);
    expect(evaluate(overlap).rejected.some(row => row.reason.includes('窗口重叠'))).toBe(true);
  });
  it('separates currencies and reports stability and fee-adjusted false positives', () => {
    const data = fixture();
    for (const [i, row] of data.episodes.entries()) {
      if (i % 2) row.decision = { buy: .02, sell: .95, hold: .03, reviewConfidence: .95 };
      if (i < 10) { row.currency = 'USD'; row.instrument = 'US-TEST'; }
      row.outcome.price = '10';
    }
    const result = evaluate(data);
    expect(result.performance?.byCurrency).toHaveLength(2); expect(result.performance?.falsePositiveRate).toBe(1);
    expect(result.performance?.switchRate).toBe(1); expect(result.evaluations.every(row => row.label === 'Hold')).toBe(true);
  });
});
