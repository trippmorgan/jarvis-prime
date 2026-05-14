// Load .env BEFORE any module reads process.env at module-init time.
// W17 orchestrator constants (KERNEL_URL / KERNEL_TOKEN) are evaluated
// on import; dotenv must run first.
import "dotenv/config";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { KernelRegister } from "./lieutenant/kernel-register.js";
import { setAgentIdProvider } from "./lieutenant/kernel-events.js";

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

  // 2026-04-25 — pre-warm tier-0 embedder so the first Telegram turn doesn't
  // pay the ~1300ms cold-start hit (xenova model load + seed vector encoding).
  // Fire-and-forget; the classifier is graceful on failure.
  void processor.prewarmTier0().catch((err) => {
    server.log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "tier0 prewarm threw — falling through to lazy init",
    );
  });

  if (poller) {
    poller.start().catch((err) => {
      server.log.error({ error: err instanceof Error ? err.message : String(err) }, 'Telegram poller crashed');
    });
    server.log.info(`Telegram poller started — listening for messages from @${config.TELEGRAM_BOT_USERNAME}`);
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
