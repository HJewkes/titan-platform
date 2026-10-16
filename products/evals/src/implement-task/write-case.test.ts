import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPolicy, type ExclusionPolicy } from "../private/exclusion.js";
import { treeDigest } from "../review-pr/build-cases.js";
import { localCloneGit } from "../review-pr/bundle.js";
import { EvalCaseSchema, UnitSpecSchema } from "../spec/index.js";
import { buildMergedPr, git, type MergedPr } from "./test-fixture.js";
import { IMPLEMENT_TASK_UNIT, writeImplementTaskCases, type ImplementTaskSource } from "./write-case.js";

const UNIT_PATH = fileURLToPath(new URL("../../units/implement-task/unit.json", import.meta.url));
const PRIVATE_SLUG = "household-ledger";

let root: string;
let clone: string;
let out: string;
let policy: ExclusionPolicy;

function setUp(extra: Record<string, string> = {}): MergedPr {
  mkdirSync(clone);
  return buildMergedPr(clone, extra);
}

function sourceOf(pr: MergedPr, overrides: Partial<ImplementTaskSource> = {}): ImplementTaskSource {
  return { repo: "owner/titan-platform", pr: 42, baseSha: pr.base, mergeSha: pr.merge, brief: "Add x.", taskInitiative: "titan-platform", cls: "local-fix", ...overrides };
}

const write = (sources: ImplementTaskSource[]) => writeImplementTaskCases(sources, { outDir: out, policy, gitFor: () => localCloneGit(clone), seed: "test" });
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "implement-write-"));
  clone = join(root, "clone");
  out = join(root, "out");
  const activeWorkRoot = join(root, "active-work");
  mkdirSync(join(activeWorkRoot, PRIVATE_SLUG, "tasks"), { recursive: true });
  writeFileSync(join(activeWorkRoot, PRIVATE_SLUG, "brief.md"), "# private\n");
  writeFileSync(join(activeWorkRoot, PRIVATE_SLUG, "tasks", "HL-7.yml"), "id: HL-7\n");
  policy = defaultPolicy(activeWorkRoot);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("implement-task unit", () => {
  it("validates as a titan.unit/v1 matching the unit the writer stamps", () => {
    const unit = UnitSpecSchema.parse(JSON.parse(readFileSync(UNIT_PATH, "utf8")));

    expect({ id: unit.id, version: unit.version }).toEqual(IMPLEMENT_TASK_UNIT);
    expect(unit.objective.primary.name).toBe("hidden-test-pass-rate");
  });
});

describe("implement-task case writer", () => {
  it("lists the tests the accepted diff added as hidden tests with their source PR, and carried files apart", async () => {
    const pr = setUp();

    const { cases } = await write([sourceOf(pr)]);

    const written = EvalCaseSchema.parse(JSON.parse(readFileSync(join(out, "cases", `${cases[0]?.id}.json`), "utf8")));
    expect(written.expected).toEqual({
      hiddenTests: [{ path: "src/x.test.ts", sha256: sha256("it('x', () => {});\n"), sourcePr: 42, sourceSha: pr.merge }],
      support: [{ path: "src/fixtures/x.json", sha256: sha256('{"x": 2}\n'), sourcePr: 42, sourceSha: pr.merge }],
      overlayRemovals: [],
    });
    expect(written.input).toEqual({ repo: "owner/titan-platform", pr: 42, base: pr.base, brief: "Add x." });
    expect(written.tags).toEqual(["implement-task", "local-fix"]);
    expect(written.provenance).toEqual({ source: "history", ref: `owner/titan-platform#42@${pr.merge}`, labelVersion: 3 });
    expect(written.visibility).toBe("private");
  });

  it("writes the base tree as the fixture and the hidden files beside it, never inside it", async () => {
    const pr = setUp();

    const [written] = (await write([sourceOf(pr)])).cases;

    const id = written?.id ?? "";
    expect(written?.fixture).toEqual({ kind: "tree", path: `trees/${id}`, treeSha256: treeDigest(join(out, "trees", id)) });
    expect(existsSync(join(out, "trees", id, "src/x.test.ts"))).toBe(false);
    expect(existsSync(join(out, "trees", id, ".git"))).toBe(false);
    expect(readFileSync(join(out, "hidden", id, "src/x.test.ts"), "utf8")).toBe("it('x', () => {});\n");
    expect(readFileSync(join(out, "hidden", id, "src/fixtures/x.json"), "utf8")).toBe('{"x": 2}\n');
  });

  it("excludes and counts a source whose brief cites a private initiative, before writing anything for it", async () => {
    const pr = setUp();

    const result = await write([sourceOf(pr, { brief: `Budget per active-work/${PRIVATE_SLUG}/brief.md` })]);

    expect(result.cases).toEqual([]);
    expect(result.excluded).toEqual({ "private-marker": 1 });
    expect(existsSync(out)).toBe(false);
  });

  it("refuses the whole write when a hidden test path carries a private task id", async () => {
    const pr = setUp({ "src/HL-7.test.ts": "it('hl', () => {});\n" });

    const writing = write([sourceOf(pr)]);

    await expect(writing).rejects.toThrow(/private case refused \(private-marker\)/);
    expect(existsSync(join(out, "cases"))).toBe(false);
  });

  it("refuses an out dir inside a git work tree", async () => {
    const pr = setUp();
    out = join(clone, "out");

    await expect(write([sourceOf(pr)])).rejects.toThrow(/inside a git work tree/);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });
});
