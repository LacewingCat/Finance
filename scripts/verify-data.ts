import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import { REFERENCE_INSTRUMENTS, fetchCatalog, fetchProduct, parseCsrcNav } from '../src/server/providers.js';
import { validateExposureGraph } from '../src/server/exposure.js';
import type { Instrument } from '../src/shared/types.js';

/** Public metadata only. This verifier never reads the user's database or API credentials. */
const full = process.argv.includes('--full');
if (process.argv.some(arg => arg.startsWith('--') && !['--full', '--quick'].includes(arg))) throw new Error('Usage: tsx scripts/verify-data.ts [--quick|--full]');
if (full && process.argv.includes('--quick')) throw new Error('Choose --quick or --full');
const mode = full ? 'full' : 'quick';
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const requestedDirectory = path.resolve(process.env.FINANCE_DATA_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'Finance'));
// Refuse even an explicit directory under the source tree: report data must not enter Git.
if (requestedDirectory === root || requestedDirectory.startsWith(`${root}${path.sep}`)) throw new Error('FINANCE_DATA_DIR must be outside the source repository');
await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
const directory = await realpath(requestedDirectory);
if (directory === root || directory.startsWith(`${root}${path.sep}`)) throw new Error('FINANCE_DATA_DIR resolves into the source repository');
const filename = path.join(directory, `public-data-verification-${new Date().toISOString().slice(0, 10)}-${mode}.json`);

interface ProductCheck {
  code: string; name: string; manager?: string; kind?: string; checkedAt: string; sourceUrl?: string;
  nav?: { value: string; asOf: string; quality: string; source: string; priceKind?: string };
  history: { count: number; first?: string; last?: string; ascending: boolean };
  exposures: ReturnType<typeof validateExposureGraph>; documents: number; errors: string[];
}
interface VerificationReport {
  schema: 1; mode: string; startedAt: string; updatedAt: string; completed: boolean;
  catalog: { count: number; checkedAt?: string; error?: string };
  selectedCodes: string[]; products: Record<string, ProductCheck>;
  categoryCoverage?: { category: string; sampled: number; navAvailable: number; tradeAvailable: number; historyAvailable: number; limitation?: string }[];
  officialCrosschecks: { status: 'pending' | 'passed' | 'failed'; required: number; completed: number; reason: string; results?: Record<string, { code: string; date: string; status: 'matched' | 'conflict' | 'unavailable' | 'not_applicable'; officialNav?: string; suppliedNav: string; sourceUrl: string; checkedAt: string; error?: string }> };
  acceptance?: { passed: boolean; observations: number; histories: number; managers: number; requiredProducts: number; failures: string[] };
}
let report: VerificationReport;
try {
  const previous = JSON.parse(await readFile(filename, 'utf8')) as VerificationReport;
  if (previous.schema !== 1 || previous.mode !== mode || !previous.products) throw new Error('Incompatible progress');
  report = previous;
  // Retry unsuccessful products when resuming; already verified public data are retained for this UTC day.
  for (const [code, value] of Object.entries(report.products)) if (!value.nav || value.history.count === 0) delete report.products[code];
} catch {
  report = { schema: 1, mode, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completed: false,
    catalog: { count: 0 }, selectedCodes: [], products: {},
    officialCrosschecks: { status: 'pending', required: full ? 30 : 0, completed: 0, reason: '独立官方净值交叉核验尚未完成；销售页面与同供应方历史文件不算独立来源。官方来源限流或校验失败时不绕过、不计为通过。' } };
}
async function save(): Promise<void> {
  report.updatedAt = new Date().toISOString();
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filename);
}

let catalog: Instrument[] = [];
try { catalog = await fetchCatalog(); report.catalog = { count: catalog.length, checkedAt: new Date().toISOString() }; }
catch (error) { report.catalog = { count: 0, checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }; }
const selected = new Map(REFERENCE_INSTRUMENTS.map(instrument => [instrument.code, instrument]));
if (full) {
  // Multiple managers and strategies, rather than 120 adjacent share classes of one manager.
  const prefixes = ['易方达', '华夏', '南方', '广发', '嘉实', '富国', '博时', '招商', '工银', '汇添富', '国泰', '鹏华'];
  for (const prefix of prefixes) {
    let added = 0;
    for (const instrument of catalog) {
      if (!instrument.name.startsWith(prefix) || /后端|已终止/.test(instrument.name) || ['etf', 'money'].includes(instrument.kind) || selected.has(instrument.code)) continue;
      selected.set(instrument.code, instrument); if (++added >= 12) break;
    }
  }
  for (const kind of ['money', 'etf'] as const) {
    for (const instrument of catalog.filter(item => item.kind === kind).slice(0, 6)) selected.set(instrument.code, instrument);
  }
}
report.products = Object.fromEntries(Object.entries(report.products).filter(([code]) => selected.has(code)));
report.selectedCodes = [...selected.keys()]; report.completed = false; await save();
for (const instrument of selected.values()) {
  if (report.products[instrument.code]) continue;
  try {
    const product = await fetchProduct(instrument); const observation = product.observation;
    report.products[instrument.code] = {
      code: instrument.code, name: product.instrument.name, manager: product.instrument.manager, kind: product.instrument.kind, checkedAt: product.fetchedAt, sourceUrl: product.instrument.sourceUrl,
      nav: observation ? { value: observation.price, asOf: observation.asOf, quality: observation.quality, source: observation.source, priceKind: observation.priceKind } : undefined,
      history: { count: product.history.length, first: product.history.at(0)?.date, last: product.history.at(-1)?.date, ascending: product.history.every((point, i) => i === 0 || point.date > product.history[i - 1].date) },
      exposures: validateExposureGraph(product.exposures), documents: product.documents.length, errors: product.errors,
    };
  } catch (error) {
    report.products[instrument.code] = { code: instrument.code, name: instrument.name, checkedAt: new Date().toISOString(), history: { count: 0, ascending: true }, exposures: { valid: false, issues: [], coverage: [] }, documents: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
  await save();
  const check = report.products[instrument.code];
  console.log(`${Object.keys(report.products).length}/${selected.size} ${instrument.code} NAV=${check.nav?.asOf ?? 'missing'} history=${check.history.count} errors=${check.errors.length}`);
}
const checks = Object.values(report.products);
report.categoryCoverage = ['mixed', 'bond', 'money', 'etf', 'feeder', 'qdii', 'fof', 'lof'].map(category => {
  const rows = checks.filter(check => {
    const instrument = selected.get(check.code)!; const name = instrument.name;
    return category === 'mixed' ? /混合/.test(name) : category === 'bond' ? /债券/.test(name) : category === 'feeder' ? /联接/.test(name) : category === 'lof' ? /LOF/i.test(name) : category === 'qdii' ? /QDII/i.test(name) : instrument.kind === category;
  });
  return { category, sampled: rows.length, navAvailable: rows.filter(row => row.nav && row.nav.priceKind !== 'trade' && selected.get(row.code)?.kind !== 'etf').length, tradeAvailable: rows.filter(row => row.nav && (row.nav.priceKind === 'trade' || selected.get(row.code)?.kind === 'etf')).length, historyAvailable: rows.filter(row => row.history.count > 1).length, limitation: category === 'money' ? '只接受明确单位净值；万份收益、7日年化收益率不是单位净值。可能仅支持账本和产品资料。' : category === 'etf' ? '场内成交价与基金净值分开；免费行情延迟未核实，不用于自动告警。' : undefined };
});
if (full) {
  const results = report.officialCrosschecks.results ?? {};
  for (const result of Object.values(results)) {
    if (selected.get(result.code)?.kind === 'etf' || result.date.includes('T')) { result.status = 'not_applicable'; result.error = '场内成交价与单位净值不能互相交叉验证，保留此前不适用记录，不计入净值验收'; }
  }
  // Fixed public regulator endpoint only. No cookies, credentials, redirects or arbitrary HTTP URLs.
  // The independent comparison is useful evidence but HTTP transport is lower trust than HTTPS.
  let blocked = false;
  for (const check of checks.filter(value => value.nav && value.nav.quality !== 'conflict' && selected.get(value.code)?.kind !== 'etf' && /^\d{4}-\d{2}-\d{2}$/.test(value.nav.asOf)).slice(0, 30)) {
    if (results[check.code]?.status === 'matched' && results[check.code]?.date === check.nav!.asOf) continue;
    const parameters = [
      { name: 'sEcho', value: 1 }, { name: 'iDisplayStart', value: 0 }, { name: 'iDisplayLength', value: 20 },
      { name: 'fundType', value: 'all' }, { name: 'fundCompanyShortName', value: '' }, { name: 'fundCode', value: check.code },
      { name: 'fundName', value: '' }, { name: 'startDate', value: check.nav!.asOf }, { name: 'endDate', value: check.nav!.asOf },
    ];
    const sourceUrl = `http://eid.csrc.gov.cn/fund/disclose/getPublicFundJZInfoMore.do?${new URLSearchParams({ aoData: JSON.stringify(parameters) })}`;
    const result: NonNullable<VerificationReport['officialCrosschecks']['results']>[string] = { code: check.code, date: check.nav!.asOf, status: 'unavailable', suppliedNav: check.nav!.value, sourceUrl, checkedAt: new Date().toISOString() };
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await fetch(sourceUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { Accept: 'application/json', 'User-Agent': 'FinanceLocal/0.1 (personal public-data verifier)' } });
      if ([403, 429].includes(response.status)) blocked = true;
      if (!response.ok) { await response.body?.cancel(); throw new Error(`CSRC HTTP ${response.status}; no bypass or immediate retry`); }
      if (Number(response.headers.get('content-length') ?? 0) > 1_000_000) { await response.body?.cancel(); throw new Error('CSRC response exceeds 1 MB'); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('Empty CSRC response');
      const parts: Uint8Array[] = []; let bytes = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 1_000_000) { await reader.cancel(); throw new Error('CSRC response exceeds 1 MB'); } parts.push(part.value); }
      const buffer = new Uint8Array(bytes); let offset = 0; for (const part of parts) { buffer.set(part, offset); offset += part.length; }
      const official = parseCsrcNav(JSON.parse(new TextDecoder().decode(buffer)), check.code, check.nav!.asOf);
      result.officialNav = official.nav; result.status = new Decimal(official.nav).equals(check.nav!.value) ? 'matched' : 'conflict';
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
    results[check.code] = result;
    report.officialCrosschecks = { status: 'pending', required: 30, completed: Object.values(results).filter(value => value.status === 'matched').length, reason: '来源为证监会公开净值查询，同代码同估值日逐项比对。HTTP 传输信任低于 HTTPS；这些结果只用于独立验收，不提升行情质量、不触发投资告警。', results };
    await save();
    console.log(`Official crosscheck ${check.code} ${result.status}`);
    if (blocked) break;
  }
  report.officialCrosschecks.status = report.officialCrosschecks.completed >= 30 ? 'passed' : 'failed';
}
const observations = checks.filter(check => check.nav && check.nav.quality !== 'conflict').length;
const histories = checks.filter(check => check.history.count > 1 && check.history.ascending).length;
// The primary page may use a legal name while the fallback uses its disclosed brand.
// Do not count “招商基金” and “招商基金管理有限公司” as two managers.
const managers = new Set(checks.map(check => check.manager?.replace(/基金.*$/, '')).filter(Boolean)).size;
const failures: string[] = [];
if (report.catalog.count < 1000) failures.push('基金目录未验证达到 1,000 条');
if (observations < (full ? 120 : 6)) failures.push(`可读取价格/净值 ${observations}/${full ? 120 : 6}`);
if (histories < (full ? 30 : 6)) failures.push(`有效历史序列 ${histories}/${full ? 30 : 6}`);
if (full && managers < 12) failures.push(`已核实管理人 ${managers}/12`);
if (full && report.officialCrosschecks.completed < 30) failures.push(`独立官方交叉核验 ${report.officialCrosschecks.completed}/30（pending）`);
report.acceptance = { passed: failures.length === 0, observations, histories, managers, requiredProducts: full ? 120 : 6, failures };
report.completed = true; await save();
console.log(JSON.stringify({ report: filename, mode, ...report.acceptance }, null, 2));
if (failures.length) process.exitCode = 1;
