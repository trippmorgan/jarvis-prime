// Load .env BEFORE any module reads process.env at module-init time.
// W17 orchestrator constants (KERNEL_URL / KERNEL_TOKEN) are evaluated
// on import; dotenv must run first.
import "dotenv/config";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { KernelRegister } from "./lieutenant/kernel-register.js";
import { setAgentIdProvider } from "./lieutenant/kernel-events.js";
import { warmupClassifierLLM } from "./orchestrator/classify-llm.js";
import { warmupPlannerLLM } from "./orchestrator/plan-llm.js";
import { startEventLoopWatchdog } from "./lieutenant/watchdog.js";
import { startDeathWatch } from "./lieutenant/death-watch.js";

const config = loadConfig();
const { server, processor, poller, reporter } = await buildServer(config);

// W9 — register jarvis-prime as a Tier-2 telegram-bot row in the jarvis-os
// kernel registry (spec §6.2). Heartbeats every 60s; deregisters on SIGTERM.
const kernel = new KernelRegister(server.log);

const shutdown = async (signal: string) => {
  server.log.info({ signal }, "Shutting down");
  poller?.stop();
  await kernel.deregister().catch(() => undefined);
  await server.close();
  // W8.8 — drain in-flight Langfuse traces before exit. NoopReporter
  // resolves immediately when the feature is disabled.
  await reporter.shutdown().catch((err) => {
    server.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "reporter shutdown threw — exiting anyway",
    );
  });
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await server.listen({ port: config.PORT, host: "0.0.0.0" });

  // Event-loop watchdog — if a turn ever wedges the main thread (the 100%-CPU
  // freeze), a worker thread kills the process so pm2 restarts it. Paired with
  // the persisted Telegram offset, the wedging message isn't re-fetched, so the
  // freeze self-heals in ~1 min instead of hanging. Opt-out via env.
  if (process.env.JARVIS_WATCHDOG_ENABLED !== "false") {
    startEventLoopWatchdog({
      thresholdMs: Number(process.env.JARVIS_WATCHDOG_THRESHOLD_MS ?? 60_000),
      logger: server.log,
    });
  }

  // Death-watch — rolling pre-mortem snapshot. prime has been dying by
  // external SIGKILL (-9) with EMPTY stderr: not the watchdog (it logs first),
  // not a Node crash (no stack trace), not a graceful SIGTERM (logs "Shutting
  // down"). A SIGKILL can't be caught, so we persist memory/queue snapshots to
  // .data/crash-trace.log; the tail after a kill is the state at death, which
  // tells us if it's memory pressure / Jetsam (rss climbing) or not. Opt-out
  // via env. Path mirrors the offsetPersistPath convention in server.ts.
  if (process.env.JARVIS_DEATHWATCH_ENABLED !== "false") {
    startDeathWatch({
      path: `${config.JARVIS_WORKING_DIR}/.data/crash-trace.log`,
      intervalMs: Number(process.env.JARVIS_DEATHWATCH_INTERVAL_MS ?? 10_000),
      getQueueDepth: () => processor.getQueueLength(),
      isProcessing: () => processor.isProcessing(),
      logger: server.log,
    });
  }

  // 2026-04-25 — pre-warm tier-0 embedder so the first Telegram turn doesn't
  // pay the ~1300ms cold-start hit (xenova model load + seed vector encoding).
  // Fire-and-forget; the classifier is graceful on failure.
  void processor.prewarmTier0().catch((err) => {
    server.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "tier0 prewarm threw — falling through to lazy init",
    );
  });

  // W18 — preheat gemma4:e2b on Frank so first Telegram turn after a
  // Prime restart doesn't pay the ~9s cold-load. Fire-and-forget.
  void warmupClassifierLLM().catch((err) => {
    server.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "W18 classifier warmup threw — first call will retry",
    );
  });

  // W19c — preheat gemma4:e4b (the JSON planner). Same fail-safe pattern.
  void warmupPlannerLLM().catch((err) => {
    server.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "W19c planner warmup threw — first call will retry",
    );
  });

  if (poller) {
    poller.start().catch((err) => {
      server.log.error({ error: err instanceof Error ? err.message : String(err) }, 'Telegram poller crashed');
    });
    server.log.info(`Telegram poller started — listening for messages from @${config.TELEGRAM_BOT_USERNAME}`);
  } else if (config.JARVIS_TELEGRAM_DISABLED) {
    server.log.warn('JARVIS_TELEGRAM_DISABLED=true — HTTP-only mode (token present but poller suppressed; OpenClaw owns the bot)');
  } else {
    server.log.warn('No TELEGRAM_BOT_TOKEN — running in HTTP-only mode (no Telegram polling)');
  }

  // Register with jarvis-os kernel after listen so the row reflects the live port.
  // Wire kernel-events.emitKernelEvent() to use this agent_id once available.
  setAgentIdProvider(() => kernel.getSelfId());
  void kernel.register({
    kind: "telegram-bot",
    node: "prime",
    capabilities: poller
      ? ["telegram-poll", "telegram-deliver", "briefing", "router"]
      : ["briefing", "router"],
    port: config.PORT,
    metadata: {
      bot_username: config.TELEGRAM_BOT_USERNAME,
      poller_enabled: Boolean(poller),
    },
  }).then(() => kernel.startHeartbeatLoop());
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
