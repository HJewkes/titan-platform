import type { SourceTextLocator } from "@titan-design/session-read";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { evidenceComment } from "./evidence-comment.js";
import type { EvidenceRecord } from "./merge-facts.js";
import type { VisualDelta } from "./visual-delta-read.js";

const H = "0123456789abcdef0123456789abcdef01234567";
const MERGE_BASE = "fedcba9876543210fedcba9876543210fedcba98";
const SHOT = "ui/visual/stories.spec.ts-snapshots/card--default-chromium-linux.png";

const record = (visualDelta?: VisualDelta): EvidenceRecord => ({
  runId: "run-1",
  repo: "octo/ui",
  pr: 7,
  head: H,
  baseRef: "main",
  testMergeSha: null,
  checkRuns: [{ name: "visual", id: 1, appId: 15368, conclusion: "success" }],
  verdictLocator: partialFake<SourceTextLocator>(),
  reviewer: { agentId: "agent-rv-1", sessionId: "session-rv-1" },
  decision: { outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV", version: 1 }, reason: `MRG-AU-RV holds at ${H}` },
  mergeableState: "clean",
  ...(visualDelta && { visualDelta }),
});

const delta = (mode: VisualDelta["policy"]["mode"], more: Partial<VisualDelta> = {}): VisualDelta => ({
  policy: { mode, maxChangedShare: 0.01, pixelTolerance: 0.1 },
  mergeBase: MERGE_BASE,
  snapshots: [{ path: SHOT, component: "card", status: "changed", share: 0.004 }],
  api: [],
  tokens: [],
  harness: [],
  ...more,
});

/** The comment's lines from the Visual diff headline up to the machine evidence. */
const visualSection = (body: string): string => body.slice(body.indexOf("**Visual diff**"), body.indexOf("<details><summary>Machine evidence"));

describe("the evidence comment's Visual diff section", () => {
  it("states the mode, threshold, pixel tolerance and merge base, then a row per snapshot and the sensitive paths", () => {
    const section = visualSection(evidenceComment(record(delta("on"))));

    expect(section.split("\n").filter((line) => line !== "")).toEqual([
      "**Visual diff** (on): threshold 1.0% of the content box, pixel tolerance 0.1, merge base `fedcba9`.",
      "| Component | Snapshot | Change | Over? |",
      "| --- | --- | --- | --- |",
      `| card | \`${SHOT}\` | 0.4% | no |`,
      "- Public API: none changed",
      "- Tokens: none changed",
      "- Visual harness: none changed",
    ]);
  });

  it("marks a share over the threshold, and a removed or unmeasured snapshot as failing closed", () => {
    const snapshots: VisualDelta["snapshots"] = [
      { path: "a/x--big-chromium-linux.png", component: "x", status: "changed", share: 0.2 },
      { path: "a/y--gone-chromium-linux.png", component: "y", status: "removed" },
      { path: "a/z--odd-chromium-linux.png", component: "z", status: "unmeasured", reason: "head: over 5 bytes" },
    ];

    const section = visualSection(evidenceComment(record(delta("on", { snapshots }))));

    expect(section).toContain("| x | `a/x--big-chromium-linux.png` | 20.0% | yes |");
    expect(section).toContain("| y | `a/y--gone-chromium-linux.png` | removed | fails closed |");
    expect(section).toContain("| z | `a/z--odd-chromium-linux.png` | unmeasured: head: over 5 bytes | fails closed |");
  });

  it("groups rows by component with the largest change first, and collapses more than five rows", () => {
    const shot = (component: string, share: number) => ({ path: `a/${component}--${share}-chromium-linux.png`, component, status: "changed" as const, share });
    const snapshots = [shot("b", 0.001), shot("a", 0.002), shot("b", 0.005), shot("a", 0.009), shot("c", 0), shot("c", 0.003)];

    const section = visualSection(evidenceComment(record(delta("on", { snapshots }))));

    expect(section).toContain("<details><summary>6 snapshots</summary>");
    expect(section.split("\n").filter((line) => line.startsWith("| ") && line.includes("`")).map((line) => line.split(" | ").slice(0, 3).join(" | "))).toEqual([
      "| a | `a/a--0.009-chromium-linux.png` | 0.9%",
      "|  | `a/a--0.002-chromium-linux.png` | 0.2%",
      "| b | `a/b--0.005-chromium-linux.png` | 0.5%",
      "|  | `a/b--0.001-chromium-linux.png` | 0.1%",
      "| c | `a/c--0.003-chromium-linux.png` | 0.3%",
      "|  | `a/c--0-chromium-linux.png` | 0.0%",
    ]);
  });

  it("names the public API, token and harness paths that changed, with what the record left out", () => {
    const section = visualSection(evidenceComment(record(delta("on", { api: ["ui/api/index.api.md"], tokens: ["ui/src/theme/config.ts"], harness: [], omitted: { tokens: 3 } }))));

    expect(section).toContain("- Public API: `ui/api/index.api.md`\n- Tokens: `ui/src/theme/config.ts`, and 3 more\n- Visual harness: none changed");
  });

  it("says in shadow what on would decide, clear or the gate's reason", () => {
    const clear = evidenceComment(record(delta("shadow")));
    const gate = evidenceComment(record(delta("shadow", { api: ["ui/api/index.api.md"] })));

    expect(clear).toContain(`Shadow: under "on" this head's visual delta would clear.`);
    expect(gate).toContain(`Shadow: under "on" this head's visual delta would gate: ui/api/index.api.md (public API).`);
    expect(evidenceComment(record(delta("on")))).not.toContain("Shadow:");
  });

  it("escapes a pipe a PR put in a snapshot path, so the row keeps four cells", () => {
    const snapshots: VisualDelta["snapshots"] = [{ path: "a/p|q--x-chromium-linux.png", component: "p|q", status: "added" }];

    const section = visualSection(evidenceComment(record(delta("on", { snapshots }))));

    expect(section).toContain("| p\\|q | `a/p\\|q--x-chromium-linux.png` | added | no |");
  });

  it("says a malformed delta reads as unmeasured, and shows nothing without one", () => {
    const malformed = partialFake<VisualDelta>({ policy: delta("on").policy, mergeBase: MERGE_BASE });

    expect(evidenceComment(record(malformed))).toContain("**Visual diff**: the recorded delta is malformed, so it reads as unmeasured.");
    expect(evidenceComment(record())).not.toContain("Visual diff");
  });
});
