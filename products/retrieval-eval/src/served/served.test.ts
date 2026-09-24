import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBootstrapBlock, parseSpawnBlock } from "./blocks.js";
import { isCited, isOpened, unservedBaseRate } from "./labels.js";
import { buildReport } from "./report.js";
import type { ServedBlock } from "./session.js";
import { readServedSession } from "./session.js";

const BOOTSTRAP_TURN = [
  "# Open loops (2 hanging)",
  "- [3d] Ship the audit plan.",
  '    see: source:codewatch/codewatch-audit-plan.md "Codewatch audit plan"',
  '    see: task:CW-12 "Audit runners"',
  "- [1d] Reconcile the archive.",
  '    see: [from `health`] note:health/2026-09-01-a-claim.md "A claim"',
  '    see: source:codewatch/codewatch-audit-plan.md "Codewatch audit plan"',
].join("\n");

const SPAWN_TURN = [
  "## Related to this assignment (2, ranked; open with Read)",
  "",
  '- source:titan-platform/design.md "Design"',
  '- note:titan-platform/2026-09-23-sections.md "Sections"',
  "",
  "## Done when",
  "- note:titan-platform/not-served.md is only mentioned in the brief",
].join("\n");

function block(overrides: Partial<ServedBlock>): ServedBlock {
  return { trigger: "bootstrap", refs: [], toolInputs: [], assistantText: [], ...overrides };
}

describe("served blocks", () => {
  it("a served block is parsed into one query per rendered ref", () => {
    const bootstrap = parseBootstrapBlock(BOOTSTRAP_TURN);
    const spawn = parseSpawnBlock(SPAWN_TURN);

    expect(bootstrap.map((ref) => ref.ref)).toEqual([
      "source:codewatch/codewatch-audit-plan.md",
      "task:CW-12",
      "note:health/2026-09-01-a-claim.md",
    ]);
    expect(bootstrap[2]).toMatchObject({ initiative: "health", key: "2026-09-01-a-claim.md", foreign: true });
    expect(bootstrap[1]).toMatchObject({ refClass: "task", key: "CW-12" });
    expect(bootstrap[1]!.initiative).toBeUndefined();
    expect(spawn.map((ref) => ref.ref)).toEqual([
      "source:titan-platform/design.md",
      "note:titan-platform/2026-09-23-sections.md",
    ]);
    expect(spawn.every((ref) => ref.trigger === "spawn" && !ref.foreign)).toBe(true);
  });

  it("finds no block in a turn that renders neither", () => {
    expect(parseBootstrapBlock("see: note:x/y.md without the loop indent")).toEqual([]);
    expect(parseSpawnBlock("- note:x/y.md with no heading")).toEqual([]);
  });
});

describe("served transcripts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "served-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function transcript(records: object[]): string {
    const file = path.join(dir, "0000.jsonl");
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n"));
    return file;
  }

  const toolUse = (timestamp: string, input: object) => ({
    type: "assistant",
    timestamp,
    message: { content: [{ type: "tool_use", name: "Read", input }] },
  });

  it("a ref counts as opened when its filename appears in a later tool input", async () => {
    const file = transcript([
      toolUse("2026-09-20T09:00:00Z", { file_path: "/root/health/sources/notes/2026-09-01-a-claim.md" }),
      { type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: BOOTSTRAP_TURN } },
      toolUse("2026-09-20T10:01:00Z", { file_path: "/root/codewatch/sources/codewatch-audit-plan.md" }),
    ]);

    const session = await readServedSession(file);
    const served = session!.blocks[0]!;

    expect(served.trigger).toBe("bootstrap");
    expect(isOpened(served.refs[0]!, served)).toBe(true);
    expect(isOpened(served.refs[2]!, served)).toBe(false);
  });

  it("ignores activity at or after the window's end", async () => {
    const file = transcript([
      { type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: SPAWN_TURN } },
      toolUse("2026-09-24T00:00:00Z", { command: "cat design.md" }),
    ]);

    const served = (await readServedSession(file, { until: "2026-09-23T18:50:00Z" }))!.blocks[0]!;

    expect(isOpened(served.refs[0]!, served)).toBe(false);
    expect(await readServedSession(file, { until: "2026-09-20T10:00:00Z" })).toBeUndefined();
  });
});

describe("served labels", () => {
  it("the unserved base rate covers same-class files not in the block", () => {
    const refs = parseBootstrapBlock(BOOTSTRAP_TURN);
    const corpus: Record<string, string[]> = {
      "codewatch/source": ["codewatch-audit-plan.md", "handoff-archive.md", "roadmap.md"],
      "codewatch/note": [],
      "health/source": ["labs.md"],
      "health/note": ["2026-09-01-a-claim.md", "2026-09-02-other.md"],
    };
    const served = block({ refs, toolInputs: ['{"command":"cat roadmap.md"}'] });

    const counts = unservedBaseRate(served, (initiative, refClass) => corpus[`${initiative}/${refClass}`] ?? []);

    expect(counts).toEqual([
      { initiative: "codewatch", refClass: "source", unserved: 2, opened: 1 },
      { initiative: "codewatch", refClass: "note", unserved: 0, opened: 0 },
      { initiative: "health", refClass: "source", unserved: 1, opened: 0 },
      { initiative: "health", refClass: "note", unserved: 1, opened: 0 },
    ]);
  });

  it("a ref named in prose or in the wrap record counts as cited without being opened", () => {
    const [plan, task, note] = parseBootstrapBlock(BOOTSTRAP_TURN);
    const served = block({ refs: [plan!, task!, note!], assistantText: ["Per codewatch-audit-plan.md, ..."] });

    expect(isCited(plan!, served)).toBe(true);
    expect(isCited(task!, served, "closed: CW-12")).toBe(true);
    expect(isCited(note!, served, "closed: CW-12")).toBe(false);
  });

  it("reports opened-section as unavailable rather than as zero", () => {
    const report = buildReport(
      { observations: [], baseRates: [], transcriptsServed: { bootstrap: 0, spawn: 0 }, blockSpan: {} },
      {},
      0,
    );

    expect(report.openedSection).toMatch(/^n\/a: .*B4/);
  });
});
