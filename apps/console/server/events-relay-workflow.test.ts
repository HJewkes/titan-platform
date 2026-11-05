import { describe, expect, it } from "vitest";
import { factoryIds } from "./events-relay.js";

describe("factoryIds workflow", () => {
  it("keeps a known workflow beside the run id", () => {
    expect(factoryIds(JSON.stringify({ workflow: "autoresearch", runId: "r1", repo: "example-org/example-repo" }))).toEqual({ runId: "r1", workflow: "autoresearch" });
    expect(factoryIds(JSON.stringify({ workflow: "shepherd" }))).toEqual({ workflow: "shepherd" });
  });

  it("drops a workflow it does not know and a frame with none", () => {
    expect(factoryIds(JSON.stringify({ workflow: "other-flow", runId: "r1" }))).toEqual({ runId: "r1" });
    expect(factoryIds(JSON.stringify({ runId: "r1" }))).toEqual({ runId: "r1" });
  });
});
