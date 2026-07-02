import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import type { SpawnOptions, SpawnResult } from "../claude/types.js";
import type { StreamEvent } from "../claude/stream-formatter.js";

const execAsync = promisify(exec);

const DEFAULTS = {
  openclawPath: "/Users/trippmorgan/.local/bin/openclaw",
  agentId: "main",
  timeoutMs: 300_000,
} as const;

export interface OpenclawSpawnOptions extends SpawnOptions {
  /** Path to the openclaw CLI binary. Default: Argus Mac mini install path. */
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
export function extractAnswer(raw: string): string {
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
// Ollama (local or Cloud GLM). Plain chat-completion has NO execution
// surface: the model can WRITE `ssh superserver ...` but nothing runs it —
// the symptom Tripp hit on Frank where the left brain narrates a command and
// pastes zero output.
//
// This loop closes that gap. We hand the model a `run_bash` tool and a real
// agent loop: call → execute tool_calls on the host → feed results back →
// repeat until the model answers without a tool call. Same SpawnResult
// contract as the plain path, so LeftHemisphereClient is unchanged.
//
// Gated by LEFT_TOOLS (default ON). Set LEFT_TOOLS=false to revert
// to the old narrate-only chat path.
// ---------------------------------------------------------------------------

const MAX_TOOL_ITERS = 12;
const MAX_TOOL_OUTPUT_CHARS = 8_000;
const PER_CMD_TIMEOUT_CAP_MS = 120_000;

const LEFT_TOOL_SYSTEM =
  "You are Argus's LEFT hemisphere running on Argus (Tripp's Mac mini) with " +
  "FULL shell access through the run_bash tool. You are an EXECUTING agent, " +
  "not a chat model. When a task needs a command, you MUST call run_bash and " +
  "wait for the real output. NEVER fabricate output, and NEVER just print a " +
  "command in prose expecting someone else to run it — calling run_bash is " +
  "the only way a command actually runs. Chain as many run_bash calls as the " +
  "task needs (run_bash also covers reading/writing files via cat/heredoc). " +
  "When finished, give a concise final answer grounded in the actual tool " +
  "output. No <think> tags.";

const LEFT_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_bash",
      description:
        "Execute a shell command on Argus's host (Tripp's Mac mini) and " +
        "return its combined stdout/stderr. Use for anything: ssh, ls, cat, " +
        "curl, git, launchctl, etc. This is how you ACTUALLY run a command — " +
        "do not just describe a command in your reply.",
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
] as const;

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

export function messageText(msg: ChatMessage | undefined): string {
  if (!msg) return "";
  // Cloud GLM models sometimes return text in `reasoning` with empty `content`.
  const raw = msg.content && msg.content.trim() ? msg.content : msg.reasoning ?? "";
  return stripThink(raw);
}

/** True when a final (no-tool-call) reply looks like it's describing a shell
 * command instead of having run one — the exact narrate-but-don't-execute
 * failure mode. Used to nudge the model into actually calling run_bash. */
export function looksLikeUnrunCommand(text: string): boolean {
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

async function runLeftToolLoop(prompt: string, opts: OpenclawSpawnOptions): Promise<SpawnResult> {
  const start = performance.now();
  const totalTimeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
  const deadline = start + totalTimeoutMs;
  const dur = () => Math.round(performance.now() - start);

  const baseUrl = process.env.LEFT_OLLAMA_URL ?? "http://127.0.0.1:11434/v1/chat/completions";
  const model = process.env.LEFT_MODEL ?? "glm-5.2";
  // SECURITY: no fallback to OPENCLAW_GATEWAY_TOKEN here — on Argus that is
  // the real local gateway token and must never be sent to ollama.com.
  const apiKey = process.env.LEFT_API_KEY ?? "";
  const cwd = opts?.workingDir ?? process.env.JARVIS_WORKING_DIR ?? process.cwd();
  const onEvent = opts?.onEvent;

  const messages: ChatMessage[] = [
    { role: "system", content: LEFT_TOOL_SYSTEM },
    { role: "user", content: prompt },
  ];

  let lastText = "";
  let executedAny = false;
  let nudges = 0;

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
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ model, messages, tools: LEFT_TOOLS, stream: false }),
        signal: controller.signal,
      });
      ok = response.ok;
      status = response.status;
      raw = await response.text();
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
      return { output: lastText, stderr: "", exitCode: 0, durationMs: dur(), timedOut: false };
    }

    // Must echo the assistant turn (with tool_calls) before tool results.
    messages.push({ role: "assistant", content: msg?.content ?? "", tool_calls: toolCalls });

    for (const tc of toolCalls) {
      const fname = tc.function?.name;
      let argObj: { command?: string } = {};
      try {
        argObj = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        /* leave empty */
      }
      let result: string;
      if (fname === "run_bash") {
        const command = String(argObj.command ?? "").trim();
        if (!command) {
          result = "(run_bash called with empty command)";
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
        }
      } else {
        result = `(unknown tool: ${fname})`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: truncateToolOutput(result) } as ChatMessage & { tool_call_id?: string });
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
 * Spawn the openclaw CLI as the left brain, giving glm-5.2 (or whatever
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
  // Argus: keep the left hemisphere deterministic by calling Ollama directly
  // instead of spawning the OpenClaw CLI (which routes through the local
  // gateway before embedded fallback). The CLI path stays available behind
  // LEFT_USE_OPENCLAW_CLI=true.
  if (process.env.LEFT_USE_OPENCLAW_CLI !== "true") {
    // Tool-enabled agent loop (default). Gives the direct-Ollama left runtime a
    // real run_bash execution surface so glm-5.2 actually runs commands
    // instead of narrating them. LEFT_TOOLS=false reverts to plain chat.
    if (process.env.LEFT_TOOLS !== "false") {
      return runLeftToolLoop(prompt, opts ?? {});
    }

    // Legacy plain chat-completion path — no tools, narrate-only.
    const start = performance.now();
    const timeoutMs = opts?.timeoutMs ?? DEFAULTS.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const baseUrl = process.env.LEFT_OLLAMA_URL ?? "http://127.0.0.1:11434/v1/chat/completions";
      const model = process.env.LEFT_MODEL ?? "glm-5.2";
      // Optional bearer auth — required when LEFT_OLLAMA_URL points at
      // Ollama Cloud (https://ollama.com/v1). SECURITY: never fall back to
      // OPENCLAW_GATEWAY_TOKEN — on Argus that is the real local gateway
      // token. Empty => no header (local Ollama needs none).
      const apiKey = process.env.LEFT_API_KEY ?? "";
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are Argus's LEFT hemisphere: rigorous, structured, practical, and concise. No thinking tags." },
            { role: "user", content: prompt },
          ],
          stream: false,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
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
  // overflows the left model's context window after 3-4 messages — the model
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
