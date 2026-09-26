import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { MessageProcessor } from "./bridge/processor.js";
import { registerMessageRoute } from "./routes/message.js";
import { registerChatCompletionsRoute, guardDelivery, guardSurface } from "./routes/chat-completions.js";
import { TelegramPoller } from "./telegram/poller.js";
import { makeReporter, type Reporter } from "./observability/langfuse-reporter.js";

export interface ServerContext {
  server: FastifyInstance
  processor: MessageProcessor
  poller: TelegramPoller | null
  /** W8.8 — reporter handle so the shutdown sequence can drain traces. */
  reporter: Reporter
}

export async function buildServer(config: Config): Promise<ServerContext> {
  const server = Fastify({ logger: true });

  // W8.8 — construct the observability reporter first so we can pass it
  // into the processor. NoopReporter is returned when LANGFUSE_ENABLED=false
  // or when credentials are missing — the bridge never blocks on a remote
  // tracing backend.
  const reporter = await makeReporter({
    enabled: config.LANGFUSE_ENABLED,
    host: config.LANGFUSE_HOST,
    publicKey: config.LANGFUSE_PUBLIC_KEY,
    secretKey: config.LANGFUSE_SECRET_KEY,
    flushAt: config.LANGFUSE_FLUSH_AT,
    flushIntervalMs: config.LANGFUSE_FLUSH_INTERVAL_MS,
    logger: server.log,
  });

  const poller = config.TELEGRAM_BOT_TOKEN
    ? new TelegramPoller({
        botToken: config.TELEGRAM_BOT_TOKEN,
        allowedChatIds: [config.TRIPP_CHAT_ID],
        pollTimeoutSecs: 30,
        onMessage: async (chatId, text, userId, extraContext) => {
          processor.submit(chatId, text, userId, extraContext)
        },
        logger: server.log,
        ...(config.VOLDEMORT_VISION_API_URL ? { visionApiUrl: config.VOLDEMORT_VISION_API_URL } : {}),
        ...(config.VOLDEMORT_VISION_MODEL ? { visionModel: config.VOLDEMORT_VISION_MODEL } : {}),
      })
    : null

  // TUI bridge (2026-09-01): virtual `tui:` chats get their reply back over
  // the HTTP response (routes/chat-completions.ts), so Telegram delivery is a
  // no-op for them — acks, progress bubbles and the final answer alike.
  const deliverTelegram = poller
    ? async (chatId: string, text: string) => { await poller.sendMessage(chatId, text, 'Markdown') }
    : async (chatId: string, text: string) => {
        server.log.warn({ chatId }, 'No Telegram poller — delivery skipped (HTTP-only mode)')
      }
  const deliver = guardDelivery(deliverTelegram)

  // Wave-6 evolving-message surface — a narrow adapter over the poller so the
  // processor never sees the full TelegramPoller instance. When the poller is
  // absent (HTTP-only mode), so is the surface, which drops us onto the legacy
  // ack path naturally.
  //
  // guardSurface: virtual `tui:` chats never reach the Telegram API — see
  // routes/chat-completions.ts.
  const telegramSurface = poller
    ? guardSurface({
        sendMessageAndGetId: (chatId: string, text: string) =>
          poller.sendMessageAndGetId(chatId, text, 'Markdown'),
        editMessageText: (chatId: string, msgId: number, text: string) =>
          poller.editMessageText(chatId, msgId, text),
        sendChatAction: (chatId: string, action: string) =>
          poller.sendChatAction(chatId, action),
      })
    : undefined

  const processor = new MessageProcessor(
    {
      claudePath: config.CLAUDE_PATH,
      claudeModel: config.CLAUDE_MODEL,
      claudeTimeoutMs: config.CLAUDE_TIMEOUT_MS,
      workingDir: config.JARVIS_WORKING_DIR,
      nodeName: config.JARVIS_NODE_NAME,
      botUsername: config.TELEGRAM_BOT_USERNAME,
      corpusCallosumEnabled: config.CORPUS_CALLOSUM_ENABLED,
      gatewayUrl: config.OPENCLAW_GATEWAY_URL,
      gatewayToken: config.OPENCLAW_GATEWAY_TOKEN,
      rightModel: config.OPENCLAW_CHAT_MODEL_RIGHT,
      corpusCallosumTimeoutMs: config.CORPUS_CALLOSUM_TIMEOUT_MS,
      clinicalOverride: config.CORPUS_CLINICAL_OVERRIDE,
      evolvingMessageEnabled: config.JARVIS_EVOLVING_MESSAGE_ENABLED,
      rightBrainAgentEnabled: config.RIGHT_BRAIN_AGENT_ENABLED,
      rightBrainAgentFallback: config.RIGHT_BRAIN_AGENT_FALLBACK,
      routerEnabled: config.JARVIS_ROUTER_ENABLED,
      tier0Enabled: config.JARVIS_TIER0_ENABLED,
      tier0Threshold: config.JARVIS_TIER0_THRESHOLD,
      shortMessageFastLaneEnabled: config.JARVIS_SHORT_MSG_FAST_LANE,
      shortMessageMaxChars: config.JARVIS_SHORT_MSG_MAX_CHARS,
      // Frank/Voldemort boots in full Prime dual-brain mode: left Qwen + right model.
      defaultMode: 'dual',
      defaultLeftRuntime: config.USE_CLAUDE_LEFT ? 'claude' : 'openclaw',
      // 2026-09-16 — harness race. FRANK_HARNESS_RACE=0 disables; FRANK_HARNESS_MODEL picks the lane.
      harnessRace: /^(0|false|off|no)$/i.test(process.env.FRANK_HARNESS_RACE ?? '') ? undefined : {
        url: process.env.FRANK_HARNESS_URL ?? 'http://127.0.0.1:30100',
        model: process.env.FRANK_HARNESS_MODEL ?? 'frank',
        timeoutMs: Number(process.env.FRANK_HARNESS_TIMEOUT_MS ?? 1_200_000),
        ledgerKernelUrl: process.env.LEDGER_KERNEL_URL ?? 'http://100.80.111.84:3000',
        ledgerNode: process.env.LEDGER_NODE ?? 'voldemort',
        kernelToken: process.env.KERNEL_TOKEN,
        // Hook 1 (2026-09-26): Jev-Omni typed verdict in the cross-review. FRANK_JEV=0 disables.
        jevUrl: /^(0|false|off|no)$/i.test(process.env.FRANK_JEV ?? '') ? undefined : (process.env.FRANK_JEV_URL ?? 'http://127.0.0.1:30110'),
        jevTimeoutMs: Number(process.env.FRANK_JEV_TIMEOUT_MS ?? 120_000),
      },
      reporter,
      telegramSurface,
    },
    deliver,
    server.log,
  )

  server.get("/status", async () => ({
    ok: true,
    version: "0.1.0",
    uptime: process.uptime(),
    queue: {
      length: processor.getQueueLength(),
      processing: processor.isProcessing(),
    },
    telegram: poller ? 'active' : 'disabled',
  }));

  registerMessageRoute(server, processor);
  registerChatCompletionsRoute(server, processor);

  return { server, processor, poller, reporter };
}
