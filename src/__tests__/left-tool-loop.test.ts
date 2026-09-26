import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the model endpoint the LEFT tool loop talks to; run_bash runs for real (harmless echo/ls).
const fetchMock = vi.fn();
vi.mock("../../../tools/gpu-scheduler.mjs", () => ({ scheduledFetchText: (...a: unknown[]) => fetchMock(...a) }));

import { spawnOpenclawAgent, claimsInability, isLocalCommand } from "../openclaw/spawner.js";

type Turn = { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
function script(turns: Turn[]) {
  let i = 0;
  fetchMock.mockImplementation(async () => {
    const t = turns[Math.min(i++, turns.length - 1)];
    return { ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { role: "assistant", ...t } }] }) };
  });
}
const sentMessages = (call: number): Array<{ role: string; content: string }> => JSON.parse((fetchMock.mock.calls[call][1] as { body: string }).body).messages;
const bash = (id: string, command: string) => ({ id, function: { name: "run_bash", arguments: JSON.stringify({ command }) } });

describe("LEFT tool loop — locality rule (2026-09-17)", () => {
  beforeEach(() => { fetchMock.mockReset(); delete process.env.FRANK_LEFT_USE_OPENCLAW_CLI; delete process.env.FRANK_LEFT_TOOLS; });

  it("classifies inability claims and local vs remote commands", () => {
    expect(claimsInability("I have no working route to the host, so I could not run it.")).toBe(true);
    expect(claimsInability("Unable to reach superserver from here.")).toBe(true);
    expect(claimsInability("The script isn't found on any host I can access.")).toBe(true);
    expect(claimsInability("All 12 checks passed; output below.")).toBe(false);
    expect(isLocalCommand("ls -la /home/frank/tools")).toBe(true);
    expect(isLocalCommand("ssh superserver 'ls /home/frank/tools'")).toBe(false);
    expect(isLocalCommand("sudo ssh argus uptime")).toBe(false);
    expect(isLocalCommand("systemctl status frank-brain")).toBe(true);
  });

  it("system prompt carries the locality + inability rules", async () => {
    script([{ content: "done" }]);
    await spawnOpenclawAgent("hi", { timeoutMs: 5000 });
    const sys = sentMessages(0)[0].content;
    expect(sys).toMatch(/LOCALITY: you run ON Voldemort/);
    expect(sys).toMatch(/NEVER say you cannot reach, access, find or run something unless a run_bash call/);
  });

  it("nudges an inability claim made without any local check, then accepts the grounded answer", async () => {
    script([
      { content: "I have no working route to the host, so I cannot run the brain review." },
      { content: "", tool_calls: [bash("c1", "echo 'brain-review.sh found locally'")] },
      { content: "Found it locally and ran it: brain-review.sh found locally." },
    ]);
    const r = await spawnOpenclawAgent("Rerun the brain review", { timeoutMs: 600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const nudge = sentMessages(1).at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toMatch(/ran no command on this host \(Voldemort\)/);
    expect(sentMessages(2).at(-1)!.role).toBe("tool");
    expect(r.output).toMatch(/Found it locally/);
    expect(r.exitCode).toBe(0);
  });

  it("still nudges when only remote (ssh) commands were tried", async () => {
    script([
      { content: "", tool_calls: [bash("c1", "ssh 127.0.0.1 -o ConnectTimeout=1 -o BatchMode=yes true 2>&1 | head -1")] },
      { content: "Couldn't reach the host; I cannot access the script." },
      { content: "", tool_calls: [bash("c2", "echo local-check")] },
      { content: "Local check done: local-check." },
    ]);
    const r = await spawnOpenclawAgent("run the thing", { timeoutMs: 600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sentMessages(2).at(-1)!.content).toMatch(/Check locally NOW/);
    expect(r.output).toMatch(/Local check done/);
  });

  it("does not nudge an inability claim that follows a real local check, and nudges at most once", async () => {
    script([
      { content: "", tool_calls: [bash("c1", "ls /definitely/not/here 2>&1 | head -1")] },
      { content: "Could not find /definitely/not/here — ls says no such file." },
    ]);
    const r = await spawnOpenclawAgent("look for it", { timeoutMs: 600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.output).toMatch(/Could not find/);

    fetchMock.mockReset();
    script([
      { content: "I have no route to the host." },
      { content: "Still no route, unable to reach it." },
    ]);
    const r2 = await spawnOpenclawAgent("x", { timeoutMs: 600_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);   // one nudge, then the answer is returned as-is
    expect(r2.output).toMatch(/Still no route/);
  });

  it("sends a wrap-up nudge when the time budget runs low, then takes the answer", async () => {
    script([
      { content: "", tool_calls: [bash("c1", "echo step1")] },
      { content: "", tool_calls: [bash("c2", "echo step2")] },   // would keep exploring
      { content: "Final: step1 and step2 seen." },
    ]);
    // 3 s budget → the 45 s floor means the wrap-up fires right after the first tool round.
    const r = await spawnOpenclawAgent("do it", { timeoutMs: 3_000 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const afterFirstTools = sentMessages(1);
    expect(afterFirstTools.at(-2)!.role).toBe("tool");
    expect(afterFirstTools.at(-1)!.content).toMatch(/Time budget nearly exhausted/);
    expect(sentMessages(2).filter((m) => /Time budget nearly exhausted/.test(m.content))).toHaveLength(1);  // sent once
    expect(r.output).toMatch(/Final: step1 and step2 seen/);
    expect(r.timedOut).toBe(false);
  });
});

