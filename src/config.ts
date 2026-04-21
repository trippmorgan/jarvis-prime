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
  CORPUS_CALLOSUM_ENABLED: boolFromEnv(true),
  OPENCLAW_CHAT_MODEL_RIGHT: z.string().default("gpt-5.4 codex"),
  CORPUS_CALLOSUM_TIMEOUT_MS: z.coerce.number().default(240_000),
  CORPUS_CLINICAL_OVERRIDE: boolFromEnv(false),
  JARVIS_EVOLVING_MESSAGE_ENABLED: boolFromEnv(true),
  RIGHT_BRAIN_AGENT_ENABLED: boolFromEnv(false),
  RIGHT_BRAIN_AGENT_FALLBACK: boolFromEnv(true),
  JARVIS_ROUTER_ENABLED: boolFromEnv(false),
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
