import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity } from "node:tls";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { AlertOutbox } from "../shared/types.js";

// Deliberately independent of Store and finance.sqlite. Only explicit alert summaries cross this boundary.
export const EVENT_NAME = "finance.alert.ready";
const AUDIENCE = "finance-notification-bridge";
const AUTH_BRAND: unique symbol = Symbol("verified-notification-principal");
const claimsSchema = z
  .object({
    version: z.literal(1),
    subject: z.string().min(1).max(200),
    issuer: z.literal("finance-auth-gateway"),
    audience: z.literal(AUDIENCE),
    verifiedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    callbackOrigins: z.array(z.string().url()).min(1).max(10),
    mode: z.enum(["synthetic", "live"]),
  })
  .strict();
export type PrincipalClaims = z.infer<typeof claimsSchema>;
export type VerifiedPrincipal = PrincipalClaims & {
  readonly [AUTH_BRAND]: true;
};
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ":" + canonicalJson(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function verifyPrincipalAttestation(
  envelope: unknown,
  trustedPublicKey: string,
  now = new Date(),
): VerifiedPrincipal {
  const input = z
    .object({ claims: claimsSchema, signature: z.string().min(1).max(2048) })
    .strict()
    .parse(envelope);
  const { claims } = input;
  const verified = Date.parse(claims.verifiedAt),
    expires = Date.parse(claims.expiresAt);
  if (
    verified > now.getTime() + 30_000 ||
    expires <= now.getTime() ||
    expires <= verified ||
    expires - verified > 86400_000
  )
    throw new NotificationError(-32001, "authentication_expired");
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(claims)),
      trustedPublicKey,
      Buffer.from(input.signature, "base64"),
    )
  )
    throw new NotificationError(-32001, "invalid_attestation");
  for (const origin of claims.callbackOrigins) {
    const url = callbackUrl(origin);
    if (url.origin !== origin || url.pathname !== "/" || url.search)
      throw new NotificationError(-32001, "invalid_callback_allowlist");
  }
  return Object.freeze({ ...claims, [AUTH_BRAND]: true as const });
}
export class NotificationError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(reason);
  }
}
function callbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotificationError(-32015, "invalid_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443") ||
    url.hostname.length > 253 ||
    url.href.length > 2048
  )
    throw new NotificationError(-32015, "invalid_url");
  return url;
}
function ipv4Public(address: string): boolean {
  const p = address.split(".").map(Number),
    [a, b, c] = p;
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 &&
      (b === 168 ||
        (b === 0 && (c === 0 || c === 2)) ||
        (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return ipv4Public(address);
  if (isIP(address) !== 6 || address.includes("%") || address.includes("."))
    return false;
  const halves = address.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [],
    right = halves[1] ? halves[1].split(":") : [];
  const parts =
    halves.length === 1
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (parts.length !== 8) return false;
  const [first, second] = parts.map((x) => parseInt(x, 16));
  // Restrict IPv6 to global unicast; exclude documentation, protocol assignments and tunneling ranges.
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) &&
    first !== 0x2002 &&
    !(first === 0x3fff && second <= 0xfff)
  );
}
export type Resolver = (
  host: string,
) => Promise<{ address: string; family: number }[]>;
const defaultResolver: Resolver = (host) =>
  dnsLookup(host, { all: true, verbatim: true });
export async function validatedDestination(
  value: string,
  resolver: Resolver = defaultResolver,
) {
  const url = callbackUrl(value),
    host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    (!host.includes(".") && !isIP(host))
  )
    throw new NotificationError(-32015, "non_public_destination");
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolver(host);
  } catch {
    throw new NotificationError(-32015, "dns_failed");
  }
  if (
    !addresses.length ||
    addresses.some(
      (a) => ![4, 6].includes(a.family) || !isPublicAddress(a.address),
    )
  )
    throw new NotificationError(-32015, "non_public_destination");
  return { url, address: addresses[0].address, family: addresses[0].family };
}
export interface WebhookReply {
  status: number;
  body: string;
}
export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<WebhookReply>;
export const publicHttpsPost: WebhookTransport = async (
  value,
  body,
  headers,
) => {
  const { url, address, family } = await validatedDestination(value);
  // Connect directly to the validated IP, preserving the original host for SNI/certificate validation.
  return new Promise<WebhookReply>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname: address,
        family,
        port: 443,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        path: url.pathname + url.search,
        method: "POST",
        agent: false,
        rejectUnauthorized: true,
        checkServerIdentity: (_host, cert) =>
          checkServerIdentity(url.hostname.replace(/^\[|\]$/g, ""), cert),
        headers: {
          ...headers,
          Host: url.host,
          "Content-Length": String(Buffer.byteLength(body)),
        },
        signal: AbortSignal.timeout(10_000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            request.destroy();
            reject(new NotificationError(-32015, "response_too_large"));
          } else chunks.push(chunk);
        });
        response.on("error", () =>
          reject(new NotificationError(-32015, "transport_failed")),
        );
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", () =>
      reject(new NotificationError(-32015, "transport_failed")),
    );
    request.end(body);
  });
};
function signingKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret))
    throw new NotificationError(-32602, "invalid_signing_secret");
  const key = Buffer.from(secret.slice(6), "base64");
  if (
    key.length < 24 ||
    key.length > 64 ||
    key.toString("base64").replace(/=+$/, "") !==
      secret.slice(6).replace(/=+$/, "")
  )
    throw new NotificationError(-32602, "invalid_signing_secret");
  return key;
}
export function webhookSignature(
  secret: string,
  eventId: string,
  timestamp: string,
  body: string,
): string {
  return (
    "v1," +
    createHmac("sha256", signingKey(secret))
      .update(`${eventId}.${timestamp}.${body}`)
      .digest("base64")
  );
}
export function equalChallenge(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length > 256) return false;
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(received).digest(),
  );
}
interface Subscription {
  id: string;
  owner: string;
  url: string;
  secret: string;
  oldSecret?: string;
  rotateUntil?: string;
  createdAt: string;
  expiresAt: string;
  verifiedAt: string;
  mode: "synthetic" | "live";
}
interface NotificationEvent {
  eventId: string;
  owner: string;
  timestamp: string;
  expiresAt: string;
  data: {
    alertId: string;
    code: string;
    direction: "Buy" | "Sell";
    snapshotId: string;
    probability: number;
    reviewConfidence: number;
    candidates: {
      amount: string;
      percentage?: string;
      score?: number;
      urgency?: number;
    }[];
    summary: string;
    expiresAt: string;
    synthetic: boolean;
  };
}
export interface DeliveryState {
  key: string;
  eventId: string;
  subscriptionId: string;
  attempts: number;
  nextAttemptAt: string;
  state: "pending" | "received" | "failed" | "expired";
  status?: number;
}

export class NotificationOutbox {
  private db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") {
      if (!file.endsWith("/notifications.sqlite"))
        throw new Error("通知数据库只能命名为 notifications.sqlite");
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const directory = lstatSync(dirname(file));
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.mode & 0o077
      )
        throw new Error("通知目录必须是权限为0700的独立本地目录");
      try {
        if (lstatSync(file).isSymbolicLink())
          throw new Error("不接受通知数据库符号链接");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS notification_records(namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key));",
    );
  }
  get<T>(ns: string, key: string): T | undefined {
    const row = this.db
      .prepare(
        "SELECT value FROM notification_records WHERE namespace=? AND key=?",
      )
      .get(ns, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(ns: string, key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO notification_records VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
      )
      .run(ns, key, JSON.stringify(value));
  }
  list<T>(ns: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT value FROM notification_records WHERE namespace=? ORDER BY key",
        )
        .all(ns) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as T);
  }
  remove(ns: string, key: string): void {
    this.db
      .prepare("DELETE FROM notification_records WHERE namespace=? AND key=?")
      .run(ns, key);
  }
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close(): void {
    this.db.close();
  }
  enqueue(alert: AlertOutbox, owner: string, synthetic = false): string {
    const candidate = z
      .object({
        amount: z.string().regex(/^\d+(\.\d+)?$/),
        percentage: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .optional(),
        score: z.number().finite().min(0).max(10).optional(),
        urgency: z.number().finite().min(0).max(10).optional(),
      })
      .strict();
    const data = z
      .object({
        alertId: z.string().min(1).max(200),
        code: z.string().min(1).max(40),
        direction: z.enum(["Buy", "Sell"]),
        snapshotId: z.string().min(1).max(200),
        probability: z.number().finite().gt(0.9).max(1),
        reviewConfidence: z.number().finite().gt(0.9).max(1),
        candidates: z.array(candidate).length(3),
        summary: z.string().max(8000),
        expiresAt: z.string().datetime(),
        synthetic: z.boolean(),
      })
      .strict()
      .parse({
        alertId: alert.id,
        code: alert.code,
        direction: alert.direction,
        snapshotId: alert.snapshotId,
        probability: alert.probability,
        reviewConfidence: alert.reviewConfidence,
        candidates: alert.candidates.map((c) => ({
          amount: c.amount,
          ...(c.percentage === undefined ? {} : { percentage: c.percentage }),
          ...(c.score === undefined ? {} : { score: c.score }),
          ...(c.urgency === undefined ? {} : { urgency: c.urgency }),
        })),
        summary: alert.summary,
        expiresAt: alert.expiresAt,
        synthetic,
      });
    if (
      !owner ||
      owner.length > 200 ||
      !Number.isFinite(Date.parse(alert.createdAt))
    )
      throw new Error("通知事件身份或日期无效");
    const eventId =
      "evt_" +
      createHash("sha256")
        .update(owner + "\0" + alert.id)
        .digest("hex");
    const event: NotificationEvent = {
      eventId,
      owner,
      timestamp: alert.createdAt,
      expiresAt: alert.expiresAt,
      data,
    };
    if (Buffer.byteLength(JSON.stringify(event)) > 262_144)
      throw new Error("通知摘要过大");
    this.atomic(() => {
      const old = this.get<NotificationEvent>("events", eventId);
      if (old && canonicalJson(old) !== canonicalJson(event))
        throw new Error("相同事件 ID 的内容不允许改变");
      if (!old) this.put("events", eventId, event);
    });
    return eventId;
  }
}
const subscribeSchema = z
  .object({
    name: z.literal(EVENT_NAME),
    arguments: z.object({}).strict(),
    delivery: z
      .object({
        mode: z.literal("webhook"),
        url: z.string().url(),
        secret: z.string(),
      })
      .strict(),
    cursor: z.null().optional(),
    ttlMs: z.number().int().positive().nullable().optional(),
  })
  .strict();
const unsubscribeSchema = z
  .object({
    name: z.literal(EVENT_NAME),
    arguments: z.object({}).strict(),
    delivery: z
      .object({ mode: z.literal("webhook"), url: z.string().url() })
      .strict(),
  })
  .strict();
const EVENT_DEFINITION = {
  name: EVENT_NAME,
  description:
    "A locally verified finance alert is ready for human review. Delivery acknowledgement does not prove mobile push.",
  delivery: ["webhook"],
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  payloadSchema: {
    type: "object",
    properties: {
      alertId: { type: "string" },
      code: { type: "string" },
      direction: { type: "string", enum: ["Buy", "Sell"] },
      snapshotId: { type: "string" },
      probability: { type: "number" },
      reviewConfidence: { type: "number" },
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            amount: { type: "string" },
            percentage: { type: "string" },
            score: { type: "number" },
            urgency: { type: "number" },
          },
          required: ["amount"],
          additionalProperties: false,
        },
      },
      summary: { type: "string" },
      expiresAt: { type: "string" },
      synthetic: { type: "boolean" },
    },
    required: [
      "alertId",
      "code",
      "direction",
      "snapshotId",
      "probability",
      "reviewConfidence",
      "candidates",
      "summary",
      "expiresAt",
      "synthetic",
    ],
    additionalProperties: false,
  },
};

export class NotificationBridge {
  private transport: WebhookTransport;
  private now: () => Date;
  private busy = false;
  constructor(
    private outbox: NotificationOutbox,
    private options: {
      principal?: () => VerifiedPrincipal | undefined;
      transport?: WebhookTransport;
      resolver?: Resolver;
      now?: () => Date;
      allowLive?: boolean;
    } = {},
  ) {
    this.transport = options.transport ?? publicHttpsPost;
    this.now = options.now ?? (() => new Date());
  }
  private principal(): VerifiedPrincipal {
    const p = this.options.principal?.();
    if (
      !p?.[AUTH_BRAND] ||
      Date.parse(p.expiresAt) <= this.now().getTime() ||
      (p.mode === "live" && !this.options.allowLive)
    )
      throw new NotificationError(-32001, "verified_identity_required");
    return p;
  }
  private authorizeUrl(url: string, principal: VerifiedPrincipal) {
    const parsed = callbackUrl(url);
    if (!principal.callbackOrigins.includes(parsed.origin))
      throw new NotificationError(-32001, "callback_not_authorized");
    return parsed.href;
  }
  private identity(owner: string, url: string): string {
    return (
      "sub_" +
      createHash("sha256")
        .update(canonicalJson({ owner, url, name: EVENT_NAME, arguments: {} }))
        .digest("hex")
    );
  }
  private async send(
    subscription: Subscription,
    eventId: string,
    payload: unknown,
  ): Promise<WebhookReply> {
    const p = this.principal();
    if (subscription.owner !== p.subject || subscription.mode !== p.mode)
      throw new NotificationError(-32001, "subscription_owner_mismatch");
    this.authorizeUrl(subscription.url, p);
    await validatedDestination(subscription.url, this.options.resolver);
    const currentPrincipal = this.principal();
    if (
      currentPrincipal.subject !== subscription.owner ||
      currentPrincipal.mode !== subscription.mode ||
      Date.parse(subscription.expiresAt) <= this.now().getTime()
    )
      throw new NotificationError(-32001, "subscription_expired");
    this.authorizeUrl(subscription.url, currentPrincipal);
    const event = payload as {
      eventId?: string;
      data?: { expiresAt?: string };
    };
    if (event.eventId) {
      const active = this.outbox.get<Subscription>(
        "subscriptions",
        subscription.id,
      );
      if (
        !active ||
        Date.parse(active.expiresAt) <= this.now().getTime() ||
        !event.data?.expiresAt ||
        Date.parse(event.data.expiresAt) <= this.now().getTime()
      )
        throw new NotificationError(-32001, "delivery_expired_or_revoked");
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 262_144)
      throw new NotificationError(-32602, "payload_too_large");
    const time = String(Math.floor(this.now().getTime() / 1000));
    let signature = webhookSignature(subscription.secret, eventId, time, body);
    if (
      subscription.oldSecret &&
      subscription.rotateUntil &&
      Date.parse(subscription.rotateUntil) > this.now().getTime()
    )
      signature +=
        " " + webhookSignature(subscription.oldSecret, eventId, time, body);
    return this.transport(subscription.url, body, {
      "Content-Type": "application/json",
      "webhook-id": eventId,
      "webhook-timestamp": time,
      "webhook-signature": signature,
      "X-MCP-Subscription-Id": subscription.id,
    });
  }
  async handle(method: string, params: unknown = {}): Promise<unknown> {
    if (method === "initialize")
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {}, events: {} },
        serverInfo: { name: "finance-notification-bridge", version: "0.1.0" },
      };
    if (method === "server/discover")
      return {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {}, events: {} },
      };
    if (method === "ping" || method === "notifications/initialized") return {};
    const principal = this.principal();
    if (method === "tools/list") return { tools: [] };
    if (method === "events/list") return { events: [EVENT_DEFINITION] };
    if (method === "events/unsubscribe") {
      const input = unsubscribeSchema.parse(params),
        url = this.authorizeUrl(input.delivery.url, principal);
      this.outbox.remove(
        "subscriptions",
        this.identity(principal.subject, url),
      );
      return {};
    }
    if (method !== "events/subscribe")
      throw new NotificationError(-32601, "method_not_found");
    const input = subscribeSchema.parse(params),
      url = this.authorizeUrl(input.delivery.url, principal);
    signingKey(input.delivery.secret);
    const id = this.identity(principal.subject, url),
      old = this.outbox.get<Subscription>("subscriptions", id);
    const now = this.now(),
      ttl = Math.min(
        input.ttlMs ?? 3600_000,
        86400_000,
        Date.parse(principal.expiresAt) - now.getTime(),
      );
    const subscription: Subscription = {
      id,
      owner: principal.subject,
      url,
      secret: input.delivery.secret,
      createdAt: old?.createdAt ?? now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      verifiedAt: now.toISOString(),
      mode: principal.mode,
    };
    if (old && old.secret !== subscription.secret) {
      subscription.oldSecret = old.secret;
      subscription.rotateUntil = new Date(
        now.getTime() + 300_000,
      ).toISOString();
    }
    // Cache only same owner, callback and signing key, for at most five minutes.
    if (
      !old ||
      old.secret !== subscription.secret ||
      now.getTime() - Date.parse(old.verifiedAt) > 300_000 ||
      Date.parse(old.expiresAt) <= now.getTime()
    ) {
      const challenge = randomBytes(32).toString("hex"),
        verificationId = "msg_verification_" + randomUUID();
      const started = now.getTime();
      let reply: WebhookReply;
      try {
        reply = await this.send(subscription, verificationId, {
          type: "verification",
          challenge,
        });
      } catch (e) {
        if (e instanceof NotificationError) throw e;
        throw new NotificationError(-32015, "transport_failed");
      }
      let echoed: unknown;
      try {
        echoed = JSON.parse(reply.body).challenge;
      } catch {
        /* invalid response */
      }
      if (
        reply.status < 200 ||
        reply.status >= 300 ||
        this.now().getTime() - started > 15_000 ||
        !equalChallenge(challenge, echoed)
      )
        throw new NotificationError(-32015, "challenge_failed");
    } else subscription.verifiedAt = old.verifiedAt;
    // Check revocation/expiry again after callback IO before committing activation.
    if (
      this.principal().subject !== principal.subject ||
      Date.parse(subscription.expiresAt) <= this.now().getTime()
    )
      throw new NotificationError(-32001, "authentication_expired");
    this.outbox.put("subscriptions", id, subscription);
    return {
      id,
      refreshBefore: subscription.expiresAt,
      cursor: null,
      truncated: false,
    };
  }
  async drain(): Promise<DeliveryState[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const principal = this.principal(),
        now = this.now().getTime();
      const updates: DeliveryState[] = [];
      for (const sub of this.outbox.list<Subscription>("subscriptions")) {
        if (
          sub.owner !== principal.subject ||
          sub.mode !== principal.mode ||
          Date.parse(sub.expiresAt) <= now
        )
          continue;
        for (const event of this.outbox.list<NotificationEvent>("events")) {
          if (
            event.owner !== principal.subject ||
            event.data.synthetic !== (principal.mode === "synthetic") ||
            Date.parse(event.timestamp) < Date.parse(sub.createdAt)
          )
            continue;
          const key = sub.id + ":" + event.eventId;
          let delivery = this.outbox.get<DeliveryState>("deliveries", key);
          if (
            (delivery && delivery.state !== "pending") ||
            (delivery && Date.parse(delivery.nextAttemptAt) > now)
          )
            continue;
          if (Date.parse(event.expiresAt) <= now) {
            delivery = {
              key,
              eventId: event.eventId,
              subscriptionId: sub.id,
              attempts: delivery?.attempts ?? 0,
              nextAttemptAt: this.now().toISOString(),
              state: "expired",
            };
            this.outbox.put("deliveries", key, delivery);
            updates.push(delivery);
            continue;
          }
          // Durable retry lease before IO; a restart preserves IDs and backs off rather than hot-looping.
          const claimed = this.outbox.atomic(() => {
            const current = this.outbox.get<DeliveryState>("deliveries", key);
            if (
              current &&
              (current.state !== "pending" ||
                Date.parse(current.nextAttemptAt) > this.now().getTime())
            )
              return undefined;
            if (current && current.attempts >= 5) {
              this.outbox.put("deliveries", key, {
                ...current,
                state: "failed",
              });
              return undefined;
            }
            const attempts = (current?.attempts ?? 0) + 1;
            const next: DeliveryState = {
              key,
              eventId: event.eventId,
              subscriptionId: sub.id,
              attempts,
              nextAttemptAt: new Date(
                this.now().getTime() +
                  Math.min(30_000 * 2 ** (attempts - 1), 600_000),
              ).toISOString(),
              state: "pending",
            };
            this.outbox.put("deliveries", key, next);
            return next;
          });
          if (!claimed) continue;
          delivery = claimed;
          let status = 0;
          try {
            status = (
              await this.send(sub, event.eventId, {
                eventId: event.eventId,
                name: EVENT_NAME,
                timestamp: event.timestamp,
                data: event.data,
                cursor: null,
              })
            ).status;
          } catch {
            /* Keep only categorized delivery state, never callback credentials or response bodies. */
          }
          const transient =
            status === 0 || status === 408 || status === 429 || status >= 500;
          delivery.status = status;
          delivery.state =
            status >= 200 && status < 300
              ? "received"
              : !transient || delivery.attempts >= 5
                ? "failed"
                : "pending";
          this.outbox.put("deliveries", key, delivery);
          updates.push(delivery);
        }
      }
      return updates;
    } finally {
      this.busy = false;
    }
  }
}
