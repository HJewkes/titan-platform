import { describe, expect, it } from "vitest";
import { parseTimingArtifact, timingArtifactSchema } from "./artifact.js";
import { timingArtifact, timingRun } from "./fixtures.test-helpers.js";

describe("timing artifact schema", () => {
  it("accepts a reporter's record in both modes", () => {
    const artifact = timingArtifact();

    expect(timingArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(parseTimingArtifact(artifact)).toEqual(artifact);
  });

  it("rejects an unknown run key on write and keeps it on read", () => {
    const newer = { ...timingArtifact(), run: { ...timingRun(), gpu: "none" } };

    expect(() => timingArtifactSchema.parse(newer)).toThrow(/gpu/);
    expect(parseTimingArtifact(newer).run).toMatchObject({ gpu: "none" });
  });

  it("rejects a record of another schema version", () => {
    expect(() => parseTimingArtifact({ ...timingArtifact(), schema: "titan.test-timing/v2" })).toThrow();
  });

  it("rejects a malformed shard", () => {
    expect(() => parseTimingArtifact(timingArtifact({ shard: "2 of 4" }))).toThrow(/shard/);
  });
});
