import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import type { CliDeps } from "./cli-types.js";
import { EXIT } from "./exit-codes.js";
import { fakeSha } from "@titan-design/github";
import { bumpBranch } from "./shepherd/consumer-bump.js";
import { CONSUMER_A, CONSUMER_B, CONSUMER_SEATS, consumerBumpWorld, type ConsumerBumpWorld } from "./test-support/consumer-bump.js";
import { shepherdFixture } from "./test-support/shepherd.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "release-cli-"));
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), env: { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir } };
  return { out, err, io, db: join(dir, "factory.db") };
}

function depsOver(world: ConsumerBumpWorld, port: GitHubPort = world.port): CliDeps {
  const fixture = shepherdFixture({ frozen: true, port, seats: CONSUMER_SEATS });
  return { workflows: fixture.workflows, routes: () => fixture.routes, consumerBump: { registry: world.registry, regen: world.regen } };
}

const refuse = (method: string) => async (): Promise<never> => Promise.reject(new Error(`dry run called ${method}`));
const branchA = bumpBranch([
  { name: "@titan-design/example-a", version: "1.4.0" },
  { name: "@titan-design/example-b", version: "0.10.0" },
]);
const branchB = bumpBranch([{ name: "@titan-design/example-b", version: "0.10.0" }]);

async function bumpCode(world: ConsumerBumpWorld, ...flags: string[]): Promise<number> {
  const { io, db } = capture();
  return runCli(["--db", db, "release", "bump-consumers", ...flags], io, depsOver(world));
}

describe("release bump-consumers verb", () => {
  it("prints one line per planned PR and writes nothing on --dry-run", async () => {
    const world = consumerBumpWorld();
    const readOnly: GitHubPort = { ...world.port, ensureBranch: refuse("ensureBranch"), putFile: refuse("putFile"), openPr: refuse("openPr") };
    const { out, err, io, db } = capture();

    const code = await runCli(["--db", db, "release", "bump-consumers", "--dry-run"], io, depsOver(world, readOnly));

    expect({ code, err: err.join("") }).toEqual({ code: EXIT.OK, err: "" });
    expect(out.join("")).toBe(
      [
        `${CONSUMER_A}: open ${branchA} into main [@titan-design/example-a ^1.2.0 -> ^1.4.0, @titan-design/example-b ~0.9.0 -> ~0.10.0]`,
        `${CONSUMER_B}: open ${branchB} into main [@titan-design/example-b 0.9.1 -> 0.10.0]`,
        "",
      ].join("\n"),
    );
    expect(world.regenCalls).toEqual([]);
    for (const fake of world.fakes.values()) expect(fake.effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
  });

  it("dry-run skips a repo with an open bump PR and prints why", async () => {
    const world = consumerBumpWorld();
    const open = world.fakes.get(CONSUMER_A)!.addPr({ headSha: fakeSha("open"), headRef: branchA });
    const { out, io, db } = capture();

    const code = await runCli(["--db", db, "release", "bump-consumers", "--dry-run"], io, depsOver(world));

    expect(code).toBe(EXIT.OK);
    expect(out.join("")).toBe([`${CONSUMER_B}: open ${branchB} into main [@titan-design/example-b 0.9.1 -> 0.10.0]`, `skip ${CONSUMER_A}: open bump PR #${open.number}`, ""].join("\n"));
    for (const fake of world.fakes.values()) expect(fake.effects).toMatchObject({ createRef: 0, putContent: 0, createPr: 0 });
  });

  it("dry-run skips a repo whose bump PR was closed", async () => {
    const world = consumerBumpWorld();
    const closed = world.fakes.get(CONSUMER_B)!.addPr({ headSha: fakeSha("rejected"), headRef: branchB, state: "closed" });
    const { out, io, db } = capture();

    const code = await runCli(["--db", db, "release", "bump-consumers", "--dry-run"], io, depsOver(world));

    expect(code).toBe(EXIT.OK);
    expect(out.join("")).toContain(`skip ${CONSUMER_B}: closed bump PR #${closed.number}\n`);
    expect(out.join("")).not.toContain(`${CONSUMER_B}: open`);
  });

  it("exits EXIT.UNAVAILABLE when any repo notes an error and EXIT.OK otherwise", async () => {
    const opened = consumerBumpWorld();

    expect(await bumpCode(opened)).toBe(EXIT.OK);
    expect(await bumpCode(consumerBumpWorld({ regenFails: true }))).toBe(EXIT.UNAVAILABLE);
    expect(await bumpCode(consumerBumpWorld({ getFileThrows: CONSUMER_A }), "--dry-run")).toBe(EXIT.UNAVAILABLE);
    expect(opened.fakes.get(CONSUMER_A)!.effects.createPr).toBe(1);
  });
});
