import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RealGit from "./history/git.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexPaths } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";
import { daysAgo, makeTestRepo, type TestRepo } from "./history/test-repo.js";

const squeeze = vi.hoisted(() => ({ maxBuffer: undefined as number | undefined }));

vi.mock("./history/git.js", async (importOriginal) => {
  const real = await importOriginal<typeof RealGit>();
  return {
    ...real,
    runGitLargeResult: (cwd: string, args: readonly string[], maxBuffer: number) =>
      real.runGitLargeResult(cwd, args, squeeze.maxBuffer ?? maxBuffer),
  };
});

let repo: TestRepo;
beforeAll(async () => {
  repo = await makeTestRepo();
  await repo.write("src/a.ts", "export const a = 1;\n");
  repo.commit("add a", { author: "ann", date: daysAgo(2) });
});
afterAll(async () => {
  await repo.cleanup();
});

describe("indexPaths history warnings", () => {
  let store: CodeGraphStore;
  let dir: string | undefined;

  beforeEach(() => {
    store = openCodeGraph(":memory:");
  });
  afterEach(async () => {
    squeeze.maxBuffer = undefined;
    store.close();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports a churn log overflow in IndexResult.warnings", async () => {
    squeeze.maxBuffer = 8;
    const result = await indexPaths(store, { paths: [repo.dir], ref: "head" });
    expect(result.warnings?.join()).toContain("churn log overflow");
  });

  it("omits warnings when history loads", async () => {
    const result = await indexPaths(store, { paths: [repo.dir], ref: "head" });
    expect(result.warnings).toBeUndefined();
  });

  it("omits warnings outside a git checkout", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-nogit-"));
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
    const result = await indexPaths(store, { paths: [dir], ref: "wd" });
    expect(result.warnings).toBeUndefined();
  });
});
