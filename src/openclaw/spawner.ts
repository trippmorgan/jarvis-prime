import { spawn, exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { scheduledFetchText } from "../../../tools/gpu-scheduler.mjs";
import { notifyHub, hubNotifyEnv } from "../bridge/hub-notify.js";
import type { SpawnOptions, SpawnResult } from "../claude/types.js";
import type { StreamEvent } from "../claude/stream-formatter.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const DEFAULTS = {
  openclawPath: "/home/joevoldemort/.nvm/versions/node/v22.22.1/bin/openclaw",
  agentId: "main",
  timeoutMs: 300_000,
} as const;

export interface OpenclawSpawnOptions extends SpawnOptions {
  /** Path to the openclaw CLI binary. Default: PATH lookup via nvm shim. */
  openclawPath?: string;
  /** Agent id to invoke (corresponds to `--agent`). Default: "main". */
  agentId?: string;
  /**
   * Optional progress callback. When the left runtime runs its tool loop it
   * emits one synthesized `assistant`/`tool_use` StreamEvent per command so
   * the Telegram evolving-message UX can show "🔧 Bash: <cmd>" mid-flight.
   */
  onEvent?: (event: StreamEvent) => void;
}

interface OpenclawPayload {
  text?: string;
  mediaUrl?: string | null;
}

interface OpenclawJsonEnvelope {
  status?: string;
  summary?: string;
  result?: {
    payloads?: OpenclawPayload[];
    meta?: {
      livenessState?: string;
      error?: { kind?: string; message?: string } | null;
    };
  };
}

/**
 * Pull the assistant's visible reply out of openclaw's `agent --json` envelope.
 *
 * Shape (verified 2026-05-01 against OpenClaw 2026.4.26): the reply lives at
 * `result.payloads[*].text`. Multiple payloads can appear — the first is the
 * model answer, subsequent ones are delivery telemetry (e.g. "✉️ Message
 * failed" when openclaw tries to dispatch via a telegram channel it doesn't
 * have for CLI invocations). We pick the first non-empty payload that doesn't
 * look like a delivery warning.
 *
 * If precheck fires (context overflow, etc.), the error text appears as the
 * sole payload and `meta.error.kind` is set — we surface that text so the
 * caller sees what happened instead of a silent empty reply.
 */
function extractAnswer(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    const parsed = JSON.parse(trimmed) as OpenclawJsonEnvelope;
    const payloads = parsed.result?.payloads ?? [];
    for (const p of payloads) {
      const text = (p.text ?? "").trim();
      if (!text) continue;
      // Skip openclaw's own delivery telemetry payloads.
      if (text.startsWith("⚠️") || text.startsWith("✉️")) continue;
      return text;
    }
    // Fall back to the first payload's text even if it's a warning — that's
    // strictly better than silence (e.g. "Context overflow: ..." surfaces).
    if (payloads[0]?.text) return payloads[0].text.trim();
    return "";
  } catch {
    return trimmed;
  }
}

// ---------------------------------------------------------------------------
// Left-hemisphere tool loop
//
// The `openclaw` left runtime POSTs OpenAI-compatible chat-completions to
// Ollama (local Qwen or Cloud GLM). Plain chat-completion has NO execution
// surface: the model can WRITE `ssh argus ...` but nothing runs it — the
// symptom Tripp hit where Frank narrates a command and pastes zero output.
//
// This loop closes that gap. We hand the model a `run_bash` tool and a real
// agent loop: call → execute tool_calls on the host → feed results back →
// repeat until the model answers without a tool call. Same SpawnResult
// contract as the plain path, so LeftHemisphereClient is unchanged.
//
// Gated by FRANK_LEFT_TOOLS (default ON). Set FRANK_LEFT_TOOLS=false to revert
// to the old narrate-only chat path.
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERS = 12;
const MAX_TOOL_OUTPUT_CHARS = 8_000;
const PER_CMD_TIMEOUT_CAP_MS = 120_000;

const LEFT_TOOL_SYSTEM =
  "You are Frank's LEFT hemisphere running on Voldemort (Tripp's host) with " +
  "FULL shell access through the run_bash tool. You are an EXECUTING agent, " +
  "not a chat model. When a task needs a command, you MUST call run_bash and " +
  "wait for the real output. NEVER fabricate output, and NEVER just print a " +
  "command in prose expecting someone else to run it — calling run_bash is " +
  "the only way a command actually runs. Chain as many run_bash calls as the " +
  "task needs (run_bash also covers reading/writing files via cat/heredoc). " +
  "When finished, give a concise final answer grounded in the actual tool " +
  "output. No <think> tags. " +
  // 2026-09-17: at 06:27 the LEFT looked for a LOCAL script on remote hosts, then told Tripp it had
  // "no working route to the host". The file was on this machine. Locality rule + inability rule:
  "LOCALITY: you run ON Voldemort. Files, scripts, services and logs Tripp mentions are on THIS " +
  "machine unless he names another host — check locally first (ls, cat, find, systemctl, " +
  "journalctl here) before trying ssh anywhere. NEVER say you cannot reach, access, find or " +
  "run something unless a run_bash call you made this turn shows that exact failure; then " +
  "report the command and its real output, not a story about routes or hosts. " +
  "Once you have found what the task needs, run it and answer — do not keep exploring. " +
  // 2026-09-18: "Do some internet research on that game" — LEFT had no search surface and improvised.
  "INTERNET: for anything about news, sports, scores, odds, weather, prices, products, papers, people in " +
  "the news, or any fact that changes over time, call web_search FIRST (kind \"news\" for recent events), " +
  "then read the best page with run_bash (curl -sL <url> | sed 's/<[^>]*>//g' | tr -s ' \\n' | head -c 6000). " +
  "Never answer such questions from memory, never ask which topic when the conversation already names it, " +
  "and cite the source URLs you actually read. " +
  // 2026-10-20: "let Jarvis Prime know" — the LEFT searched the box for a channel and found none (round 27d48004).
  "FLEET: to tell Jarvis Prime (or argus, talos, dj) something, call notify_hub — it posts on the jarvis-os room " +
  "mesh and is the ONLY way a message reaches them. Writing \"I'll let Prime know\" or \"Prime has been notified\" without a " +
  "notify_hub result that says delivered is a false claim. Send one concise message with the facts and paths, after the work is done. " +
  // 2026-10-29: Tripp asked Frank to "ask Claude CLI to check your work"; the LEFT ran `which claude`, got nothing
  // (the service PATH lacked ~/.local/bin) and told him the CLI was not installed. It is. Durable rule:
  "CLAUDE CLI: the Claude Code CLI IS installed and logged in on this box at " +
  (process.env.CLAUDE_PATH || "/home/joevoldemort/.local/bin/claude") +
  " (also on PATH as `claude`). To have Claude audit, review or extend work, run it non-interactively: " +
  "run_bash: printf '%s' \"<task text, name the files to read>\" | claude --print --model sonnet --dangerously-skip-permissions " +
  "(allow up to 600 s; for long audits start it with jobs.sh and report the job id). " +
  "Never claim the CLI is missing unless `claude --version` fails in a run_bash call you made this turn.";

const LEFT_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_bash",
      description:
        "Execute a shell command on Frank's host (Voldemort) and return its " +
        "combined stdout/stderr. Use for anything: ssh, ls, cat, systemctl, " +
        "curl, ollama, git, etc. This is how you ACTUALLY run a command — do " +
        "not just describe a command in your reply.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute via bash -c.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live internet (DuckDuckGo) and return titles, URLs, dates and snippets. Use for news, " +
        "sports, scores, odds, weather, prices, research on any topic. Follow up with run_bash curl on a " +
        "result URL when you need the page body.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (be specific: teams, dates, names)." },
          kind: { type: "string", enum: ["web", "news"], description: "\"news\" for recent events (default web)." },
          max_results: { type: "integer", description: "1-10, default 6." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notify_hub",
      description:
        "Send a message to Jarvis Prime (default) or other fleet agents on the jarvis-os room mesh. This is the " +
        "only way to actually notify Prime/argus/talos/dj — saying you notified them does nothing. One concise " +
        "message per task, with the concrete facts, paths and what you want them to do. Replies arrive on the mesh, not here.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "What to tell them (plain text, under 2000 chars)." },
          to: { type: "array", items: { type: "string" }, description: "Recipient agent ids, default [\"prime\"]. Known: prime, argus, talos, dj, scalpel." },
        },
        required: ["message"],
      },
    },
  },
] as const;

const MAX_NOTIFY_PER_TURN = 3;

const WEBSEARCH_BIN = process.env.FRANK_WEBSEARCH_BIN ?? `${process.env.HOME ?? "/home/joevoldemort"}/.local/bin/websearch`;

/**
 * 2026-09-23 guardrail for LEFT's shell (Tripp's host, no sandbox). Two tiers:
 *  - HARD: never run (host destruction / power / credential files).
 *  - ASK: state-changing or privileged — run only when Tripp's CURRENT message asks for that kind of
 *    action (e.g. "restart stt" allows `systemctl restart frank-stt`). Observed 2026-09-18: LEFT ran
 *    `systemctl stop synology-drive` inside a probe and tried `sudo apt-get install mame` unasked.
 * FRANK_LEFT_GUARD=off disables. Blocked calls return a tool result explaining the block (no bypass).
 */
const HARD_BLOCK: Array<[RegExp, string]> = [
  [/\brm\s+-[a-z]*r[a-z]*\s+(?:--\s+)?(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\/home(?:\/[^\/\s]+)?\/?\*?)(?=\s|$|;|&|\|)/i, "recursive delete of / or home"],
  [/\b(?:shutdown|reboot|poweroff|halt)\b/i, "power control"],
  [/\bmkfs\b|\bdd\s+[^|;]*of=\/dev\/|\bwipefs\b|\bparted\b|\bfdisk\b/i, "disk formatting / raw device writes"],
  [/:\(\)\s*\{/, "fork bomb"],
  [/\/etc\/(?:shadow|sudoers)|>\s*\/etc\/passwd/i, "credential files"],
  [/\bnvidia-smi\b[^|;]*(?:--gpu-reset|-r\b|-pl\b|--power-limit|-lgc|-ac\b)/i, "GPU reset / power or clock change"],
]
const ASK_BLOCK: Array<[RegExp, RegExp, string]> = [
  // [command pattern, words in Tripp's message that authorise it, label]
  [/\bsudo\b/i, /\bsudo\b|\binstall|\broot\b|\badmin/i, "sudo"],
  [/\bsystemctl\s+(?:--user\s+)?(?:stop|disable|mask|kill)\b|\bservice\s+\S+\s+stop\b/i, /\b(?:stop|disable|kill|shut (?:it |that )?(?:down|off)|turn (?:it |that )?off)\b/i, "stopping/disabling a service"],
  [/\bsystemctl\s+(?:--user\s+)?(?:restart|start|enable|reload|daemon-reload)\b/i, /\b(?:restart|start|enable|reload|bring (?:it |that )?(?:back|up)|fix)\b/i, "starting/restarting a service"],
  [/\b(?:kill\s+-9|pkill|killall)\b|\bkill\s+\d/i, /\b(?:kill|stop|end|terminate)\b/i, "killing processes"],
  [/\b(?:apt(?:-get)?|dnf|yum|snap)\s+(?:install|remove|purge|upgrade|dist-upgrade)\b|\bpip3?\s+install\b|\bnpm\s+(?:i|install)\s+-g\b|\bollama\s+(?:pull|rm)\b/i, /\b(?:install|uninstall|remove|upgrade|update|pull)\b/i, "package install/remove"],
  [/\bdocker\s+(?:rm|stop|kill|restart|compose\s+(?:down|up|restart|build))\b/i, /\b(?:docker|container|restart|stop|rebuild|recreate)\b/i, "container lifecycle"],
  [/\b(?:ufw|iptables|nft)\s+(?!status|-L|-S|list)/i, /\b(?:firewall|ufw|port|allow|block|open)\b/i, "firewall change"],
  [/\bcrontab\s+-r\b|\bcrontab\s+-(?!l\b)\S|\bcrontab\s+[^-\s]/i, /\b(?:cron|schedule)\b/i, "crontab change"],
  [/\bgit\s+(?:push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)\b/i, /\b(?:push|reset|revert|clean|discard)\b/i, "destructive git"],
  [/\brm\s+-[a-z]*r/i, /\b(?:delete|remove|clean ?up|wipe|rm)\b/i, "recursive delete"],
  [/\b(?:chmod|chown)\s+-R\b/i, /\b(?:permission|chmod|chown|owner)\b/i, "recursive permission change"],
]
export function currentAsk(prompt: string): string {
  const i = prompt.lastIndexOf("Tripp: ")
  return (i >= 0 ? prompt.slice(i + 7) : prompt.slice(-1500)).slice(0, 2000)
}
export function guardCommand(command: string, ask: string): string | null {
  if (/^(0|false|off|no)$/i.test(process.env.FRANK_LEFT_GUARD ?? "")) return null
  for (const [re, label] of HARD_BLOCK) if (re.test(command)) return `BLOCKED (never allowed from chat): ${label}.`
  for (const [re, auth, label] of ASK_BLOCK) {
    if (re.test(command) && !auth.test(ask)) {
      return `BLOCKED: ${label} needs Tripp to ask for it explicitly, and his current message does not. ` +
        "Do not retry or work around this. Answer with what you found, and if the action would help, tell Tripp the exact command and ask him to confirm."
    }
  }
  return null
}

/** web_search tool → ~/.local/bin/websearch (ddgs). Never throws; errors come back as text. */
async function runWebSearch(query: string, kind: string, maxResults: number, timeoutMs: number): Promise<string> {
  const n = Math.max(1, Math.min(10, Number.isFinite(maxResults) ? maxResults : 6));
  const args = ["-n", String(n), ...(kind === "news" ? ["--news"] : []), "--", query];
  try {
    const { stdout, stderr } = await execFileAsync(WEBSEARCH_BIN, args, { timeout: Math.floor(timeoutMs), maxBuffer: 1024 * 1024 });
    const out = String(stdout ?? "").trim();
    return out || `(no results${stderr ? `: ${String(stderr).trim().slice(0, 200)}` : ""})`;
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
    const out = String(e.stdout ?? "").trim();
    if (out) return out;
    return `(web_search failed: ${String(e.stderr ?? e.code ?? "unknown error").trim().slice(0, 300)})`;
  }
}

/** Evidence: every LEFT tool call lands in the jarvis-prime log (pino-shaped line on stdout). */
function logLeftToolCall(rec: Record<string, unknown>): void {
  try {
    process.stdout.write(JSON.stringify({ level: 30, time: Date.now(), event: "left_tool_call", ...rec, msg: "left tool call" }) + "\n");
  } catch {
    /* logging never breaks the loop */
  }
}

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role?: string;
  content?: string | null;
  reasoning?: string;
  tool_calls?: ToolCall[];
}

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function messageText(msg: ChatMessage | undefined): string {
  if (!msg) return "";
  // Cloud GLM models sometimes return text in `reasoning` with empty `content`.
  const raw = msg.content && msg.content.trim() ? msg.content : msg.reasoning ?? "";
  return stripThink(raw);
}

/** True when a final reply claims the model could not reach/access/find/run
 * something. Combined with "no local command was run this turn" this is the
 * 06:27 2026-09-17 confabulation: inability declared without checking locally. */
export function claimsInability(text: string): boolean {
  return /\b(?:no (?:working |direct |usable )?(?:route|path|access|way)(?: to| into| for)?|can(?:no|')t (?:reach|access|connect(?: to)?|find|locate|get to|see|run|execute)|unable to (?:reach|access|connect|find|locate|run|execute)|(?:don't|do not|doesn't|does not) have (?:access|a route|a way|permission|connectivity)|not (?:reachable|accessible|available to me)|(?:isn't|is not|wasn't|was not) (?:reachable|accessible|found|available)|(?:couldn't|could not) (?:reach|access|connect|find|locate|run|execute))\b/i.test(text);
}

/** Commands that only talk to another host don't count as a local check. */
export function isLocalCommand(command: string): boolean {
  return !/^\s*(?:sudo\s+)?(?:ssh|scp|rsync|sftp)\b/i.test(command);
}

/** True when a final (no-tool-call) reply looks like it's describing a shell
 * command instead of having run one — the exact narrate-but-don't-execute
 * failure mode. Used to nudge the model into actually calling run_bash. */
function looksLikeUnrunCommand(text: string): boolean {
  if (!/```|\$\s|^\s*#/m.test(text) && !/`[^`]+`/.test(text)) return false;
  return /\b(ssh|curl|systemctl|journalctl|cat |ls |grep |cd |sudo|ollama|git |scp|rsync|docker|tail |head )/i.test(
    text,
  );
}

async function runBash(command: string, cwd: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: Math.floor(timeoutMs), // exec requires an unsigned integer
      maxBuffer: 10 * 1024 * 1024,
      shell: "/bin/bash",
    });
    const out = [stdout, stderr].map((s) => (s ?? "").toString()).filter((s) => s.trim()).join("\n").trim();
    return out.length ? out : "(command succeeded, no output)";
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: boolean };
    const parts: string[] = [];
    if (e.stdout && String(e.stdout).trim()) parts.push(String(e.stdout));
    if (e.stderr && String(e.stderr).trim()) parts.push(String(e.stderr));
    parts.push(`(exit ${e.code ?? "?"}${e.killed ? ", killed/timeout" : ""})`);
    return parts.join("\n").trim();
  }
}

function truncateToolOutput(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n…(truncated, ${s.length} chars total)`;
}

/**
 * Reasoning budget for the local hybrid-thinking LEFT (qwen3.5+). The system
 * prompts already ask for no thinking tags, but prompt-level requests don't
 * stop hidden reasoning — unbounded thinking burned up to 297s on a single
 * callosum pass (observed 2026-08-20). "low" keeps a bounded budget; set
 * FRANK_LEFT_REASONING=none|low|medium|high, or "default" to omit the field.
 */
function leftReasoningEffort(): Record<string, string> {
  const effort = process.env.FRANK_LEFT_REASONING ?? "low";
  return effort === "default" ? {} : { reasoning_effort: effort };
}

async function runLeftToolLoop(prompt: string, opts: OpenclawSpawnOptions): Promise<SpawnResult> {
  const start = performance.now();
  const totalTimeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
  const deadline = start + totalTimeoutMs;
  const dur = () => Math.round(performance.now() - start);

  const baseUrl = process.env.FRANK_LEFT_OLLAMA_URL ?? "http://127.0.0.1:11434/v1/chat/completions";
  const model = process.env.FRANK_LEFT_MODEL ?? "qwen3:30b-a3b";
  const apiKey = process.env.FRANK_LEFT_API_KEY ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const cwd = opts?.workingDir ?? process.env.JARVIS_WORKING_DIR ?? process.cwd();
  const onEvent = opts?.onEvent;
  const reasoningEffort = leftReasoningEffort();

  const messages: ChatMessage[] = [
    { role: "system", content: LEFT_TOOL_SYSTEM },
    { role: "user", content: prompt },
  ];

  let lastText = "";
  let executedAny = false;
  let localExecuted = false;
  let nudges = 0;
  let inabilityNudges = 0;
  let wrapUpSent = false;
  let notifies = 0;

  for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      return { output: lastText || "(left runtime timed out before answering)", stderr: "tool loop deadline exceeded", exitCode: 1, durationMs: dur(), timedOut: true };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let raw = "";
    let ok = false;
    let status = 0;
    try {
      const response = await scheduledFetchText(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, tools: LEFT_TOOLS, stream: false, ...reasoningEffort }),
        signal: controller.signal,
      });
      ok = response.ok;
      status = response.status;
      raw = response.text;
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err instanceof Error && err.name === "AbortError";
      return { output: lastText, stderr: err instanceof Error ? err.message : String(err), exitCode: 1, durationMs: dur(), timedOut };
    }
    clearTimeout(timer);

    if (!ok) {
      return { output: lastText, stderr: `left model HTTP ${status}: ${raw.slice(0, 500)}`, exitCode: 1, durationMs: dur(), timedOut: false };
    }

    let msg: ChatMessage | undefined;
    try {
      const parsed = JSON.parse(raw) as { choices?: Array<{ message?: ChatMessage }> };
      msg = parsed.choices?.[0]?.message;
    } catch {
      // Non-JSON body — treat as the final answer text.
      return { output: stripThink(raw), stderr: "", exitCode: 0, durationMs: dur(), timedOut: false };
    }

    const text = messageText(msg);
    if (text) lastText = text;
    const toolCalls = msg?.tool_calls ?? [];

    if (toolCalls.length === 0) {
      // No tool call. If it's the narrate-but-don't-run failure mode and we
      // haven't actually executed anything, nudge once to force execution.
      if (!executedAny && nudges < 1 && looksLikeUnrunCommand(text)) {
        nudges++;
        messages.push({ role: "assistant", content: msg?.content ?? text });
        messages.push({
          role: "user",
          content:
            "You described a command but did not run it. Call the run_bash " +
            "tool now to actually execute it, then report the real output.",
        });
        continue;
      }
      // Inability claimed without a local check: the model says it can't reach/find/run
      // something but never ran a command on THIS host. Force the local check first.
      if (inabilityNudges < 1 && !localExecuted && claimsInability(text)) {
        inabilityNudges++;
        messages.push({ role: "assistant", content: msg?.content ?? text });
        messages.push({
          role: "user",
          content:
            "You claimed you cannot reach, find or run something, but you ran no command on this " +
            "host (Voldemort). Anything Tripp mentioned is local unless he named another host. " +
            "Check locally NOW with run_bash (ls / find / cat / systemctl / journalctl on this " +
            "machine), then answer from the real output. If it genuinely fails, quote the command " +
            "and its output.",
        });
        continue;
      }
      // Empty final: hybrid thinkers can burn the turn reasoning and emit
      // nothing (ported from frank-v3 harness, observed 2026-08-20).
      if (!text.trim() && !lastText.trim() && nudges < 2) {
        nudges++;
        messages.push({ role: "assistant", content: msg?.content ?? "" });
        messages.push({
          role: "user",
          content: executedAny
            ? "Your last message was empty. Using the tool output above, write your final answer now as plain text. Do not call more tools."
            : "Your last message was empty. Begin the task now by calling run_bash. Keep reasoning brief.",
        });
        continue;
      }
      // Narrate-don't-run as a FINAL answer after work started: announcing
      // future work is not an answer (ported from frank-v3 harness).
      if (nudges < 2 &&
          /\b(let me|i(?:'ll| will)(?: now)?|next,? i)\s+(search|run|check|look|try|fetch|query|call|execute|do|continue)\b/i.test(text.slice(0, 300))) {
        nudges++;
        messages.push({ role: "assistant", content: msg?.content ?? text });
        messages.push({
          role: "user",
          content: "You announced further work instead of finishing. Either call run_bash to do it, or if you have enough information, deliver the complete final answer now.",
        });
        continue;
      }
      return { output: lastText, stderr: "", exitCode: 0, durationMs: dur(), timedOut: false };
    }

    // Must echo the assistant turn (with tool_calls) before tool results.
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const fname = tc.function?.name;
      let argObj: { command?: string; query?: string; kind?: string; max_results?: number; message?: string; to?: string[] } = {};
      try {
        argObj = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        /* leave empty */
      }
      let result: string;
      const tcStart = performance.now();
      if (fname === "web_search") {
        const query = String(argObj.query ?? "").trim();
        if (!query) {
          result = "(web_search called with empty query)";
        } else {
          if (onEvent) {
            try {
              onEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query } }] } });
            } catch {
              /* UX callbacks never break the loop */
            }
          }
          const perCall = Math.max(5_000, Math.min(60_000, deadline - performance.now()));
          result = await runWebSearch(query, String(argObj.kind ?? "web"), Number(argObj.max_results ?? 6), perCall);
          executedAny = true;
          localExecuted = true;
          logLeftToolCall({ tool: "web_search", query: query.slice(0, 200), kind: argObj.kind ?? "web", resultChars: result.length, ms: Math.round(performance.now() - tcStart) });
        }
      } else if (fname === "run_bash") {
        const command = String(argObj.command ?? "").trim();
        const blocked = command ? guardCommand(command, currentAsk(prompt)) : null;
        if (!command) {
          result = "(run_bash called with empty command)";
        } else if (blocked) {
          result = blocked;
          executedAny = true;
          logLeftToolCall({ tool: "run_bash", command: command.slice(0, 300), blocked: true, reason: blocked.slice(0, 120), resultChars: 0, ms: 0 });
        } else {
          if (onEvent) {
            try {
              onEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
            } catch {
              /* UX callbacks never break the loop */
            }
          }
          const perCmd = Math.max(5_000, Math.min(PER_CMD_TIMEOUT_CAP_MS, deadline - performance.now()));
          result = await runBash(command, cwd, perCmd);
          executedAny = true;
          if (isLocalCommand(command)) localExecuted = true;
          logLeftToolCall({ tool: "run_bash", command: command.slice(0, 300), resultChars: result.length, ms: Math.round(performance.now() - tcStart) });
        }
      } else if (fname === "notify_hub") {
        const message = String(argObj.message ?? "").trim();
        const to = Array.isArray(argObj.to) ? argObj.to.map(String) : undefined;
        if (!message) {
          result = "(notify_hub called with empty message)";
        } else if (++notifies > MAX_NOTIFY_PER_TURN) {
          result = `(notify_hub refused: already sent ${MAX_NOTIFY_PER_TURN} messages this turn — finish your answer)`;
        } else {
          if (onEvent) {
            try {
              onEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "NotifyHub", input: { to: to ?? ["prime"], message: message.slice(0, 200) } }] } });
            } catch {
              /* UX callbacks never break the loop */
            }
          }
          const r = await notifyHub({ message, to }, hubNotifyEnv(), fetch, Math.max(5_000, Math.min(15_000, deadline - performance.now())));
          result = r.text;
          executedAny = true;
          localExecuted = true;
          logLeftToolCall({ tool: "notify_hub", to: r.to, chars: message.length, ok: r.ok, eventId: r.eventId ?? null, resultChars: result.length, ms: Math.round(performance.now() - tcStart) });
        }
      } else {
        result = `(unknown tool: ${fname})`;
      }
      // 2026-09-22: evidence for the cross-review — which tool ran with what input and what came back.
      // formatStreamEvent ignores non-assistant events, so the Telegram progress bubble is unaffected.
      if (onEvent) {
        try {
          onEvent({ type: "user", message: { content: [{ type: "tool_result", name: fname, input: fname === "web_search" ? { query: argObj.query } : fname === "notify_hub" ? { to: argObj.to ?? ["prime"], message: String(argObj.message ?? "").slice(0, 200) } : { command: argObj.command }, text: String(result).replace(/\s+/g, " ").slice(0, 1500) }] } });  // 2026-10-20: was 240; the reviewer saw almost nothing
        } catch {
          /* UX callbacks never break the loop */
        }
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: truncateToolOutput(result) } as ChatMessage & { tool_call_id?: string });
    }

    // Time pressure (2026-09-17): a live "Rerun the brain review" run made 23 local calls and
    // hit the 360 s deadline mid-exploration with no answer — the iteration cap never fired
    // because each turn batched several commands. Nudge once when <30 % (min 45 s) remains.
    const left = deadline - performance.now();
    if (!wrapUpSent && left < Math.max(45_000, totalTimeoutMs * 0.3)) {
      wrapUpSent = true;
      messages.push({
        role: "user",
        content:
          `Time budget nearly exhausted (~${Math.max(0, Math.round(left / 1000))} s left). Stop exploring. ` +
          "If completing the task needs exactly one more command, call run_bash once now; otherwise " +
          "deliver the final answer NOW as plain text from the output you already have, with no further tool calls.",
      });
      continue;
    }
    // Deadline pressure: without it, explorers circle on near-identical
    // commands until the cap kills them (ported from frank-v3 harness).
    if (iter === MAX_TOOL_ITERS - 3) {
      messages.push({
        role: "user",
        content: "Iteration budget nearly exhausted — at most 2 turns remain. Stop exploring. Compile your final answer NOW from the output you already have, as plain text with no further tool calls.",
      });
    }
  }

  // Iteration cap hit — return whatever the model last said.
  return {
    output: lastText || "(left runtime hit the tool-iteration limit without a final answer)",
    stderr: "tool loop iteration cap reached",
    exitCode: 0,
    durationMs: dur(),
    timedOut: false,
  };
}

/**
 * Spawn the openclaw CLI as the left brain, giving qwen3:30b-a3b (or whatever
 * the openclaw `main` agent is bound to) the same tool surface Claude has via
 * its CLI. Mirrors spawnClaude's contract — same SpawnResult — so it slots in
 * behind LeftHemisphereClient with no caller changes.
 *
 * Runs: openclaw agent --agent <id> --message <prompt> --json
 */
export async function spawnOpenclawAgent(
  prompt: string,
  opts?: OpenclawSpawnOptions,
): Promise<SpawnResult> {
  // Frank/Voldemort: the OpenClaw gateway on :18790 is currently disabled due
  // to a Telegram-provider CPU spin. For the Prime left hemisphere, keep Qwen
  // local and deterministic by calling Ollama directly instead of spawning the
  // OpenClaw CLI (which attempts the disabled gateway before embedded fallback).
  if (process.env.FRANK_LEFT_USE_OPENCLAW_CLI !== "true") {
    // Tool-enabled agent loop (default). Gives the direct-Ollama left runtime a
    // real run_bash execution surface so glm-5.3/Qwen actually runs commands
    // instead of narrating them. FRANK_LEFT_TOOLS=false reverts to plain chat.
    if (process.env.FRANK_LEFT_TOOLS !== "false") {
      return runLeftToolLoop(prompt, opts ?? {});
    }

    // Legacy plain chat-completion path — no tools, narrate-only.
    const start = performance.now();
    const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const baseUrl = process.env.FRANK_LEFT_OLLAMA_URL ?? "http://127.0.0.1:11434/v1/chat/completions";
      const model = process.env.FRANK_LEFT_MODEL ?? "qwen3:30b-a3b";
      // Optional bearer auth — required when FRANK_LEFT_OLLAMA_URL points at
      // Ollama Cloud (https://ollama.com/v1). Falls back to the same token the
      // right hemisphere uses. Empty => no header (local Ollama needs none).
      const apiKey = process.env.FRANK_LEFT_API_KEY ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
      const response = await scheduledFetchText(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are Frank's LEFT hemisphere: rigorous, structured, practical, and concise. No thinking tags." },
            { role: "user", content: prompt },
          ],
          stream: false,
          ...leftReasoningEffort(),
        }),
        signal: controller.signal,
      });
      const raw = response.text;
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);
      if (!response.ok) {
        return { output: "", stderr: `left model HTTP ${response.status}: ${raw.slice(0, 500)}`, exitCode: 1, durationMs, timedOut: false };
      }
      const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string; reasoning?: string } }> };
      const msg = parsed.choices?.[0]?.message;
      // Cloud GLM models sometimes return text in `reasoning` with empty `content`.
      const rawText = (msg?.content && msg.content.trim()) ? msg.content : (msg?.reasoning ?? "");
      const output = rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      return { output, stderr: "", exitCode: 0, durationMs, timedOut: false };
    } catch (err) {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);
      const timedOut = err instanceof Error && err.name === "AbortError";
      return { output: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1, durationMs, timedOut };
    }
  }
  const openclawPath = opts?.openclawPath ?? DEFAULTS.openclawPath;
  const agentId = opts?.agentId ?? DEFAULTS.agentId;
  const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
  const workingDir = opts?.workingDir ?? process.cwd();
  const timeoutSecs = Math.max(60, Math.ceil(timeoutMs / 1000));

  // Force a fresh session every spawn. jarvis-prime owns the conversation
  // history (history.jsonl, persisted across turns and threaded into the
  // prompt). If we let openclaw reuse its default `agent:main:main` session,
  // it stacks turns on top of jarvis-prime's already-formatted prompt and
  // overflows qwen3:30b-a3b's 32k window after 3-4 messages — the model
  // returns the precheck error text instead of an answer.
  const sessionId = `jarvis-prime-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const args = [
    "agent",
    "--agent", agentId,
    "--session-id", sessionId,
    "--message", prompt,
    "--json",
    "--timeout", String(timeoutSecs),
  ];

  const start = performance.now();

  return new Promise<SpawnResult>((resolve) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // detached: true puts the openclaw CLI in its own process group so
    // SIGKILL on timeout reaches descendants (the exec-tool shell processes
    // it spawns); without this, killing the CLI leaves shell children with
    // inherited stdio FDs holding our pipes open, and `close` fires minutes
    // late.
    const child = spawn(openclawPath, args, {
      cwd: workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      detached: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);
      const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");

      resolve({
        output: extractAnswer(rawStdout),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
        durationMs,
        timedOut,
      });
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);
      resolve({
        output: "",
        stderr: err.message,
        exitCode: 1,
        durationMs,
        timedOut: false,
      });
    });
  });
}
