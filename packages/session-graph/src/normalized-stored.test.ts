import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { conversationRef } from "@titan-design/agent-protocol";
import { discoverCodexSources } from "@titan-design/session-read";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionGraph } from "./graph.js";
import { indexCodexSource } from "./normalized-index.js";
import { normalizedUsage, readIndexedText } from "./normalized-query.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const line = (type: string, payload: unknown) => JSON.stringify({ type, timestamp: "2026-09-11T12:00:00Z", payload }) + "\n";
const usageLine = (responseId: string, input: number) =>
  line("token_usage_record", { response_id: responseId, usage: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 } });

async function indexedGraph(extra = "") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "titan-normalized-stored-"));
  directories.push(dir);
  mkdirSync(path.join(dir, "sessions"));
  writeFileSync(path.join(dir, "sessions", "rollout.jsonl"), [
    line("session_meta", { id: "stored-id", session_id: "root-tree", cwd: "/scratch", cli_version: "test" }),
    line("turn_context", { turn_id: "turn-1", model: "test-model", cwd: "/scratch" }),
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "storedword" }] }),
    extra,
  ].join(""));
  const source = (await discoverCodexSources({ codexHome: dir, namespace: "host" }))[0]!;
  const graph = openSessionGraph(":memory:");
  await indexCodexSource(graph, source);
  return { graph, ref: conversationRef(source.conversation), file: source.path };
}

describe("stored normalized columns", () => {
  it("malformed descriptor reads as no text", async () => {
    const { graph, file } = await indexedGraph();
    try {
      const hit = graph.spans.search("storedword")[0]!;
      graph.db.prepare("UPDATE normalized_source SET descriptor = ?").run(JSON.stringify({ path: file }));
      expect(await readIndexedText(graph, hit)).toBeNull();
      graph.db.prepare("UPDATE normalized_source SET descriptor = ?").run("not json");
      expect(await readIndexedText(graph, hit)).toBeNull();
    } finally { graph.db.close(); }
  });

  it("malformed locators read as no text", async () => {
    const { graph } = await indexedGraph();
    try {
      const hit = graph.spans.search("storedword")[0]!;
      graph.db.prepare("UPDATE normalized_span SET locators = ?").run(JSON.stringify([{ source: 1 }]));
      expect(await readIndexedText(graph, hit)).toBeNull();
      graph.db.prepare("UPDATE normalized_span SET locators = ?").run("not json");
      expect(await readIndexedText(graph, hit)).toBeNull();
    } finally { graph.db.close(); }
  });

  it("a bad usage row is skipped and the rest still sum", async () => {
    const { graph, ref } = await indexedGraph(usageLine("r1", 10) + usageLine("r2", 20));
    const warnings: string[] = [];
    try {
      graph.db.prepare("UPDATE normalized_event SET usage = ? WHERE json_extract(usage,'$.responseId') = 'r1'")
        .run(JSON.stringify({ kind: "delta", responseId: "r1" }));
      expect(normalizedUsage(graph, ref, { warn: line => warnings.push(line) })).toEqual([
        expect.objectContaining({ inputTokens: 20, requestCount: 1, basis: "delta" }),
      ]);
      expect(warnings).toEqual([expect.stringContaining(ref)]);
    } finally { graph.db.close(); }
  });

  it("unknown keys survive in a stored descriptor and still read the text", async () => {
    const { graph } = await indexedGraph();
    try {
      const hit = graph.spans.search("storedword")[0]!;
      graph.db.prepare("UPDATE normalized_source SET descriptor = json_set(descriptor, '$.futureKey', 'x')").run();
      expect(await readIndexedText(graph, hit)).toBe("storedword");
    } finally { graph.db.close(); }
  });
});
