import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { messagePredecessor } from "./wake-notice.js";

function row(name: string): AgentRow {
  const base = { name, agentId: `id-${name}`, state: "idle", presence: "idle", status: "running", profile: "implementer", surface: "headless", model: null };
  return { ...base, cwd: `/work/${name}`, sessionId: `s-${name}`, transcriptPath: `/transcripts/${name}.jsonl`, transcriptExists: true, spawnedBy: "demo-coord", account: null, generation: 1, teleportFrom: null };
}

const WAKE = {
  input: { repo: "octo/demo", pr: 7, headSha: fakeSha("head-1"), kind: "review" },
  pr: { headRef: "feat/demo" },
  implementer: "impl-a",
  successors: [],
  payload: "the parser drops the last field",
};

function lineageAgents(rows: AgentRow[]) {
  const sent: { name: string; text: string }[] = [];
  return { sent, roster: async () => rows, message: async (name: string, text: string) => void sent.push({ name, text }) };
}

describe("messagePredecessor: a held wake's findings reach the lineage", () => {
  it("messages the held wake's findings and branch to the lineage's newest agent", async () => {
    const agents = lineageAgents([row("impl-a"), row("impl-a-s1")]);

    const result = await messagePredecessor(agents, WAKE, "agent-chat refused the spawn", new AbortController().signal);

    expect(result).toEqual({ agent: "impl-a-s1", sent: true, detail: "told impl-a-s1" });
    expect(agents.sent).toHaveLength(1);
    expect(agents.sent[0]!.text).toContain("the parser drops the last field");
    expect(agents.sent[0]!.text).toContain("`feat/demo`");
  });

  it("records the failure class, not the message, when the send fails", async () => {
    const agents = { roster: async () => [], message: async () => Promise.reject(new TypeError("secret detail")) };

    const result = await messagePredecessor(agents, WAKE, "refused", new AbortController().signal);

    expect(result).toEqual({ agent: "impl-a", sent: false, detail: "the predecessor message failed: TypeError" });
  });
});
