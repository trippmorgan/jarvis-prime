import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const { server, poller, reporter } = await buildServer(config);

const shutdown = async (signal: string) => {
  server.log.info({ signal }, "Shutting down");
  poller?.stop();
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

  if (poller) {
    poller.start().catch((err) => {
      server.log.error({ error: err instanceof Error ? err.message : String(err) }, 'Telegram poller crashed');
    });
    server.log.info('Telegram poller started — listening for messages from @trippassistant_bot');
  } else {
    server.log.warn('No TELEGRAM_BOT_TOKEN — running in HTTP-only mode (no Telegram polling)');
  }
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
