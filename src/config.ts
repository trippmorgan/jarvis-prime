import { z } from "zod";

/**
 * Parses common truthy/falsy string representations of a boolean env var.
 * Accepts: "true"/"false", "1"/"0", "yes"/"no", "on"/"off" (case-insensitive).
 * Falls back to the provided default when the value is missing.
 */
const boolFromEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((val, ctx) => {
      if (val === undefined || val === "") return defaultValue;
      const normalized = val.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected boolean-like string, got "${val}"`,
      });
      return z.NEVER;
    });

const baseSchema = z.object({
  PORT: z.coerce.number().default(3100),
  CLAUDE_PATH: z.string().default("/home/tripp/.local/bin/claude"),
  CLAUDE_MODEL: z.string().default("sonnet"),
  CLAUDE_TIMEOUT_MS: z.coerce.number().default(300_000),
  OPENCLAW_GATEWAY_URL: z.string().default("http://127.0.0.1:18789"),
  OPENCLAW_GATEWAY_TOKEN: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  // HTTP-only mode killswitch. When true, the Telegram poller is NOT
  // constructed even if TELEGRAM_BOT_TOKEN is set — the brain runs as a
  // pure HTTP / Jarvis-OS orchestration backend and never races OpenClaw
  // for the bot. This is the safe steady state while OpenClaw owns
  // Telegram; flipping it to false (+ restart) is what hands the bot to
  // Prime, mirroring `jarvis-toggle prime`. Default false (poll if token).
  JARVIS_TELEGRAM_DISABLED: boolFromEnv(false),
  TRIPP_CHAT_ID: z.string().default("8048875001"),
  WORKSPACE_DIR: z.string().default("/home/tripp/.openclaw/workspace"),
  DELIVERY_QUEUE_DIR: z.string().default("/home/tripp/.openclaw/delivery-queue"),
  // Bridge process working directory — passed as cwd to every Claude spawn and
  // used to derive the conversation history path. Override on non-SuperServer
  // ports (e.g. JARVIS_WORKING_DIR=/home/jarvisagent/.openclaw/workspace/jarvis-prime/
  // on Argus, /home/djjarvis/... on Pretoria) to keep the harness on a clean
  // upstream tag without per-node source forks.
  JARVIS_WORKING_DIR: z.string().default("/home/tripp/.openclaw/workspace/jarvis-prime/"),
  // Display name of this node — fed into Claude's system context every turn so
  // the model knows it's Argus / DJ Jarvis / etc, not always Prime.
  JARVIS_NODE_NAME: z.string().default("Jarvis Prime"),
  // Bot username (without @) this node serves on Telegram. Used in the system
  // context and the startup log line. Override per node so Argus advertises
  // @Jarvis_Argus_Sentry_Bot and DJ Jarvis advertises @djjarvis_bot.
  TELEGRAM_BOT_USERNAME: z.string().default("trippassistant_bot"),
  CORPUS_CALLOSUM_ENABLED: boolFromEnv(true),
  OPENCLAW_CHAT_MODEL_RIGHT: z.string().default("gpt-5.4 codex"),
  // W17.2 — DEPRECATED. Read for backwards compatibility but no longer
  // wired into the dual-brain spawn. Telegram users won't wait 20 min for
  // a reply; the new LEFT_HEMISPHERE_FAST_TIMEOUT_MS is the live knob.
  CORPUS_CALLOSUM_TIMEOUT_MS: z.coerce.number().default(1_200_000),
  // W17.2 — hard cap on a single dual-brain Claude CLI spawn. Default 90s:
  // a Telegram user has long since given up by then, and the W17 orchestrator
  // is the path for genuinely structured/long work — dual-brain is the chat
  // fallback. Raise this only if /deep chat is regularly hitting the cap.
  LEFT_HEMISPHERE_FAST_TIMEOUT_MS: z.coerce.number().default(180_000),
  CORPUS_CLINICAL_OVERRIDE: boolFromEnv(false),
  JARVIS_EVOLVING_MESSAGE_ENABLED: boolFromEnv(true),
  RIGHT_BRAIN_AGENT_ENABLED: boolFromEnv(false),
  RIGHT_BRAIN_AGENT_FALLBACK: boolFromEnv(true),
  JARVIS_ROUTER_ENABLED: boolFromEnv(false),
  JARVIS_TIER0_ENABLED: boolFromEnv(false),
  // W8.7.1 — default tightened from 0.65 → 0.50. Live "good morning jarvis"
  // scored 0.595 cosine and missed the old threshold; 0.50 catches more of
  // the common chitchat without bringing in too many tool-call false matches.
  JARVIS_TIER0_THRESHOLD: z.coerce.number().default(0.5),
  // W8.7.1 — short-message fast lane killswitch + length cap. Defaults: on,
  // 80 chars. Set JARVIS_SHORT_MSG_FAST_LANE=false to disable.
  JARVIS_SHORT_MSG_FAST_LANE: boolFromEnv(true),
  JARVIS_SHORT_MSG_MAX_CHARS: z.coerce.number().default(80),
  LANGFUSE_ENABLED: boolFromEnv(false),
  LANGFUSE_HOST: z.string().default(""),
  LANGFUSE_PUBLIC_KEY: z.string().default(""),
  LANGFUSE_SECRET_KEY: z.string().default(""),
  LANGFUSE_FLUSH_AT: z.coerce.number().default(10),
  LANGFUSE_FLUSH_INTERVAL_MS: z.coerce.number().default(5_000),
});

/**
 * When the corpus callosum (dual-brain) is enabled, the OpenClaw gateway
 * URL and token must both be non-empty. When disabled, they may be absent.
 */
const configSchema = baseSchema.superRefine((cfg, ctx) => {
  if (cfg.CORPUS_CALLOSUM_ENABLED) {
    if (!cfg.OPENCLAW_GATEWAY_URL || cfg.OPENCLAW_GATEWAY_URL.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENCLAW_GATEWAY_URL"],
        message:
          "OPENCLAW_GATEWAY_URL is required when CORPUS_CALLOSUM_ENABLED=true",
      });
    }
    if (!cfg.OPENCLAW_GATEWAY_TOKEN || cfg.OPENCLAW_GATEWAY_TOKEN.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENCLAW_GATEWAY_TOKEN"],
        message:
          "OPENCLAW_GATEWAY_TOKEN is required when CORPUS_CALLOSUM_ENABLED=true",
      });
    }
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse(process.env);
}
