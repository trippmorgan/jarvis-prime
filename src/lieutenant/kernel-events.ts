/**
 * Kernel events emitter — pushes Telegram/GroupMe/etc message turns into the
 * jarvis-os kernel `events` table so the shell Discussion tab can render the
 * live conversation (W11).
 *
 * Fail-soft: kernel down → log + swallow. Never throws at callers.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

interface KernelConfig {
  url: string;
  token: string;
}

function loadKernelConfig(): KernelConfig | null {
  const url = process.env.KERNEL_URL;
  const token = process.env.KERNEL_TOKEN;
  if (url && token) return { url, token };
  try {
    const raw = readFileSync(`${homedir()}/.openclaw/openclaw.json`, "utf-8");
    const d = JSON.parse(raw);
    if (d?.kernel?.url && d?.kernel?.token) return { url: d.kernel.url, token: d.kernel.token };
  } catch { /* ignore */ }
  try {
    const env = readFileSync("/home/tripp/.openclaw/workspace/jarvis-os/.env", "utf-8");
    const m = env.match(/^API_TOKEN=(.+)$/m);
    if (m) return { url: "http://100.80.111.84:3000", token: m[1].trim() };
  } catch { /* ignore */ }
  return null;
}

export interface EmitInput {
  body: string;
  severity?: "info" | "success" | "warning" | "error";
  agent_id?: string | null;
  node?: string;
  metadata?: Record<string, unknown>;
}

let cfg: KernelConfig | null = null;
let agentIdProvider: () => string | null = () => null;
let warnedOnce = false;

export function setAgentIdProvider(fn: () => string | null): void {
  agentIdProvider = fn;
}

/** Returns the kernel-registered agent id for jarvis-prime, or null if not yet registered. */
export function getAgentId(): string | null {
  return agentIdProvider();
}

/**
 * Fire-and-forget POST to /api/v1/registry/events. The agent_id is pulled
 * from the provider set in index.ts after kernel-register completes.
 */
export function emitKernelEvent(input: EmitInput): void {
  if (!cfg) cfg = loadKernelConfig();
  if (!cfg) {
    if (!warnedOnce) {
      console.warn("[kernel-events] no kernel config; events will not emit");
      warnedOnce = true;
    }
    return;
  }
  const payload = {
    agent_id: input.agent_id ?? agentIdProvider(),
    node: input.node ?? "prime",
    severity: input.severity ?? "info",
    body: input.body,
    metadata: input.metadata ?? {},
  };
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      await fetch(`${cfg!.url}/api/v1/registry/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg!.token}`,
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      // Don't spam logs — first failure already warned (or daemon down).
      void err;
    }
  })();
}

/** Helper for the common Telegram inbound case. */
export function emitTelegramInbound(opts: {
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  hasMedia?: boolean;
  sessionId?: string | null;
}): void {
  const metadata: Record<string, unknown> = {
    channel: "telegram",
    direction: "inbound",
    chat_id: opts.chatId,
    user_id: opts.userId,
    message_id: opts.messageId,
    has_media: opts.hasMedia ?? false,
  };
  if (opts.sessionId) metadata.session_id = opts.sessionId;
  emitKernelEvent({
    body: opts.text,
    severity: "info",
    metadata,
  });
}

/** Helper for the common Telegram outbound case. */
export function emitTelegramOutbound(opts: {
  chatId: string;
  messageId: string;
  text: string;
  deliveryMs: number;
  outcome: "success" | "error";
  sessionId?: string | null;
}): void {
  const metadata: Record<string, unknown> = {
    channel: "telegram",
    direction: "outbound",
    chat_id: opts.chatId,
    message_id: opts.messageId,
    delivery_ms: opts.deliveryMs,
    outcome: opts.outcome,
  };
  if (opts.sessionId) metadata.session_id = opts.sessionId;
  emitKernelEvent({
    body: opts.text,
    severity: opts.outcome === "success" ? "success" : "warning",
    metadata,
  });
}

// ---------------------------------------------------------------------------
// W13 — Session cluster helpers
// ---------------------------------------------------------------------------
//
// Sessions are the "what's happening now" unit in the kernel. We cluster
// inbound Telegram messages into the same session if the gap between turns
// is less than `idle_cluster_min` (default 45). The kernel handles cluster
// reuse server-side via `POST /sessions/start` with `idle_cluster_min`;
// we just need to call it and cache the returned id locally so we don't
// hammer the kernel on every single inbound turn.
//
// Cache key shape: `${channel}:${chat_id}:${owner}` — independent of agent_id
// (we have one Prime agent_id at a time). TTL is 50min so a stale id can't
// outlive the kernel's 45min idle window by more than 5min before we re-ask.

interface CachedSession {
  id: string;
  expiresAt: number;
}

const SESSION_CACHE_TTL_MS = 50 * 60 * 1000;
const sessionCache: Map<string, CachedSession> = new Map();

export interface StartOrReuseInput {
  agent_id: string;
  intent: string;
  channel: string;
  chat_id: string;
  owner?: string;
  idle_cluster_min?: number;
}

/**
 * Look up (cached) or POST /sessions/start to get a session id for this
 * (channel, chat_id, owner) cluster. Returns null on kernel-down.
 *
 * The kernel decides reuse vs. create based on `idle_cluster_min` against
 * `last_activity_at` of the most-recent session for the same agent/channel/owner.
 * Our local cache just avoids round-trips when we're chatting actively.
 */
export async function startOrReuseSession(input: StartOrReuseInput): Promise<string | null> {
  if (!cfg) cfg = loadKernelConfig();
  if (!cfg) return null;

  const owner = input.owner ?? "tripp";
  const idleMin = input.idle_cluster_min ?? 45;
  const cacheKey = `${input.channel}:${input.chat_id}:${owner}`;
  const now = Date.now();

  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    // Best-effort heartbeat so the kernel doesn't expire it under us.
    void heartbeatSession(cached.id);
    return cached.id;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${cfg.url}/api/v1/registry/sessions/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        agent_id: input.agent_id,
        intent: input.intent.slice(0, 80),
        channel: input.channel,
        owner,
        idle_cluster_min: idleMin,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as
      | { session?: { id?: string }; reused?: boolean }
      | null;
    const id = data?.session?.id ?? null;
    if (id) {
      sessionCache.set(cacheKey, { id, expiresAt: now + SESSION_CACHE_TTL_MS });
    }
    return id;
  } catch {
    return null;
  }
}

/** Fire-and-forget heartbeat on a session id. */
export function heartbeatSession(id: string): void {
  if (!cfg) cfg = loadKernelConfig();
  if (!cfg || !id) return;
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      await fetch(`${cfg!.url}/api/v1/registry/sessions/${id}/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg!.token}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch {
      /* fail-soft */
    }
  })();
}

/** Fire-and-forget end-of-session. Drops from local cache too. */
export function endSession(id: string): void {
  if (!cfg) cfg = loadKernelConfig();
  // Purge cache entries pointing at this id.
  for (const [k, v] of sessionCache) {
    if (v.id === id) sessionCache.delete(k);
  }
  if (!cfg || !id) return;
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      await fetch(`${cfg!.url}/api/v1/registry/sessions/${id}/end`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg!.token}`,
        },
        body: JSON.stringify({}),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch {
      /* fail-soft */
    }
  })();
}

// ---------------------------------------------------------------------------
// W13 — @mention bridge: parse Telegram text for `@<node>` aliases
// ---------------------------------------------------------------------------

const KNOWN_MENTION_NODES = new Set(["dj-jarvis", "frank", "scalpel", "openclaw", "prime"]);
// Captures @<token> where token may include letters/digits/hyphen. Strict
// boundary: must be start-of-string or preceded by whitespace/punctuation.
const MENTION_REGEX = /(?:^|[\s,.;:!?(])@([a-z][a-z0-9-]*)/gi;

export function parseMentions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION_REGEX)) {
    const node = m[1].toLowerCase();
    if (KNOWN_MENTION_NODES.has(node)) found.add(node);
  }
  return [...found];
}

/**
 * Fire a kernel event tagged as a room turn (`channel="room"`) so the
 * W12 room-listener on the mentioned node can pick it up and respond.
 * Independent of the Telegram thread — visible alongside it in the shell.
 */
export function emitRoomBridge(opts: {
  chatId: string;
  fromUser: string;
  text: string;
  mentions: string[];
  sessionId?: string | null;
}): void {
  if (opts.mentions.length === 0) return;
  const metadata: Record<string, unknown> = {
    channel: "room",
    chat_id: `tg-bridge-${opts.chatId}`,
    from: opts.fromUser,
    mentions: opts.mentions,
    bridged_from: "telegram",
    bridged_chat_id: opts.chatId,
  };
  if (opts.sessionId) metadata.session_id = opts.sessionId;
  emitKernelEvent({
    body: opts.text,
    severity: "info",
    metadata,
  });
}
