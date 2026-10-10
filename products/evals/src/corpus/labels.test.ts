import { describe, expect, it } from "vitest";
import { deriveLabel, type LabelInput, type RawLabels } from "./labels.js";

const NOW = new Date("2026-03-01T00:00:00Z");
const NONE: RawLabels = { revert: false, "main-red": false, "later-fix": false, "owner-override": false, "fixer-changed-cited-paths": null };
const input = (overrides: Partial<LabelInput> & { labels?: Partial<RawLabels> }): LabelInput => ({
  verdict: "MERGE",
  verdictAt: "2026-01-01T00:00:00Z",
  now: NOW,
  merged: true,
  overrideReason: null,
  ...overrides,
  labels: { ...NONE, ...overrides.labels },
});

describe("deriveLabel", () => {
  it("holds a label pending until the verdict is 14 days old", () => {
    expect(deriveLabel(input({ verdictAt: "2026-02-16T00:00:01Z" }))).toBe("pending");
    expect(deriveLabel(input({ verdictAt: "2026-02-15T00:00:00Z" }))).toBe("clean");
  });

  it("never reads missing git evidence on a merged MERGE as clean", () => {
    expect(deriveLabel(input({ labels: { revert: null, "later-fix": null } }))).toBe("unresolved");
  });

  it("still calls a MERGE escaped when one outcome is known bad and another unknown", () => {
    expect(deriveLabel(input({ labels: { revert: null, "main-red": true } }))).toBe("escaped");
  });

  it("leaves a FIX_FIRST with no later head or no cited path unresolved", () => {
    expect(deriveLabel(input({ verdict: "FIX_FIRST", merged: false }))).toBe("unresolved");
  });

  it("calls a MERGE the owner abandoned with a reason escaped", () => {
    expect(deriveLabel(input({ labels: { "owner-override": true }, overrideReason: "broke the build locally" }))).toBe("escaped");
  });

  it("holds an override whose reason is blank pending", () => {
    expect(deriveLabel(input({ verdict: "FIX_FIRST", labels: { "owner-override": true }, overrideReason: "  " }))).toBe("pending");
  });
});
