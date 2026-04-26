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
  CLAUDE_TIMEOUT_MS: z.coerce.number().default(120_000),
  OPENCLAW_GATEWAY_URL: z.string().default("http://127.0.0.1:18789"),
  OPENCLAW_GATEWAY_TOKEN: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
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
  // Dual-brain orchestrations (Claude + GPT-Codex via corpus callosum) routinely
  // run 5-15 minutes when /deep is on. 20 min gives genuine reasoning room
  // before the kill switch trips; raise further if /deep work keeps timing out.
  CORPUS_CALLOSUM_TIMEOUT_MS: z.coerce.number().default(1_200_000),
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
