import { describe, expect, it } from "vitest";
import { resolveConfig } from "./resolve-stage.js";
import { RESOLVE_ROWS } from "./resolve-tables.js";
import { DEFAULT_JUDGE } from "./workflow/host.js";
import { stageSpec, type RunSettings } from "./workflow/stage-spec.js";

describe("resolve stage spec", () => {
  const settings: RunSettings = { scriptModel: "m", judge: DEFAULT_JUDGE, rounds: 1 };
  const spec = (artifacts: Record<string, string>) => stageSpec({ stage: "resolve", artifacts, settings, sample: 0, remainingUsd: 1, bridge: () => { throw new Error("no bridge"); } });

  it("keys on the script, on the doctrine, and on a code artifact only when the run has one", () => {
    const bare = spec({ script: "a".repeat(64), facts: "f".repeat(64) });
    const withCode = spec({ script: "a".repeat(64), code: "c".repeat(64) });

    expect(bare.inputs).toEqual({ script: "a".repeat(64) });
    expect(bare.config).toEqual(resolveConfig());
    expect(withCode.inputs).toEqual({ script: "a".repeat(64), code: "c".repeat(64) });
    expect(withCode.key).not.toBe(bare.key);
  });

  it("re-keys when a resolver row changes, so a cached resolve never outlives the table it was chosen by", () => {
    expect(resolveConfig(RESOLVE_ROWS.slice(1)).doctrine).not.toBe(resolveConfig().doctrine);
  });

  it("keys on the chapter links when the script stage wrote them, so a new companion re-resolves the cards", () => {
    const bare = spec({ script: "a".repeat(64) });
    const linked = spec({ script: "a".repeat(64), "chapter-links": "l".repeat(64) });

    expect(linked.inputs).toEqual({ script: "a".repeat(64), "chapter-links": "l".repeat(64) });
    expect(linked.key).not.toBe(bare.key);
  });

  it("fails before the stage starts when no script exists", () => {
    expect(() => spec({ code: "c".repeat(64) })).toThrow(`stage resolve needs artifact "script"`);
  });
});
