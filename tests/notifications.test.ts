import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  NotificationBridge,
  NotificationOutbox,
  EVENT_NAME,
  canonicalJson,
  equalChallenge,
  isPublicAddress,
  validatedDestination,
  verifyPrincipalAttestation,
  webhookSignature,
  type PrincipalClaims,
  type VerifiedPrincipal,
  type WebhookTransport,
  type DeliveryState,
} from "../src/server/notifications.js";
import type { AlertOutbox } from "../src/shared/types.js";

// All credentials, subjects, webhooks and alerts in these tests are synthetic and never leave this process.
const keypair = generateKeyPairSync("ed25519");
const publicKey = keypair.publicKey
  .export({ format: "pem", type: "spki" })
  .toString();
const initialTime = Date.parse("2026-11-01T02:00:00Z");
const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const url = "https://receiver.example.com/callback";
function identity(
  patch: Partial<PrincipalClaims> = {},
  now = new Date(initialTime),
) {
  const claims: PrincipalClaims = {
    version: 1,
    subject: "synthetic-owner",
    issuer: "finance-auth-gateway",
    audience: "finance-notification-bridge",
    verifiedAt: new Date(initialTime).toISOString(),
    expiresAt: new Date(initialTime + 86400_000).toISOString(),
    callbackOrigins: ["https://receiver.example.com"],
    mode: "synthetic",
    ...patch,
  };
  const envelope = {
    claims,
    signature: sign(
      null,
      Buffer.from(canonicalJson(claims)),
      keypair.privateKey,
    ).toString("base64"),
  };
  return {
    envelope,
    principal: verifyPrincipalAttestation(envelope, publicKey, now),
  };
}
const subscribe = {
  name: EVENT_NAME,
  arguments: {},
  delivery: { mode: "webhook", url, secret },
  cursor: null,
};
const alert = (
  at = initialTime,
  patch: Partial<AlertOutbox> = {},
): AlertOutbox => ({
  id: "synthetic-alert",
  code: "TEST",
  direction: "Buy",
  snapshotId: "synthetic-snapshot",
  createdAt: new Date(at).toISOString(),
  expiresAt: new Date(at + 600_000).toISOString(),
  probability: 0.95,
  reviewConfidence: 0.95,
  candidates: [
    { amount: "10", score: 5, urgency: 1 },
    { amount: "20", score: 6, urgency: 1 },
    { amount: "30", score: 4, urgency: 1 },
  ],
  summary: "Synthetic test only",
  status: "local",
  ...patch,
});
const databases: NotificationOutbox[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  let timestamp = initialTime;
  let principal: VerifiedPrincipal | undefined = identity().principal;
  const outbox = new NotificationOutbox(":memory:");
  databases.push(outbox);
  const resolver = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
  const transport = vi.fn(async (_url: string, body: string) => {
    const parsed = JSON.parse(body);
    return {
      status: 200,
      body: JSON.stringify(
        parsed.type === "verification" ? { challenge: parsed.challenge } : {},
      ),
    };
  });
  const options = {
    principal: () => principal,
    resolver,
    transport: transport as WebhookTransport,
    now: () => new Date(timestamp),
  };
  const bridge = new NotificationBridge(outbox, options);
  return {
    outbox,
    bridge,
    options,
    resolver,
    transport,
    setTime: (t: number) => {
      timestamp = t;
    },
    revoke: () => {
      principal = undefined;
    },
  };
}

describe("notification identity and callback security", () => {
  it("fails closed without cryptographically verified identity and cannot authenticate through MCP params", async () => {
    const db = new NotificationOutbox(":memory:");
    databases.push(db);
    const transport = vi.fn();
    const bridge = new NotificationBridge(db, { transport });
    expect(await bridge.handle("initialize")).toMatchObject({
      capabilities: { events: {} },
    });
    await expect(bridge.handle("events/list")).rejects.toMatchObject({
      code: -32001,
    });
    await expect(
      bridge.handle("events/subscribe", {
        ...subscribe,
        principal: { subject: "fake", verified: true },
      }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects tampered, expired and overlong identity attestations", () => {
    const { envelope } = identity();
    expect(() =>
      verifyPrincipalAttestation(
        { ...envelope, claims: { ...envelope.claims, subject: "attacker" } },
        publicKey,
        new Date(initialTime),
      ),
    ).toThrow();
    expect(() =>
      verifyPrincipalAttestation(
        envelope,
        publicKey,
        new Date(initialTime + 86400_000),
      ),
    ).toThrow();
    expect(() =>
      identity({
        expiresAt: new Date(initialTime + 2 * 86400_000).toISOString(),
      }),
    ).toThrow();
  });
  it("keeps live identity disabled until separately enabled", async () => {
    const db = new NotificationOutbox(":memory:");
    databases.push(db);
    const principal = identity({ mode: "live" }).principal;
    const bridge = new NotificationBridge(db, {
      principal: () => principal,
      now: () => new Date(initialTime),
    });
    await expect(bridge.handle("events/list")).rejects.toThrow();
  });
  it("blocks local, private, metadata, multicast, mapped and documentation destinations", async () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.169.254",
      "172.31.1.1",
      "192.168.1.1",
      "198.18.0.1",
      "192.0.2.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "2001:db8::1",
      "2002:0808:0808::1",
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2001:4860:4860::8888")).toBe(true);
    for (const value of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com:9443",
      "https://localhost/",
      "https://2130706433/",
      "https://example.local/",
    ])
      await expect(validatedDestination(value)).rejects.toThrow();
    await expect(
      validatedDestination(url, async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    ).rejects.toThrow();
  });
  it("requires an allowed HTTPS origin, a valid signing key and successful exact challenge", async () => {
    const { bridge, transport } = fixture();
    await expect(
      bridge.handle("events/subscribe", {
        ...subscribe,
        delivery: { ...subscribe.delivery, url: "https://evil.example.com" },
      }),
    ).rejects.toThrow();
    await expect(
      bridge.handle("events/subscribe", {
        ...subscribe,
        delivery: { ...subscribe.delivery, secret: "whsec_bad" },
      }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValue({
      status: 200,
      body: '{"challenge":"incorrect"}',
    });
    await expect(
      bridge.handle("events/subscribe", subscribe),
    ).rejects.toMatchObject({ code: -32015, reason: "challenge_failed" });
    expect(equalChallenge("expected", "expected")).toBe(true);
    expect(equalChallenge("expected", "different")).toBe(false);
  });
  it("does not accept a redirect as verification", async () => {
    const { bridge, transport, outbox } = fixture();
    transport.mockResolvedValue({ status: 302, body: "{}" });
    await expect(
      bridge.handle("events/subscribe", subscribe),
    ).rejects.toMatchObject({ reason: "challenge_failed" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(outbox.list("subscriptions")).toHaveLength(0);
  });
});

describe("MCP event lifecycle and durable delivery", () => {
  it("advertises the official event methods and creates an idempotent expiring subscription", async () => {
    const { bridge, transport, outbox } = fixture();
    expect(await bridge.handle("events/list")).toMatchObject({
      events: [{ name: EVENT_NAME, delivery: ["webhook"] }],
    });
    const first = await bridge.handle("events/subscribe", subscribe);
    const again = await bridge.handle("events/subscribe", subscribe);
    expect(again).toEqual(first);
    expect(first).toMatchObject({
      refreshBefore: new Date(initialTime + 3600_000).toISOString(),
      cursor: null,
      truncated: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(outbox.list("subscriptions")).toHaveLength(1);
  });
  it("signs exact bytes and only reports received, deduplicating across bridge restarts", async () => {
    const { bridge, transport, outbox, options } = fixture();
    await bridge.handle("events/subscribe", subscribe);
    const eventId = outbox.enqueue(alert(), "synthetic-owner", true);
    expect(outbox.enqueue(alert(), "synthetic-owner", true)).toBe(eventId);
    expect((await bridge.drain())[0].state).toBe("received");
    const [, body, headers] = transport.mock.calls[1] as unknown as [
      string,
      string,
      Record<string, string>,
    ];
    const expected =
      "v1," +
      createHmac("sha256", Buffer.alloc(32, 7))
        .update(`${eventId}.${headers["webhook-timestamp"]}.${body}`)
        .digest("base64");
    expect(headers["webhook-signature"]).toBe(expected);
    expect(
      webhookSignature(secret, eventId, headers["webhook-timestamp"], body),
    ).toBe(expected);
    expect(headers["webhook-id"]).toBe(eventId);
    expect(JSON.parse(body)).toMatchObject({
      eventId,
      name: EVENT_NAME,
      data: { synthetic: true },
      cursor: null,
    });
    await new NotificationBridge(outbox, options).drain();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(() =>
      outbox.enqueue(
        alert(initialTime, { summary: "changed" }),
        "synthetic-owner",
        true,
      ),
    ).toThrow();
  });
  it("uses stable event IDs, new signing timestamps and bounded exponential retry", async () => {
    const { bridge, transport, outbox, setTime } = fixture();
    await bridge.handle("events/subscribe", subscribe);
    outbox.enqueue(alert(), "synthetic-owner", true);
    transport
      .mockResolvedValueOnce({ status: 503, body: "{}" })
      .mockResolvedValueOnce({ status: 200, body: "{}" });
    expect((await bridge.drain())[0].state).toBe("pending");
    expect(await bridge.drain()).toEqual([]);
    setTime(initialTime + 30_000);
    expect((await bridge.drain())[0].state).toBe("received");
    const first = transport.mock.calls[1] as unknown as [
        string,
        string,
        Record<string, string>,
      ],
      second = transport.mock.calls[2] as unknown as [
        string,
        string,
        Record<string, string>,
      ];
    expect(second[1]).toBe(first[1]);
    expect(second[2]["webhook-id"]).toBe(first[2]["webhook-id"]);
    expect(second[2]["webhook-timestamp"]).not.toBe(
      first[2]["webhook-timestamp"],
    );
  });
  it("never retries 410/413 and stops on event expiry, subscription expiry or revoked access", async () => {
    for (const status of [410, 413]) {
      const { bridge, transport, outbox, setTime } = fixture();
      await bridge.handle("events/subscribe", subscribe);
      outbox.enqueue(alert(), "synthetic-owner", true);
      transport.mockResolvedValue({ status, body: "{}" });
      expect((await bridge.drain())[0].state).toBe("failed");
      setTime(initialTime + 30_000);
      expect(await bridge.drain()).toEqual([]);
    }
    const f = fixture();
    await f.bridge.handle("events/subscribe", { ...subscribe, ttlMs: 60_000 });
    f.outbox.enqueue(alert(), "synthetic-owner", true);
    f.setTime(initialTime + 60_000);
    expect(await f.bridge.drain()).toEqual([]);
    expect(f.transport).toHaveBeenCalledTimes(1);
    const g = fixture();
    await g.bridge.handle("events/subscribe", subscribe);
    g.outbox.enqueue(alert(), "synthetic-owner", true);
    g.setTime(initialTime + 600_000);
    expect((await g.bridge.drain())[0].state).toBe("expired");
    expect(g.transport).toHaveBeenCalledTimes(1);
    g.revoke();
    await expect(g.bridge.drain()).rejects.toThrow();
  });
  it("filters owners and synthetic/live data and makes unsubscribe idempotent", async () => {
    const { bridge, transport, outbox } = fixture();
    await bridge.handle("events/subscribe", subscribe);
    outbox.enqueue(alert(), "different-owner", true);
    outbox.enqueue(alert(), "synthetic-owner", false);
    expect(await bridge.drain()).toEqual([]);
    const params = {
      name: EVENT_NAME,
      arguments: {},
      delivery: { mode: "webhook", url },
    };
    expect(await bridge.handle("events/unsubscribe", params)).toEqual({});
    expect(await bridge.handle("events/unsubscribe", params)).toEqual({});
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rotates secrets with a short dual-signature window and re-verifies the endpoint", async () => {
    const { bridge, transport, outbox } = fixture();
    await bridge.handle("events/subscribe", subscribe);
    await bridge.handle("events/subscribe", {
      ...subscribe,
      delivery: {
        ...subscribe.delivery,
        secret: "whsec_" + Buffer.alloc(32, 8).toString("base64"),
      },
    });
    outbox.enqueue(alert(), "synthetic-owner", true);
    await bridge.drain();
    expect(transport).toHaveBeenCalledTimes(3);
    const headers = (
      transport.mock.calls[2] as unknown as [
        string,
        string,
        Record<string, string>,
      ]
    )[2];
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
  });
  it("rechecks DNS on each attempt and keeps the notification database free of portfolio data", async () => {
    const { bridge, resolver, outbox, transport } = fixture();
    await bridge.handle("events/subscribe", subscribe);
    outbox.enqueue(alert(), "synthetic-owner", true);
    resolver.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await bridge.drain();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(outbox.list<DeliveryState>("deliveries")[0].state).toBe("pending");
    expect(JSON.stringify(outbox.list("events"))).not.toMatch(
      /OPENAI_API_KEY|cash|positions|account/,
    );
    expect(() => new NotificationOutbox("/tmp/finance.sqlite")).toThrow();
  });
});
