import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXED, makeRepo, REAL_TEST, removeRepos } from "./repo.test-helpers.js";
import { execSide } from "./side.js";
import { decodeReport } from "./transport.js";

const outs: string[] = [];

function outDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-proof-side-"));
  outs.push(dir);
  return dir;
}

afterEach(() => {
  removeRepos();
  outs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("execSide", { timeout: 120_000 }, () => {
  it("base side runs install and build before any head file exists in the tree", async () => {
    const listing = outDir();
    const repo = makeRepo({ build: `find . -path ./.git -prune -o -type f -print > ${listing}/tree.txt` });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST, "src/test-support/three.ts": "export const three = 3;\n" });

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out: outDir() });

    const files = fs.readFileSync(path.join(listing, "tree.txt"), "utf-8");
    expect(files).toContain("./src/math.ts");
    expect(files).not.toContain("math.test.ts");
    expect(files).not.toContain("test-support");
  });

  it("base side writes two reports with repo-relative file names", async () => {
    const repo = makeRepo();
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "base", out });

    expect(fs.readdirSync(out).sort()).toEqual(["base-rerun.report", "base.report"]);
    const decoded = decodeReport(fs.readFileSync(path.join(out, "base.report"), "utf-8"));
    expect(decoded.ok && decoded.report.testResults).toMatchObject([{ name: "src/math.test.ts", status: "failed" }]);
  });

  it("a failed head build writes an error marker instead of throwing", async () => {
    const repo = makeRepo({ build: "exit 3" });
    const head = repo.commit({ "src/math.ts": FIXED, "src/math.test.ts": REAL_TEST });
    const out = outDir();

    await execSide({ repo: repo.dir, base: repo.base, head, side: "head", out });

    expect(decodeReport(fs.readFileSync(path.join(out, "head.report"), "utf-8"))).toEqual({
      ok: false,
      error: "head: build failed (exit 3)",
      reported: true,
    });
  });
});
