import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeGraphCallEdges } from "./call-edges.js";
import { gatherPr } from "./gather.js";
import { fakeGh, PR, VIEW } from "./pr-fakes.test-helpers.js";

/** The synthetic repo at the PR head the fake gh describes. */
const FILES: Record<string, string> = {
  "src/store.ts": "export function save(id: string): string {\n  return id;\n}\n",
  "src/cache.ts": "export function lookup(id: string): string | undefined {\n  return id === \"\" ? undefined : id;\n}\n",
  "src/api.ts":
    'import { save } from "./store.js";\nimport { lookup } from "./cache.js";\n' +
    "export function handle(id: string): string {\n  const hit = lookup(id);\n  return hit ?? save(id);\n}\n",
};

let root: string;
let head: string;

const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pr-call-edges-"));
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
  head = git("rev-parse", "HEAD");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("codeGraphCallEdges", () => {
  it("reads the calls of the head commit's tree", async () => {
    const edges = await codeGraphCallEdges(root, head);

    expect(edges).toEqual(expect.arrayContaining([
      { from: "src/api.ts#handle", to: "src/cache.ts#lookup", sites: 1 },
      { from: "src/api.ts#handle", to: "src/store.ts#save", sites: 1 },
    ]));
  });

  it("gives gatherPr the call across the two changed files and refuses a head the clone lacks", async () => {
    const ok = await gatherPr({ pr: PR, clonePath: root, gh: fakeGh({ ...VIEW, headRefOid: head }) });
    const missing = await gatherPr({ pr: PR, clonePath: root, gh: fakeGh({ ...VIEW, headRefOid: "c".repeat(40) }) });

    expect(ok.ok && ok.facts.filter((f) => f.kind === "call").map((f) => f.id)).toEqual(["call:src/api.ts#handle->src/cache.ts#lookup"]);
    expect(missing.diagnostics.map((d) => d.code)).toContain("E-CALLGRAPH");
  });
});
