import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { TOOLCHAIN_CONSUMERS, adoptionPlan, dryRunLines, readCanonical, readConsumer, type CanonicalToolchain, type ConsumerFiles } from "./toolchain-fanout.js";

const CANONICAL: CanonicalToolchain = { nodeVersion: "24.21.0", packageManager: "pnpm@10.28.1", enginesNode: ">=24 <25" };

const SETUP_NODE_CI = `jobs:
  test:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: pnpm
`;

const MATRIX_AND_REUSABLE_CI = `jobs:
  std:
    uses: HJewkes/ci/.github/workflows/node.yml@v1
    with:
      node-version: '24.21.0'
  test:
    strategy:
      matrix:
        node-version: [22]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node-version }}
`;

function file(path: string, content: string) {
  return { path, content, blobSha: `blob-${path}` };
}

function pkg(fields: Record<string, unknown>): string {
  return `${JSON.stringify({ name: "consumer", ...fields }, null, 2)}\n`;
}

function consumer(overrides: Partial<ConsumerFiles> = {}): ConsumerFiles {
  return {
    repo: "HJewkes/codewatch",
    baseBranch: "main",
    nodeVersion: file(".node-version", "24.21.0\n"),
    packageJson: file("package.json", pkg({ packageManager: CANONICAL.packageManager, engines: { node: CANONICAL.enginesNode } })),
    workflows: [],
    ...overrides,
  };
}

function seed(fake: FakeGitHub, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) fake.files.set(`main:${path}`, { content, blobSha: `blob-${path}` });
}

describe("toolchain fanout consumers", () => {
  it("names the public product repos and the design system, each with workflow files to read", () => {
    expect(TOOLCHAIN_CONSUMERS.map((entry) => entry.repo)).toEqual(["HJewkes/active-work", "HJewkes/agent-chat", "HJewkes/codewatch", "HJewkes/titan-design"]);
    expect(TOOLCHAIN_CONSUMERS.every((entry) => entry.workflows.length > 0)).toBe(true);
  });
});

describe("reading toolchains over the GitHub port", () => {
  it("reads the canonical node version, packageManager and engines.node from the default branch", async () => {
    const fake = fakeGitHub();
    seed(fake, { ".node-version": "v24.21.0\n", "package.json": pkg({ packageManager: "pnpm@10.28.1", engines: { node: ">=24 <25" } }) });

    expect(await readCanonical(githubPort(fake.wire))).toEqual(CANONICAL);
  });

  it("refuses a canonical package.json without packageManager rather than fan out a blank one", async () => {
    const fake = fakeGitHub();
    seed(fake, { ".node-version": "24.21.0\n", "package.json": pkg({}) });

    await expect(readCanonical(githubPort(fake.wire))).rejects.toThrow(/packageManager/);
  });

  it("reads a consumer's files and skips a listed workflow that does not exist", async () => {
    const fake = fakeGitHub();
    seed(fake, { "package.json": pkg({}), ".github/workflows/ci.yml": SETUP_NODE_CI });

    const files = await readConsumer(githubPort(fake.wire), { repo: "HJewkes/codewatch", workflows: [".github/workflows/ci.yml", ".github/workflows/gone.yml"] });

    expect(files.nodeVersion).toBeNull();
    expect(files.workflows.map((workflow) => workflow.path)).toEqual([".github/workflows/ci.yml"]);
  });
});

describe("adoption plan", () => {
  it("aligns a drifted pnpm repo's .node-version, packageManager, engines.node and setup-node step", () => {
    const drifted = consumer({
      nodeVersion: file(".node-version", "22\n"),
      packageJson: file("package.json", pkg({ packageManager: "pnpm@9.15.0", engines: { node: ">=22" } })),
      workflows: [file(".github/workflows/ci.yml", SETUP_NODE_CI)],
    });

    const plan = adoptionPlan(CANONICAL, drifted)!;

    expect(plan.branch).toBe("toolchain/node-24.21.0-pnpm-10.28.1");
    const byPath = Object.fromEntries(plan.files.map((edit) => [edit.path, edit]));
    expect(byPath[".node-version"]).toEqual({ path: ".node-version", content: "24.21.0\n", expectedBlobSha: "blob-.node-version" });
    expect(JSON.parse(byPath["package.json"]!.content)).toMatchObject({ packageManager: "pnpm@10.28.1", engines: { node: ">=24 <25" } });
    expect(byPath[".github/workflows/ci.yml"]!.content).toContain("          node-version-file: .node-version\n          cache: pnpm");
    expect(byPath[".github/workflows/ci.yml"]!.content).not.toMatch(/node-version: /);
  });

  it("creates a missing .node-version", () => {
    const plan = adoptionPlan(CANONICAL, consumer({ nodeVersion: null }))!;

    expect(plan.files).toEqual([{ path: ".node-version", content: "24.21.0\n", expectedBlobSha: null }]);
  });

  it("gives an npm repo no packageManager but still aligns its engines.node", () => {
    const npmRepo = consumer({ packageJson: file("package.json", pkg({ engines: { node: ">=20" } })) });

    const edited = JSON.parse(adoptionPlan(CANONICAL, npmRepo)!.files[0]!.content) as Record<string, unknown>;

    expect(edited).not.toHaveProperty("packageManager");
    expect(edited.engines).toEqual({ node: ">=24 <25" });
  });

  it("leaves a matrix node-version and a reusable workflow's with: node-version unchanged and lists them", () => {
    const repo = consumer({ nodeVersion: file(".node-version", "22\n"), workflows: [file(".github/workflows/ci.yml", MATRIX_AND_REUSABLE_CI)] });

    const plan = adoptionPlan(CANONICAL, repo)!;

    expect(plan.files.map((edit) => edit.path)).toEqual([".node-version"]);
    expect(plan.leftAlone).toEqual([
      { path: ".github/workflows/ci.yml", line: 5, reason: "reusable-workflow" },
      { path: ".github/workflows/ci.yml", line: 9, reason: "matrix" },
      { path: ".github/workflows/ci.yml", line: 13, reason: "expression" },
    ]);
  });

  it("plans nothing for a repo that already matches", () => {
    const aligned = consumer({ workflows: [file(".github/workflows/ci.yml", SETUP_NODE_CI.replace("node-version: '22'", "node-version-file: .node-version"))] });

    expect(adoptionPlan(CANONICAL, aligned)).toBeNull();
  });
});

describe("dry-run lines", () => {
  it("prints one line per planned PR with its branch, files and what it left alone", () => {
    const codewatch = adoptionPlan(CANONICAL, consumer({ nodeVersion: null, workflows: [file(".github/workflows/ci.yml", MATRIX_AND_REUSABLE_CI)] }))!;
    const titanDesign = adoptionPlan(CANONICAL, consumer({ repo: "HJewkes/titan-design", workflows: [file(".github/workflows/ci.yml", SETUP_NODE_CI)] }))!;

    expect(dryRunLines([codewatch, titanDesign])).toEqual([
      "HJewkes/codewatch: open toolchain/node-24.21.0-pnpm-10.28.1 into main [.node-version]; left alone: .github/workflows/ci.yml:5 (reusable-workflow), .github/workflows/ci.yml:9 (matrix), .github/workflows/ci.yml:13 (expression)",
      "HJewkes/titan-design: open toolchain/node-24.21.0-pnpm-10.28.1 into main [.github/workflows/ci.yml]",
    ]);
  });
});
