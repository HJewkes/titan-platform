import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverCodexSources, type DiscoveredTranscript } from "@titan-design/session-read";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionGraph, type SessionGraph } from "./graph.js";
import { indexCodexSource } from "./normalized-index.js";
import { readIndexedText } from "./normalized-query.js";
import { refreshCorpus } from "./refresh.js";

const SPAWN_BRIEF = '# Orientation: active-work initiative "demo"\n\nInjected automatically by `agent_spawn`. Your coordinator did not write this section.\n\nBuild the briefword feature.';
const BOOTSTRAP = "SessionStart hook additional context: bootstrapword conventions apply.";
const REMINDER = "<system-reminder>\nreminderword applies here\n</system-reminder>";
const CHANNEL = '<channel source="agent-chat" from="peer" msg_id="m1">\nchannelword update\n</channel>';

const line = (fields: Record<string, unknown>) => ({ sessionId: "s1", cwd: "/scratch", timestamp: "2026-07-01T00:00:00Z", ...fields });
const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", uuid, message: { role: "user", content }, ...extra });
const LINES = [
  user("p1", SPAWN_BRIEF, { promptSource: "typed", origin: { kind: "human" } }),
  user("p2", BOOTSTRAP, { isMeta: true }),
  user("p3", [{ type: "text", text: `${REMINDER}\nplease rename the humanword module` }]),
  user("p4", CHANNEL, { isMeta: true, origin: { kind: "channel", server: "plugin:agent-chat:agent-chat" } }),
  user("p5", [{ type: "tool_result", tool_use_id: "t1", content: "toolechoword output" }, { type: "text", text: "and keep the secondword too" }]),
];

let dir: string;
let graph: SessionGraph;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-injected-"));
  graph = openSessionGraph(":memory:");
});
afterEach(() => {
  graph.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function indexClaudeFixture(): Promise<void> {
  const absolutePath = path.join(dir, "s1.jsonl");
  writeFileSync(absolutePath, LINES.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const transcript: DiscoveredTranscript = { projectDir: "p", absolutePath, displayPath: absolutePath, subagentId: null, account: null };
  await refreshCorpus(graph, [transcript]);
}

const promptHits = (word: string) => graph.spans.search(word).filter((s) => s.field === "prompt");

describe("indexing a Claude transcript with injected context", () => {
  it("keeps the spawn brief and the bootstrap block out of indexed prompt spans", async () => {
    await indexClaudeFixture();

    expect(promptHits("briefword")).toHaveLength(0);
    expect(promptHits("bootstrapword")).toHaveLength(0);
    expect(promptHits("humanword")).toHaveLength(1);
  });

  it("indexes the human's words around a reminder and reads them back without it", async () => {
    await indexClaudeFixture();

    const hit = promptHits("humanword")[0]!;

    expect(promptHits("reminderword")).toHaveLength(0);
    expect(await readIndexedText(graph, hit)).toBe("please rename the humanword module");
  });

  it("indexes no prompt span for a turn that is entirely injected", async () => {
    await indexClaudeFixture();

    const prompts = graph.db.prepare("SELECT count(*) AS n FROM search_span WHERE field = 'prompt'").get() as { n: number };

    expect(promptHits("channelword")).toHaveLength(0);
    expect(prompts.n).toBe(2);
  });

  it("keeps tool-result echoes out of a user turn's prompt text", async () => {
    await indexClaudeFixture();

    expect(promptHits("toolechoword")).toHaveLength(0);
    expect(promptHits("secondword")).toHaveLength(1);
  });

  it("still records every user line as a fact", async () => {
    await indexClaudeFixture();

    const facts = graph.db.prepare("SELECT count(*) AS n FROM fact").get() as { n: number };

    expect(facts.n).toBe(LINES.length);
  });
});

const codexLine = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-09-11T12:00:00Z", payload }) + "\n";
const codexUser = (text: string) => codexLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });

async function indexCodexFixture(): Promise<void> {
  mkdirSync(path.join(dir, "sessions"));
  const header = codexLine("session_meta", { id: "c1", session_id: "root", cwd: "/scratch", cli_version: "test" });
  writeFileSync(path.join(dir, "sessions", "rollout.jsonl"), header + codexUser(SPAWN_BRIEF) + codexUser(`${REMINDER}\nplease rename the humanword module`));
  const source = (await discoverCodexSources({ codexHome: dir, namespace: "host" }))[0]!;
  await indexCodexSource(graph, source);
}

describe("indexing a normalized session with injected context", () => {
  it("strips injected blocks from prompt spans and keeps every structural row", async () => {
    await indexCodexFixture();

    const messages = graph.db.prepare("SELECT count(*) AS n FROM normalized_event WHERE kind = 'message'").get() as { n: number };

    expect(promptHits("briefword")).toHaveLength(0);
    expect(promptHits("reminderword")).toHaveLength(0);
    expect(promptHits("humanword")).toHaveLength(1);
    expect(messages.n).toBe(2);
  });
});
