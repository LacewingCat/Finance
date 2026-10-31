/** Explicitly authorized, isolated API contract probe. Default invocation never loads a key or calls a model. */
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiService } from '../src/server/ai.js';
import { Store } from '../src/server/store.js';
import { recordTransaction } from '../src/server/ledger.js';
import { BudgetError, type BudgetStore, type Reservation } from '../src/server/budget.js';
import { DEFAULT_SETTINGS } from '../src/server/config.js';
import type { AppSettings, PortfolioSnapshot, ProductData, TransactionInput } from '../src/shared/types.js';

const HARD_LIMIT_MICROS = 200_000;
const DIRECTORY = '/private/tmp/finance-api-verification';
const DATABASE = join(DIRECTORY, 'verification.sqlite');
const EVIDENCE = join(DIRECTORY, 'expense-records.json');
const allowedStages = ['brief', 'decisions', 'chat', 'record', 'decisions-contract', 'record-contract', 'decisions-contract-2', 'record-contract-2'] as const;
type Stage = typeof allowedStages[number];
const args = process.argv.slice(2);
const stageArg = args.find(a => a.startsWith('--stage='))?.slice(8);
if (args.some(a => a !== '--live' && a !== '--retry-free-failure' && !a.startsWith('--stage=')) || stageArg && !allowedStages.includes(stageArg as Stage)) throw new Error('Unsupported probe argument or stage');
if (!args.includes('--live')) {
  console.log(JSON.stringify({ mode: 'dry-run', paidCalls: 0, hardLimitUSD: '0.20', database: DATABASE, note: 'Use --live explicitly. Only synthetic data; production settings and ledger are never opened.' }));
} else {
  process.umask(0o077);
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  // Parse only the explicitly authorized project file in memory. Never print its contents or inspect other profiles.
  const key = parseEnv(readFileSync(join(workspace, '.env.local'), 'utf8')).OPENAI_API_KEY?.trim();
  if (!key) throw new Error('Authorized project key is not configured');
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  chmodSync(DIRECTORY, 0o700);
  const store = new Store(DATABASE);
  const started = new Date();
  const now = () => new Date();
  const safe = (value: unknown) => JSON.parse(JSON.stringify(value, (_name, item) => typeof item === 'string' ? item.split(key).join('[REDACTED]').replace(/sk-[\w-]+/g, '[REDACTED]') : item));
  const accounted = () => store.list<Reservation>('ai-budget').reduce((n, r) => n + (r.status === 'settled' ? r.actualMicros ?? r.reservedMicros : r.status === 'released' ? 0 : r.reservedMicros), 0);
  const guardedStore: BudgetStore = {
    get: store.get.bind(store), list: store.list.bind(store), atomic: store.atomic.bind(store),
    put(namespace, id, value) {
      if (namespace === 'ai-budget' && (value as Reservation).status === 'reserved') {
        const proposed = value as Reservation;
        const existing = store.list<Reservation>('ai-budget').filter(r => r.id !== id).reduce((n, r) => n + (r.status === 'settled' ? r.actualMicros ?? r.reservedMicros : r.status === 'released' ? 0 : r.reservedMicros), 0);
        if (existing + proposed.reservedMicros > HARD_LIMIT_MICROS) throw new BudgetError('Lifetime probe hard limit exhausted; request not sent');
      }
      store.put(namespace, id, value);
    },
  };
  const save = () => {
    const evidence = safe({ generatedAt: now().toISOString(), database: DATABASE, hardLimitMicros: HARD_LIMIT_MICROS, accountedMicros: accounted(), probeWindowOnly: true, creditDeclaration: 'Synthetic one-hour admission fixture; production credit settings are never opened.', reservations: store.list('ai-budget'), audits: store.list('ai-audit'), providerUsage: store.list('probe-provider-usage'), freeRequests: store.list('probe-free-requests'), previousAttempts: store.list('probe-attempts'), results: store.list('probe-results') });
    writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    chmodSync(EVIDENCE, 0o600);
  };
  const settings: AppSettings = { ...structuredClone(DEFAULT_SETTINGS), apiEnabled: true, creditConfirmed: true, monthlyLimit: '5.20', creditAmount: '10', creditStartsAt: new Date(started.getTime() - 1000).toISOString(), creditExpiresAt: new Date(started.getTime() + 3600_000).toISOString(), model: 'gpt-6.1-sol', reasoning: 'medium', monitoring: false, allowedRead: true, allowedWrite: true };
  const transport: typeof fetch = async (input, init) => {
    const url = String(input), method = init?.method ?? 'GET';
    if (url === 'https://api.openai.com/v1/models' && method === 'GET') {
      // At most two attempts for the free catalog only. Paid POSTs are never retried.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const at = now().toISOString();
        try {
          const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
          store.put('probe-free-requests', at, { at, endpoint: url, attempt, httpStatus: response.status });
          return response;
        } catch (error) {
          const e = error as {name?: string; cause?: {code?: string}};
          store.put('probe-free-requests', at, { at, endpoint: url, attempt, errorName: e.name, causeCode: e.cause?.code });
          if (attempt === 2) throw new Error('Free model catalog network failure');
        }
      }
      throw new Error('Free model catalog failed');
    }
    if (!['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/decisions'].includes(url) || method !== 'POST') throw new Error('Probe endpoint not allowed');
    const requestId = new Headers(init?.headers).get('X-Client-Request-Id');
    const reservation = requestId ? store.get<Reservation>('ai-budget', requestId) : undefined;
    // All lifetime records in this isolated database count, including other months and ambiguous failures.
    if (!reservation || reservation.status !== 'reserved' || accounted() > HARD_LIMIT_MICROS) throw new Error('Probe hard limit or reservation check failed; request not sent');
    save(); // Durable pre-request accounting, even if the process later stops.
    const response = await fetch(input, init);
    const body = await response.clone().json().catch(() => ({})) as Record<string, unknown>;
    const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : undefined;
    store.put('probe-provider-usage', requestId!, safe({ requestId, capturedAt: now().toISOString(), endpoint: url, httpStatus: response.status, providerRequestId: response.headers.get('x-request-id'), model: body.model, responseId: body.id, status: body.status, usage: body.usage, answers: body.answers, syntheticOutput: body.output, outputTypes: Array.isArray(body.output) ? body.output.map((i: Record<string, unknown>) => i.type) : undefined, error: error ? { type: error.type, code: error.code, param: error.param } : undefined }));
    save();
    return response;
  };
  const service = new AiService(guardedStore, { fetch: transport, keyProvider: () => key, now });
  const instrument = { code: 'TEST-API', name: '合成验收基金（非真实资产）', kind: 'fund' as const, currency: 'CNY' as const, market: 'CN' as const };
  const snapshot: PortfolioSnapshot = { id: 'synthetic-api-verification', createdAt: started.toISOString(), revision: 0, positions: [{ code: instrument.code, name: instrument.name, currency: 'CNY', quantity: '100', sellable: '0', cost: '100', averageCost: '1', price: '1', marketValue: '100', pnl: '0', instrument, accounts: [{ account: 'SYNTHETIC_VERIFICATION', quantity: '100', sellable: '0' }] }], cash: { CNY: '900' }, accountCash: { SYNTHETIC_VERIFICATION: { CNY: '900' } }, frozen: {}, receivables: {}, totalValue: '1000', investedCost: '100', realizedPnl: '0', unrealizedPnl: '0', income: '0', fees: '0', externalFlows: '1000', totalPnl: '0', reconciliation: '0', warnings: ['全部数字均为接口验收用合成资料，不代表真实价格或用户资产。'], risk: settings.risk };
  const product: ProductData = { instrument, observation: { code: instrument.code, price: '1', asOf: '2026-10-30', fetchedAt: started.toISOString(), currency: 'CNY', priceKind: 'nav', source: 'synthetic API verification fixture', sourceUrl: 'https://example.com/synthetic-fixture', quality: 'valid' }, history: Array.from({ length: 20 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, nav: '1' })), exposures: [], documents: [], errors: [], fetchedAt: started.toISOString() };
  const stages: readonly Stage[] = stageArg ? [stageArg as Stage] : ['brief', 'decisions', 'chat', 'record'];
  try {
    for (const stage of stages) {
      const prior = store.get<{status:string;accountedDeltaMicros:number}>('probe-results', stage);
      if (prior) {
        if (args.includes('--retry-free-failure') && prior.status === 'failed' && prior.accountedDeltaMicros === 0) {
          store.put('probe-attempts', `${stage}:${now().toISOString()}`, prior);
          store.remove('probe-results', stage);
        } else { console.log(JSON.stringify({ stage, skipped: 'Already attempted. No automatic paid retry.' })); continue; }
      }
      if (accounted() >= HARD_LIMIT_MICROS) break;
      const cfg = stage === 'brief' ? settings : { ...settings, model: 'gpt-6-luna', reasoning: 'none' as const };
      store.put('settings', 'app', cfg);
      const before = accounted();
      store.put('probe-results', stage, { stage, startedAt: now().toISOString(), status: 'started', model: cfg.model });
      save();
      try {
        let result: unknown;
        // Read-only connection probe before the two explicitly requested final contracts.
        if (stage.endsWith('-2')) await service.models();
        if (stage === 'brief') {
          service.savePrompt('brief', '这是隔离接口验收。用中文至多两句话说明输入为合成资产、当前缺少个性化风险设置；不要生成投资建议或长篇分析。');
          const brief = await service.brief(snapshot, [], cfg);
          if (brief.status !== 'generated') throw new Error(brief.text);
          result = brief;
        } else if (stage.startsWith('decisions')) {
          if (stage.startsWith('decisions-contract')) service.savePrompt('decisions', '本次只做合成数据的API协议契约测试，所有输出都无投资意义，不为真实资产给建议。请验证已明确给出的测试夹具：选择Hold；quality问题请给等级3，用于验证离散score的解析。不要把合成数据视为真实行情。');
          const decision = await service.decide(snapshot, product, cfg);
          if (decision.status !== 'valid' && decision.status !== 'refused') throw new Error(decision.reason ?? 'Invalid decision');
          if (stage.startsWith('decisions-contract') && decision.status !== 'valid') throw new Error('Synthetic contract did not return choice and score');
          result = decision;
        } else if (stage === 'chat') {
          result = await service.chat(snapshot, '仅用一句话解释：模型的Buy/Sell/Hold选择概率是否等于投资盈利概率？', [], cfg, 'analysis', () => { throw new Error('Analysis cannot record'); });
        } else {
          if (stage.startsWith('record-contract')) service.savePrompt('record', '本次连接的是隔离的合成账本，record_transaction只登记测试数据，不接触真实账本或金融账户。用户明确报告的已发生测试入金可以登记；不要把测试数据当真实资产。若本条消息给齐账户、币种、日期、金额、费用，请调用一次record_transaction；不得虚构其他值。');
          const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(started);
          const record = (input: TransactionInput) => { if (input.account !== 'SYNTHETIC_VERIFICATION' || input.kind !== 'deposit' || input.currency !== 'CNY' || input.amount !== '1.23') throw new Error('Synthetic callback rejected unexpected values'); return recordTransaction(store, input); };
          const reply = await service.chat(snapshot, `请在隔离的合成账本中记录一笔已发生的测试入金：账户SYNTHETIC_VERIFICATION，币种CNY，日期${day}，金额1.23，费用0。没有产品代码或份额。全部为测试数据，仅供API工具调用验收。`, [], cfg, 'record', record, `verification-${stage}-once`);
          if (!reply.receipts?.length) throw new Error('No synthetic recording receipt returned');
          result = reply;
        }
        const status = stage === 'decisions' && (result as {status?:string}).status === 'refused' ? 'refusal_handled' : 'passed';
        store.put('probe-results', stage, safe({ stage, startedAt: store.get<Record<string, unknown>>('probe-results', stage)?.startedAt, completedAt: now().toISOString(), status, model: cfg.model, accountedDeltaMicros: accounted() - before, result }));
        console.log(JSON.stringify({ stage, status, accountedMicros: accounted() }));
      } catch (error) {
        store.put('probe-results', stage, safe({ stage, completedAt: now().toISOString(), status: 'failed', model: cfg.model, accountedDeltaMicros: accounted() - before, error: error instanceof Error ? error.message : 'Probe failed' }));
        console.log(JSON.stringify({ stage, status: 'failed', accountedMicros: accounted(), note: 'Inspect redacted external evidence; no automatic retry.' }));
        break;
      } finally { save(); }
    }
  } finally {
    save();
    console.log(JSON.stringify({ database: DATABASE, evidence: EVIDENCE, accountedMicros: accounted(), hardLimitMicros: HARD_LIMIT_MICROS, productionUntouched: true }));
    store.close();
  }
}
