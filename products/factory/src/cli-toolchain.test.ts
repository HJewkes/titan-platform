import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "./cli.js";
import { shepherdFixture } from "./test-support/shepherd.js";
import { ADOPTION_BRANCH, DRIFTED, toolchainWorld } from "./test-support/toolchain.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "toolchain-cli-"));
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), env: { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir } };
  return { out, err, io, db: join(dir, "factory.db") };
}

function depsOver(port: GitHubPort): CliDeps {
  const fixture = shepherdFixture({ frozen: true, port });
  return { workflows: fixture.workflows, routes: () => fixture.routes };
}

const refuse = (method: string) => async (): Promise<never> => Promise.reject(new Error(`dry run called ${method}`));

describe("toolchain fanout verb", () => {
  it("lists the PR the dry run would open and makes no write on any repo", async () => {
    const world = toolchainWorld();
    const readOnly: GitHubPort = { ...world.port, ensureBranch: refuse("ensureBranch"), putFile: refuse("putFile"), openPr: refuse("openPr") };
    const { out, err, io, db } = capture();

    const code = await runCli(["--db", db, "toolchain", "fanout", "--dry-run"], io, depsOver(readOnly));

    expect({ code, err: err.join("") }).toEqual({ code: 0, err: "" });
    expect(out.join("")).toBe(`${DRIFTED}: open ${ADOPTION_BRANCH} into main [.node-version, package.json, .github/workflows/ci.yml]\n`);
    for (const fake of world.fakes.values()) expect(fake.effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
  });

  it("opens and registers the PR without --dry-run", async () => {
    const world = toolchainWorld();
    const { out, io, db } = capture();

    const code = await runCli(["--db", db, "toolchain", "fanout"], io, depsOver(world.port));

    expect(code).toBe(0);
    expect(out.join("")).toMatch(new RegExp(`^${DRIFTED}: opened PR #1, shepherd run \\S+\\n$`));
    expect(world.fakes.get(DRIFTED)!.effects.createPr).toBe(1);
  });
});
