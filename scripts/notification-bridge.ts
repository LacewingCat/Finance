import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NotificationBridge, NotificationError, NotificationOutbox, verifyPrincipalAttestation } from '../src/server/notifications.js';

// Stdio is attached only through an authenticated external adapter. It cannot supply its own principal.
// The identity attestation and pinned public key must be provisioned by that adapter, never by MCP params.
function readPrivate(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error('notification_config_permissions');
  return readFileSync(path, 'utf8');
}
const directory = process.env.FINANCE_NOTIFICATION_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Finance', 'notifications');
const outbox = new NotificationOutbox(join(directory, 'notifications.sqlite'));
const principal = () => {
  const attestation = process.env.FINANCE_NOTIFICATION_ATTESTATION_FILE, publicKey = process.env.FINANCE_NOTIFICATION_AUTH_PUBLIC_KEY_FILE;
  if (!attestation || !publicKey) return undefined;
  try { return verifyPrincipalAttestation(JSON.parse(readPrivate(attestation)), readPrivate(publicKey)); } catch { return undefined; }
};
const bridge = new NotificationBridge(outbox, { principal, allowLive: process.env.FINANCE_NOTIFICATION_DELIVERY_ENABLED === 'true' });
let buffer = '', chain = Promise.resolve();
function emit(value: unknown) { process.stdout.write(JSON.stringify(value) + '\n'); }
async function accept(line: string) {
  let message: { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  try { message = JSON.parse(line); } catch { emit({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number' && message.id !== null) { emit({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }); return; }
  try {
    const result = await bridge.handle(message.method, message.params);
    if (message.id !== undefined) emit({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    if (message.id === undefined) return;
    const known = error instanceof NotificationError;
    emit({ jsonrpc: '2.0', id: message.id, error: { code: known ? error.code : -32602, message: known && error.code === -32015 ? 'CallbackEndpointError' : 'Request rejected', data: { reason: known ? error.reason : 'invalid_params' } } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 262_144) { buffer = ''; emit({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } }); return; }
  let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (line) chain = chain.then(() => accept(line)); }
});
const timer = setInterval(() => { void bridge.drain().catch(() => { /* No verified identity means no delivery. */ }); }, 15_000);
timer.unref();
process.stdin.on('end', () => { clearInterval(timer); void chain.finally(() => outbox.close()); });
process.on('SIGTERM', () => { clearInterval(timer); outbox.close(); process.exit(0); });
