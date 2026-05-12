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
}): void {
  emitKernelEvent({
    body: opts.text,
    severity: "info",
    metadata: {
      channel: "telegram",
      direction: "inbound",
      chat_id: opts.chatId,
      user_id: opts.userId,
      message_id: opts.messageId,
      has_media: opts.hasMedia ?? false,
    },
  });
}

/** Helper for the common Telegram outbound case. */
export function emitTelegramOutbound(opts: {
  chatId: string;
  messageId: string;
  text: string;
  deliveryMs: number;
  outcome: "success" | "error";
}): void {
  emitKernelEvent({
    body: opts.text,
    severity: opts.outcome === "success" ? "success" : "warning",
    metadata: {
      channel: "telegram",
      direction: "outbound",
      chat_id: opts.chatId,
      message_id: opts.messageId,
      delivery_ms: opts.deliveryMs,
      outcome: opts.outcome,
    },
  });
}
