import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CorpusRow } from "../corpus/index.js";
import { caseHash } from "../hash.js";
import { defaultPolicy } from "../private/exclusion.js";
import { EvalCaseSchema, SuiteSpecSchema, type EvalCase } from "../spec/index.js";
import { buildReviewPrCases, treeDigest, type BuildManifest } from "./build-cases.js";
import { localCloneGit, type BundleGit } from "./bundle.js";

const PRIVATE_SLUG = "household-ledger";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

const source = (name: string, op: string) => `export function ${name}(value: number, max: number): number {\n  if (value ${op} max) {\n    return max;\n  }\n  return value;\n}\n`;
const test = (name: string) => `import { ${name} } from "./${name}.js";\n\nit("caps", () => {\n  expect(${name}(9, 5)).toBe(5);\n});\n`;

interface Fixture {
  base: string;
  caught: string;
  fix: string;
  cleanEarly: string;
  cleanB: string;
  cleanC: string;
}

function buildClone(clone: string): Fixture {
  git(clone, "init", "-q", "-b", "main");
  const base = commit(clone, { "src/a.ts": "export const add = (a: number, b: number) => a + b;\n", "src/b.ts": "", "src/c.ts": "" }, "base");
  const branch = (name: string) => git(clone, "checkout", "-q", "-b", name, base);
  branch("pr1");
  const caught = commit(clone, { "src/a.ts": "export const add = (a: number, b: number) => a - b;\n" }, "pr1 head");
  const fix = commit(clone, { "src/a.ts": "export const add = (a: number, b: number) => a + b;\n" }, "pr1 fix");
  branch("pr2");
  const cleanEarly = commit(clone, { "src/b.ts": source("capB", ">=") }, "pr2 first head");
  const cleanB = commit(clone, { "src/b.ts": source("capB", ">"), "src/b.test.ts": test("capB") }, "pr2 final head");
  branch("pr3");
  const cleanC = commit(clone, { "src/c.ts": source("capC", ">"), "src/c.test.ts": test("capC") }, "pr3 head");
  return { base, caught, fix, cleanEarly, cleanB, cleanC };
}

/**
 * The clone is frozen once built and the builder asks only about full shas, so each answer is fixed; caching it
 * keeps a build from spawning the same git process once per control and once per test, which timed out under load.
 */
function memoGit(port: BundleGit): BundleGit {
  const answers = new Map<string, Promise<Buffer>>();
  return {
    git: (args) => {
      const key = args.join("\0");
      const answer = answers.get(key) ?? port.git(args);
      answers.set(key, answer);
      return answer;
    },
  };
}

function row(overrides: Partial<CorpusRow> & Pick<CorpusRow, "pr" | "head" | "label" | "verdict">): CorpusRow {
  return {
    repo: "owner/titan-platform", runId: `run-${overrides.pr}`, task: "titan-platform/TP-1", kind: "feature", policy: null, step: "await",
    verdictAt: "2026-09-01T00:00:00Z", reviewer: { profile: null, agentId: null, sessionId: null }, closer: null, locator: null, findings: null,
    citedPaths: [], class: null, touches: null, cost: null, latencyMs: null, mergeSha: null, nextHead: null,
    labels: { revert: false, "main-red": false, "later-fix": false, "owner-override": false, "fixer-changed-cited-paths": null }, overrideReason: null,
    ...overrides,
  };
}

function corpus(f: Fixture): CorpusRow[] {
  return [
    row({ pr: 1, head: f.caught, verdict: "FIX_FIRST", label: "caught", nextHead: f.fix, citedPaths: ["a.ts"], findings: "Blocking:\n1. src/a.ts:1 subtracts where it should add." }),
    row({ pr: 2, head: f.cleanEarly, verdict: "MERGE", label: "clean", verdictAt: "2026-09-01T00:00:00Z" }),
    row({ pr: 2, head: f.cleanB, verdict: "MERGE", label: "clean", verdictAt: "2026-09-02T00:00:00Z", mergeSha: f.cleanB }),
    row({ pr: 3, head: f.cleanC, verdict: "MERGE", label: "clean", mergeSha: f.cleanC }),
    row({ pr: 4, head: f.cleanC, verdict: "MERGE", label: "pending" }),
  ];
}

function privateRows(f: Fixture): CorpusRow[] {
  return [
    row({ repo: "owner/household-notes", pr: 9, head: f.cleanC, verdict: "MERGE", label: "clean" }),
    row({ pr: 10, head: f.caught, verdict: "FIX_FIRST", label: "caught", nextHead: f.fix, citedPaths: ["src/a.ts"], findings: `src/a.ts breaks the budget in active-work/${PRIVATE_SLUG}/brief.md` }),
  ];
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/** What the test reads of a planted control; the builder's own schema parse already checked the rest. */
const ControlShape = z.object({
  input: z.object({ head: z.string() }),
  fixture: z.object({ kind: z.literal("tree"), path: z.string(), treeSha256: z.string() }),
  expected: z.object({ defects: z.tuple([z.object({ path: z.string(), line: z.number() })]) }),
});

function readCases(out: string): EvalCase[] {
  return readdirSync(join(out, "cases")).map((file) => EvalCaseSchema.parse(readJson(join(out, "cases", file))));
}

describe("buildReviewPrCases", () => {
  let scratch: string;
  let clone: string;
  let activeWorkRoot: string;
  let fixture: Fixture;
  let cloneGit: BundleGit;
  let outs = 0;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "review-pr-cases-"));
    clone = join(scratch, "clone");
    mkdirSync(clone);
    fixture = buildClone(clone);
    cloneGit = memoGit(localCloneGit(clone));
    activeWorkRoot = join(scratch, "active-work");
    mkdirSync(join(activeWorkRoot, PRIVATE_SLUG), { recursive: true });
    writeFileSync(join(activeWorkRoot, PRIVATE_SLUG, "brief.md"), "# private\n");
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  async function build(rows: CorpusRow[]): Promise<{ out: string; manifest: BuildManifest }> {
    const out = join(scratch, `out-${outs++}`);
    const manifest = await buildReviewPrCases(rows, { outDir: out, policy: defaultPolicy(activeWorkRoot), gitFor: () => cloneGit, mainRef: fixture.base, seed: "test" });
    return { out, manifest };
  }

  it("maps caught rows to FIX_FIRST with the defect path, final clean heads to MERGE, skips pending, and plants 6 controls", async () => {
    const { out, manifest } = await build(corpus(fixture));

    const cases = readCases(out);
    const byTag = (tag: string) => cases.filter((evalCase) => evalCase.tags.includes(tag));
    expect(manifest.counts).toEqual({ defect: 1, clean: 2, control: 6 });
    expect(manifest.skipped).toEqual({ pending: 1, "superseded-clean": 1 });
    expect(byTag("defect")[0]?.expected).toEqual({ verdict: "FIX_FIRST", defects: [{ path: "src/a.ts", description: "1. src/a.ts:1 subtracts where it should add." }] });
    expect(byTag("defect")[0]?.input).toEqual({ repo: "owner/titan-platform", pr: 1, head: fixture.caught, base: fixture.base });
    expect(byTag("clean").map((evalCase) => evalCase.input)).toEqual(
      expect.arrayContaining([expect.objectContaining({ head: fixture.cleanB }), expect.objectContaining({ head: fixture.cleanC })]),
    );
    expect(byTag("clean").map((evalCase) => evalCase.expected)).toEqual([{ verdict: "MERGE", defects: [] }, { verdict: "MERGE", defects: [] }]);
    expect(byTag("control").map((evalCase) => evalCase.tags[2]).sort()).toEqual(["deleted-assertion", "deleted-assertion", "inverted-condition", "inverted-condition", "toothless-test", "toothless-test"]);
    expect(cases.every((evalCase) => evalCase.visibility === "private")).toBe(true);
  });

  it("writes a suite listing the sorted case hashes and each control as a planted tree with its gold path:line", async () => {
    const { out } = await build(corpus(fixture));

    const cases = readCases(out);
    const suite = SuiteSpecSchema.parse(readJson(join(out, "suite.json")));
    expect(suite.cases).toEqual(cases.map(caseHash).sort());
    expect(suite.checks.map((check) => check.id)).toContain("read-only");
    for (const evalCase of cases.filter((candidate) => candidate.tags.includes("control"))) {
      const control = ControlShape.parse(evalCase);
      const tree = join(out, control.fixture.path);
      const [gold] = control.expected.defects;
      const original = (await cloneGit.git(["show", `${control.input.head}:${gold.path}`])).toString("utf8").split("\n");
      expect(treeDigest(tree)).toBe(control.fixture.treeSha256);
      expect(existsSync(join(tree, "head", ".git"))).toBe(false);
      expect(readFileSync(join(tree, "head", gold.path), "utf8").split("\n")).not.toContain(original[gold.line - 1]);
      expect(readFileSync(join(tree, "diff.patch"), "utf8")).toContain(`+++ b/${gold.path}\n`);
    }
  });

  it("drops planted private cases before writing and counts them in manifest.excluded", async () => {
    const { out, manifest } = await build([...corpus(fixture), ...privateRows(fixture)]);

    expect(manifest.excluded).toEqual({ "private-repo": 1, "private-marker": 1 });
    expect(manifest.counts).toEqual({ defect: 1, clean: 2, control: 6 });
    const written = readdirSync(join(out, "cases")).map((file) => readFileSync(join(out, "cases", file), "utf8")).join("\n");
    expect(written).not.toContain(PRIVATE_SLUG);
    expect(written).not.toContain("household-notes");
  });
});
