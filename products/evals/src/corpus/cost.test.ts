import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcriptCost } from "./cost.js";

const line = (value: unknown): string => JSON.stringify(value);

function assistant(id: string, usage: object): string {
  return line({
    type: "assistant",
    sessionId: "s1",
    uuid: `u-${id}`,
    timestamp: `2026-10-01T00:00:0${id === "a" ? 0 : id === "b" ? 1 : 2}.000Z`,
    message: { id: `msg-${id}`, role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: `reply ${id}` }], usage },
  });
}

describe("transcriptCost", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evals-cost-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prices 1h cache writes at the 1h rate and untagged writes at the 5m rate", async () => {
    const file = join(dir, "s1.jsonl");
    writeFileSync(file, [
      assistant("a", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      assistant("b", {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      }),
      assistant("c", { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }),
    ].join("\n") + "\n");

    const cost = await transcriptCost({ path: file, namespace: "test" }, "2026-10-01T00:00:00.000Z");

    // opus-5 per million: input 5, output 25, 5m write 6.25, 1h write 10 => 5 + 25 + (6.25 + 10) + 6.25
    expect(cost).toEqual({ usd: 52.5, inputTokens: 4_000_000, outputTokens: 1_000_000, priced: true });
  });
});
