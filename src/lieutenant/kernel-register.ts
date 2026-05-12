/**
 * Self-registration into the jarvis-os kernel agent registry.
 *
 * jarvis-prime / jarvis-brain registers as a Tier-2 telegram-bot process on
 * boot, heartbeats every 60s, and deregisters cleanly on SIGTERM. Per spec
 * §6.2 / §14: every long-lived process gets a row.
 *
 * Failure mode: kernel unavailable → log + retry on next heartbeat. Never
 * throws at callers.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

interface KernelConfig {
  url: string;
  token: string;
}

interface RegisterOptions {
  kind: string;
  node?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  port?: number;
}

function loadKernelConfig(): KernelConfig | null {
  const url = process.env.KERNEL_URL;
  const token = process.env.KERNEL_TOKEN;
  if (url && token) return { url, token };

  // Fallback: openclaw.json
  try {
    const raw = readFileSync(`${homedir()}/.openclaw/openclaw.json`, "utf-8");
    const d = JSON.parse(raw);
    const u = d?.kernel?.url;
    const t = d?.kernel?.token;
    if (u && t) return { url: u, token: t };
  } catch {
    /* ignore */
  }

  // Last resort: read jarvis-os .env directly
  try {
    const env = readFileSync(
      "/home/tripp/.openclaw/workspace/jarvis-os/.env",
      "utf-8",
    );
    const m = env.match(/^API_TOKEN=(.+)$/m);
    if (m) {
      return {
        url: "http://100.80.111.84:3000",
        token: m[1].trim(),
      };
    }
  } catch {
    /* ignore */
  }

  return null;
}

export class KernelRegister {
  private readonly cfg: KernelConfig | null;
  private selfId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pendingOpts: RegisterOptions | null = null;
  private readonly log: (level: "info" | "warn", msg: string, ctx?: Record<string, unknown>) => void;

  public degraded = false;

  constructor(logger?: { info: (ctx: Record<string, unknown>, msg: string) => void; warn: (ctx: Record<string, unknown>, msg: string) => void }) {
    this.cfg = loadKernelConfig();
    this.log = logger
      ? (level, msg, ctx) => {
          if (level === "warn") logger.warn(ctx ?? {}, msg);
          else logger.info(ctx ?? {}, msg);
        }
      : (level, msg, ctx) => {
          // eslint-disable-next-line no-console
          console.log(`[kernel-register:${level}] ${msg}`, ctx ?? "");
        };
    if (!this.cfg) {
      this.degraded = true;
      this.log("warn", "no kernel config — running degraded");
    }
  }

  private async call(method: "POST", path: string, body?: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown }> {
    if (!this.cfg) return { ok: false, status: 0, data: null };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${this.cfg.url}/api/v1/registry${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify(body ?? {}),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      let data: unknown = null;
      try { data = await res.json(); } catch { /* ignore */ }
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      this.degraded = true;
      this.log("warn", "kernel call failed", { method, path, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, status: 0, data: null };
    }
  }

  async register(opts: RegisterOptions): Promise<string | null> {
    this.pendingOpts = opts;
    const res = await this.call("POST", "/agents/register", {
      tier: 2,
      node: opts.node ?? "prime",
      kind: opts.kind,
      capabilities: opts.capabilities ?? [],
      headless: true,
      auth_scope: "general",
      reachable_via: opts.port ? [{ transport: "http", url: `http://100.80.111.84:${opts.port}` }] : [],
      metadata: opts.metadata ?? {},
    });
    if (res.ok && res.data && typeof res.data === "object") {
      const agent = (res.data as { agent?: { id?: string } }).agent;
      if (agent?.id) {
        this.selfId = agent.id;
        this.degraded = false;
        this.log("info", "registered with jarvis-os kernel", { id: agent.id });
        return agent.id;
      }
    }
    this.log("warn", "kernel register failed; will retry on heartbeat", { status: res.status });
    return null;
  }

  async heartbeat(): Promise<void> {
    if (!this.selfId) {
      if (this.pendingOpts) await this.register(this.pendingOpts);
      return;
    }
    const res = await this.call("POST", `/agents/${this.selfId}/heartbeat`);
    if (!res.ok && res.status === 404) {
      this.selfId = null;
      if (this.pendingOpts) await this.register(this.pendingOpts);
    }
  }

  startHeartbeatLoop(intervalMs = 60_000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async deregister(): Promise<void> {
    this.stopHeartbeatLoop();
    if (!this.selfId) return;
    await this.call("POST", `/agents/${this.selfId}/deregister`);
    this.selfId = null;
  }

  getSelfId(): string | null { return this.selfId; }
}
