import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { MessageProcessor } from "./bridge/processor.js";
import { registerMessageRoute } from "./routes/message.js";
import { TelegramPoller } from "./telegram/poller.js";
import { makeReporter, type Reporter } from "./observability/langfuse-reporter.js";
import { createTelegramOrchestratorHook } from "./orchestrator/telegram-hook.js";
import { reviewOrchestratorReply, type OversightTurn } from "./orchestrator/intent-oversight.js";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

// W21.7 — pull the last few conversation turns so the intent-oversight
// judge can read terse messages ("Update", "Publish") in context.
function recentConversationTurns(limit = 6): OversightTurn[] {
  try {
    const p = pathResolve(process.cwd(), ".data/conversation-history.jsonl");
    const lines = readFileSync(p, "utf8").trim().split("\n");
    const turns: OversightTurn[] = [];
    for (const ln of lines.slice(-limit)) {
      try {
        const o = JSON.parse(ln) as { role?: string; content?: string };
        if ((o.role === "user" || o.role === "assistant") && o.content) {
          turns.push({ role: o.role, content: o.content });
        }
      } catch {
        /* skip unparseable line */
      }
    }
    return turns;
  } catch {
    return [];
  }
}

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

  // W17: orchestrator hook intercepts non-chat intents (query/workflow/
  // status) and runs them through the command layer. Chat messages fall
  // through to MessageProcessor unchanged.
  const orchestratorHook = createTelegramOrchestratorHook({
    deliver: async (chatId, text) => {
      if (poller) await poller.sendMessage(chatId, text, 'Markdown')
    },
    onChat: (chatId, text, userId) => {
      processor.submit(chatId, text, userId)
    },
    // W21.7 — re-read auto/deterministic replies against context.
    reviewIntent: async ({ userText, autoReply, klass }) => {
      try {
        return await reviewOrchestratorReply({
          userText,
          autoReply,
          klass,
          recentTurns: recentConversationTurns(),
        })
      } catch {
        return { ok: true }
      }
    },
  })

  const poller = (!config.JARVIS_TELEGRAM_DISABLED && config.TELEGRAM_BOT_TOKEN)
    ? new TelegramPoller({
        botToken: config.TELEGRAM_BOT_TOKEN,
        allowedChatIds: [config.TRIPP_CHAT_ID],
        pollTimeoutSecs: 30,
        offsetPersistPath: `${config.JARVIS_WORKING_DIR}/.data/telegram-offset.json`,
        onMessage: async (chatId, text, userId) => {
          await orchestratorHook(chatId, text, userId)
        },
        logger: server.log,
      })
    : null

  const deliver = poller
    ? async (chatId: string, text: string) => { await poller.sendMessage(chatId, text, 'Markdown') }
    : async (chatId: string, text: string) => {
        server.log.warn({ chatId }, 'No Telegram poller — delivery skipped (HTTP-only mode)')
      }

  // Wave-6 evolving-message surface — a narrow adapter over the poller so the
  // processor never sees the full TelegramPoller instance. When the poller is
  // absent (HTTP-only mode), so is the surface, which drops us onto the legacy
  // ack path naturally.
  const telegramSurface = poller
    ? {
        sendMessageAndGetId: (chatId: string, text: string) =>
          poller.sendMessageAndGetId(chatId, text, 'Markdown'),
        editMessageText: (chatId: string, msgId: number, text: string) =>
          poller.editMessageText(chatId, msgId, text),
        sendChatAction: (chatId: string, action: string) =>
          poller.sendChatAction(chatId, action),
      }
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
      leftHemisphereFastTimeoutMs: config.LEFT_HEMISPHERE_FAST_TIMEOUT_MS,
      clinicalOverride: config.CORPUS_CLINICAL_OVERRIDE,
      evolvingMessageEnabled: config.JARVIS_EVOLVING_MESSAGE_ENABLED,
      rightBrainAgentEnabled: config.RIGHT_BRAIN_AGENT_ENABLED,
      rightBrainAgentFallback: config.RIGHT_BRAIN_AGENT_FALLBACK,
      routerEnabled: config.JARVIS_ROUTER_ENABLED,
      tier0Enabled: config.JARVIS_TIER0_ENABLED,
      tier0Threshold: config.JARVIS_TIER0_THRESHOLD,
      shortMessageFastLaneEnabled: config.JARVIS_SHORT_MSG_FAST_LANE,
      shortMessageMaxChars: config.JARVIS_SHORT_MSG_MAX_CHARS,
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

  return { server, processor, poller, reporter };
}
