import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBranchBase } from "./branch-base.js";

const fake = vi.hoisted(() => ({
  run: vi.fn<(_file: string, args: readonly string[], options: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>>(),
}));
vi.mock("node:child_process", () => {
  const execFile = () => undefined;
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: fake.run });
  return { execFile };
});
afterEach(() => vi.restoreAllMocks());
const output = (stdout: string) => ({ stdout, stderr: "" });

describe("one fetch budget across default candidates", () => {
  it("passes only the remaining budget after an earlier candidate fails", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const attempts: { ref: string; timeout: number | undefined }[] = [];
    fake.run.mockImplementation(async (_file, args, options) => {
      if (args[0] === "remote") return output("/synthetic/origin");
      if (args[0] === "symbolic-ref") throw new Error("no default tracking ref");
      if (args[0] === "fetch") {
        attempts.push({ ref: args.at(-1) ?? "", timeout: options.timeout });
        now += attempts.length === 1 ? 600 : 400;
        throw new Error("synthetic fetch failure");
      }
      return output("synthetic-head");
    });
    const base = await resolveBranchBase("/synthetic/remaining", 1000);
    expect(attempts).toEqual([
      { ref: "+refs/heads/main:refs/remotes/origin/main", timeout: 1000 },
      { ref: "+refs/heads/master:refs/remotes/origin/master", timeout: 400 },
    ]);
    expect(base).toMatchObject({ sha: "synthetic-head", ref: "HEAD" });
    expect(base.warning).toContain("origin/main or origin/master failed or timed out");
  });

  it("does not start a fetch when discovering candidates exhausts the budget", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetches: string[] = [];
    fake.run.mockImplementation(async (_file, args) => {
      if (args[0] === "remote") return output("/synthetic/origin");
      if (args[0] === "symbolic-ref") { now += 1000; throw new Error("no default tracking ref"); }
      if (args[0] === "fetch") { fetches.push(args.at(-1) ?? ""); throw new Error("synthetic fetch failure"); }
      return output("synthetic-head");
    });
    const base = await resolveBranchBase("/synthetic/expired", 1000);
    expect(fetches).toEqual([]);
    expect(base.ref).toBe("HEAD");
    expect(base.warning).toContain("failed or timed out");
  });
});
