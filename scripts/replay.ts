import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayDecisions } from '../src/server/backtest.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: npm run replay -- /absolute/path/recorded-decisions.json\nNo input: reports unavailable without creating data. Reports are written outside the source repository.');
} else if (!args.length) {
  console.log(JSON.stringify(replayDecisions(), null, 2));
} else {
  if (args.length !== 1 || args[0].startsWith('--')) throw new Error('Expected one local JSON file; use --help');
  const inputPath = path.resolve(args[0]), inputInfo = await stat(inputPath);
  if (!inputInfo.isFile() || inputInfo.size > 20_000_000) throw new Error('Replay input must be a regular JSON file no larger than 20 MB');
  const report = replayDecisions(JSON.parse(await readFile(inputPath, 'utf8')));
  const repository = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const requested = path.resolve(process.env.FINANCE_DATA_DIR ?? path.join(homedir(), 'Library', 'Application Support', 'Finance'));
  if (requested === repository || requested.startsWith(`${repository}${path.sep}`)) throw new Error('Replay reports must be outside the source repository');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const directory = await realpath(requested);
  if (directory === repository || directory.startsWith(`${repository}${path.sep}`)) throw new Error('Replay directory resolves into the source repository');
  const reportPath = path.join(directory, `replay-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, reason: report.reason, inputSamples: report.inputSamples, eligibleSamples: report.eligibleSamples, rejectedSamples: report.rejected.length, report: reportPath }, null, 2));
  if (report.status === 'unavailable' || report.status === 'insufficient') process.exitCode = 2;
}
