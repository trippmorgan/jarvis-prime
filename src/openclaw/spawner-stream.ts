import { spawnOpenclawAgent, type OpenclawSpawnOptions } from "./spawner.js";
import type { SpawnResult } from "../claude/types.js";
import type { StreamEvent } from "../claude/stream-formatter.js";

export interface OpenclawStreamSpawnCallbacks {
  /** Called when (synthesized) stream events occur. Throws are swallowed. */
  onEvent?: (event: StreamEvent) => void;
}

/**
 * Streaming variant of spawnOpenclawAgent. The openclaw CLI doesn't currently
 * emit per-event JSONL like `claude --output-format stream-json`, so the
 * "stream" here is degenerate: we run the non-streaming spawner, and on
 * completion emit ONE synthesized assistant event carrying the final visible
 * text. Callers wired through LeftHemisphereClient still get a SpawnResult;
 * the evolving-message UX just won't see tool-by-tool progress mid-flight.
 *
 * If openclaw later grows a stream-json output mode, swap this implementation
 * out without touching LeftHemisphereClient.
 */
export async function spawnOpenclawAgentStream(
  prompt: string,
  opts: OpenclawSpawnOptions & OpenclawStreamSpawnCallbacks = {},
): Promise<SpawnResult> {
  const { onEvent, ...spawnOpts } = opts;
  // Pass onEvent INTO the spawner so the tool loop can emit per-command
  // `tool_use` events live (🔧 Bash: <cmd>) instead of only one final bubble.
  const result = await spawnOpenclawAgent(prompt, { ...spawnOpts, onEvent });

  if (onEvent && result.output) {
    try {
      onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: result.output }] },
      });
    } catch {
      // Swallow — UX callbacks must never break the spawn.
    }
  }

  return result;
}
