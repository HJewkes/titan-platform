import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditGate, auditRun, HOUR, step } from "../test-support/owner-gate-audit.js";
import { JudgeUnavailable, type AuditJudge } from "./audit-judge.js";
import { badByClass } from "./audit-render.js";
import { AuditExists, auditPath, buildAudit, writeAuditFile } from "./audit-write.js";

const W41 = Date.parse("2026-10-05T00:00:00Z");
const NOW = Date.parse("2026-10-20T00:00:00Z");

const gates = [
  auditGate({ id: "run-1/approve-merge:0", resolvedAt: W41 + 10 * HOUR }),
  auditGate({ id: "run-2/approve-merge:0", resolvedAt: W41 + 20 * HOUR, decision: "abandon" }),
];
const runs = [
  auditRun("run-1", { "sh-landed": step("sh-landed", W41 + 11 * HOUR, { mergeSha: "abc123" }), "sh-reverted": step("sh-reverted", W41 + 30 * HOUR) }),
  auditRun("run-2", {}),
];

const fakeJudge: AuditJudge = async ({ gateId }) => ({ stamp: "did-work", note: `looked at ${gateId}` });

describe("buildAudit", () => {
  it("renders one block per sampled gate with its judge note, and the bad outcome under its class", async () => {
    const { items, markdown } = await buildAudit({ week: "2026-W41", gates, runs, incidents: [], now: NOW, judge: fakeJudge });

    expect(items).toHaveLength(2);
    expect(markdown).toContain("# Owner gate audit 2026-W41");
    expect(markdown).toContain("owner-resolved gates in the week: 2; sampled: 2");
    expect(markdown).toContain("judge: did-work: looked at run-1/approve-merge:0");
    expect(markdown).toContain("judge: did-work: looked at run-2/approve-merge:0");
    expect(markdown).toContain("PR: https://github.com/HJewkes/titan-platform/pull/12");
    expect(markdown).toContain("- unclassed: revert");
    expect([...badByClass(items)]).toEqual([["unclassed", ["revert"]]]);
  });

  it("still renders every item's facts when the judge throws, naming the failure kind", async () => {
    const failing: AuditJudge = () => Promise.reject(new JudgeUnavailable("rate_limited", "out of quota"));

    const { markdown } = await buildAudit({ week: "2026-W41", gates, runs, incidents: [], now: NOW, judge: failing });

    expect(markdown.match(/judge unavailable: rate_limited/g)).toHaveLength(2);
    expect(markdown).toContain("BAD: revert");
  });

  it("never calls a decision clean while its 72 h window is open, or when incidents were not read", async () => {
    const open = await buildAudit({ week: "2026-W41", gates, runs, incidents: [], now: W41 + 24 * HOUR, judge: undefined });
    const unread = await buildAudit({ week: "2026-W41", gates: [gates[1]!], runs, incidents: undefined, now: NOW, judge: undefined });

    expect(open.markdown).not.toContain("clean");
    expect(open.markdown).toContain("window open until");
    expect(unread.markdown).not.toContain("clean");
    expect(unread.markdown).toContain("incidents unknown");
  });
});

describe("writeAuditFile", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "owner-gate-audit-"));
  });

  it("writes under the titan-platform sources of ACTIVE_ROOT, named by week", () => {
    const path = auditPath({ ACTIVE_ROOT: root }, "2026-W41");

    writeAuditFile(path, "# report\n");

    expect(path).toBe(join(root, "titan-platform", "sources", "owner-gate-audit-2026-W41.md"));
    expect(readFileSync(path, "utf8")).toBe("# report\n");
  });

  it("refuses to replace an existing report without force, leaving it and no temp file behind", () => {
    const path = auditPath({ ACTIVE_ROOT: root }, "2026-W41");
    writeAuditFile(path, "first\n");

    expect(() => writeAuditFile(path, "second\n")).toThrow(AuditExists);
    expect(readFileSync(path, "utf8")).toBe("first\n");
    expect(readdirSync(dirname(path))).toEqual(["owner-gate-audit-2026-W41.md"]);
  });

  it("replaces an existing report with force", () => {
    const path = auditPath({ ACTIVE_ROOT: root }, "2026-W41");
    writeAuditFile(path, "first\n");

    writeAuditFile(path, "second\n", { force: true });

    expect(readFileSync(path, "utf8")).toBe("second\n");
  });
});
