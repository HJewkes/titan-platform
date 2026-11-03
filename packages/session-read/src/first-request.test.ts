import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFirstRequest } from "./first-request.js";

const row = (value: unknown): string => JSON.stringify(value);

const SHAPE = {
  system: [
    { type: "text", text: "harness" },
    { type: "text", text: "global rules" },
    { type: "text", text: "profile rules" },
  ],
  tools: [{ name: "Bash", input_schema: { type: "object", description: "run", properties: {} }, description: "shell" }],
};

function transcript(): string {
  const usage = {
    input_tokens: 10,
    cache_creation_input_tokens: 300,
    cache_read_input_tokens: 700,
    output_tokens: 5,
    cache_creation: { ephemeral_1h_input_tokens: 250, ephemeral_5m_input_tokens: 50 },
  };
  // Blob rows are written in the reverse of the request's tail order on purpose.
  return [
    row({ type: "agent-name", agentName: "agent-one", sessionId: "s1" }),
    row({ type: "api-request-shape", sessionId: "s1", shapeHash: "shape-a", shape: SHAPE }),
    row({ type: "api-request-blob", sessionId: "s1", hash: "blob-env", message: { role: "user", content: [{ type: "text", text: "env" }] } }),
    row({ type: "api-request-blob", sessionId: "s1", hash: "blob-brief", message: { role: "user", content: [{ type: "text", text: "claude-md" }, { type: "text", text: "brief" }] } }),
    row({
      type: "api-request",
      sessionId: "s1",
      id: "req-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      shapeHash: "shape-a",
      params: { model: "model-x" },
      tail: ["blob-brief", "blob-env"],
      cacheControl: [
        { path: ["system", 1], value: { type: "ephemeral", ttl: "1h", scope: "global" } },
        { path: ["messages", 1, "content", 0], value: { type: "ephemeral", ttl: "1h" } },
      ],
    }),
    row({ type: "assistant", requestRef: "req-0", message: { model: "model-x", usage: { input_tokens: 99 } } }),
    row({ type: "assistant", requestRef: "req-1", message: { model: "model-x", usage } }),
    row({ type: "api-request", id: "req-2", tail: [], params: { model: "later" } }),
  ].join("\n");
}

describe("readFirstRequest", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "first-request-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = (body: string) => {
    const file = path.join(dir, "t.jsonl");
    writeFileSync(file, body);
    return readFirstRequest(file);
  };

  it("returns tools, system and messages in API order with messages in tail order", async () => {
    const first = await read(transcript());

    expect(first?.blocks.map((b) => [b.path, b.text])).toEqual([
      ["tools", JSON.stringify([{ description: "shell", input_schema: { description: "run", properties: {}, type: "object" }, name: "Bash" }])],
      ["system[0]", "harness"],
      ["system[1]", "global rules"],
      ["system[2]", "profile rules"],
      ["messages[0][0]", "claude-md"],
      ["messages[0][1]", "brief"],
      ["messages[1][0]", "env"],
    ]);
  });

  it("reports agent name, model, breakpoints and the usage of the first request's response", async () => {
    const first = await read(transcript());

    expect(first).toMatchObject({
      sessionId: "s1",
      agentName: "agent-one",
      model: "model-x",
      cacheControl: [
        { path: "system[1]", ttl: "1h", scope: "global" },
        { path: "messages[1].content[0]", ttl: "1h", scope: null },
      ],
      usage: { inputTokens: 10, cacheReadTokens: 700, cacheCreationTokens: 300, cacheCreation1hTokens: 250, cacheCreation5mTokens: 50, outputTokens: 5 },
    });
  });

  it("gives null usage when the transcript ends before a response and null when there is no request", async () => {
    const noResponse = transcript().split("\n").filter((l) => !l.includes('"assistant"')).join("\n");

    expect((await read(noResponse))?.usage).toBeNull();
    expect(await read(row({ type: "agent-name", agentName: "x" }))).toBeNull();
  });
});
