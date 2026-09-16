import { describe, expect, it } from "vitest";
import { briefingSlug, type Spawn } from "./spawn-arm.js";

const ROOT = "/Users/x/Library/Application Support/active-work";

function spawn(overrides: Partial<Spawn> = {}): Spawn {
  return { name: "a", brief: "b", parentTranscript: "/t/p.jsonl", ...overrides };
}

describe("briefingSlug", () => {
  it("takes an explicit slug over anything the cwd says", () => {
    const resolved = briefingSlug(spawn({ briefing: "titan-platform", cwd: `${ROOT}/relay` }), ROOT);
    expect(resolved).toBe("titan-platform");
  });

  it("resolves auto to the first path segment under the active root", () => {
    expect(briefingSlug(spawn({ briefing: "auto", cwd: `${ROOT}/relay/sources` }), ROOT)).toBe("relay");
  });

  it("prefers the requester's directory over the target's, as resolveBriefing does", () => {
    const resolved = briefingSlug(
      spawn({ briefing: "auto", requesterCwd: `${ROOT}/titan-platform`, cwd: `${ROOT}/relay` }),
      ROOT,
    );
    expect(resolved).toBe("titan-platform");
  });

  it("falls through to the target when the requester is outside the root", () => {
    const resolved = briefingSlug(
      spawn({ briefing: "auto", requesterCwd: "/Users/x/projects/titan-platform", cwd: `${ROOT}/relay` }),
      ROOT,
    );
    expect(resolved).toBe("relay");
  });

  it("resolves an absent briefing the same way auto does", () => {
    expect(briefingSlug(spawn({ cwd: `${ROOT}/relay` }), ROOT)).toBe("relay");
  });

  it("gives up on a cwd outside the active root rather than inventing a slug", () => {
    expect(briefingSlug(spawn({ briefing: "auto", cwd: "/Users/x/projects/relay" }), ROOT)).toBeUndefined();
  });

  it("gives up on the active root itself, which names no initiative", () => {
    expect(briefingSlug(spawn({ briefing: "auto", cwd: ROOT }), ROOT)).toBeUndefined();
  });

  it("gives up when there is no cwd at all", () => {
    expect(briefingSlug(spawn({ briefing: "auto" }), ROOT)).toBeUndefined();
  });
});
