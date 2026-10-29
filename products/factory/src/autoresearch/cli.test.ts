import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArLadderView, ArRunView, Outcome } from "@titan-design/autoresearch";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, runCli, type CliDeps } from "../cli.js";
import { formatView } from "./cli.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const DEPS: CliDeps = { workflows: [], routes: [], serveWaitMs: 200 };

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, { stdout: (t) => void (out += t), stderr: (t) => void (err += t), env: {} }, DEPS);
  return { code, out, err };
}

/** A loopback port nothing listens on, so every verb sees serve as down. */
async function deadPort(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return String(address.port);
}

function scratchDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ar-cli-"));
  dirs.push(dir);
  return join(dir, "factory.sqlite3");
}

const ladder = (id: string, rungReached: Outcome["rungReached"] | null) =>
  partialFake<ArLadderView>({ idea: partialFake<ArLadderView["idea"]>({ id }), outcome: rungReached === null ? null : partialFake<Outcome>({ rungReached }) });

function fixtureView(): ArRunView {
  const target = partialFake<ArRunView["target"]>({ name: "fixture", metric: partialFake<ArRunView["target"]["metric"]>({ primary: "score" }) });
  const rounds = [
    partialFake<ArRunView["rounds"][number]>({ round: 1, ladders: [ladder("i-none00000000", "none"), ladder("i-l0aaaaaaaaaa", "L0"), ladder("i-l1aaaaaaaaaa", "L1")] }),
    partialFake<ArRunView["rounds"][number]>({ round: 2, ladders: [ladder("i-l2aaaaaaaaaa", "L2"), ladder("i-l3aaaaaaaaaa", "L3"), ladder("i-l0bbbbbbbbbb", "L0"), ladder("i-runningaaaa", null)] }),
  ];
  return partialFake<ArRunView>({ runId: "run-1", status: "running", error: null, target, settings: { lanes: 3, rounds: 5, minPool: 12 }, best: { head: "a".repeat(40), primary: 1.5 }, rounds });
}

describe("autoresearch status", () => {
  it("prints each idea under the rung its ladder stopped at, and the running ones apart", () => {
    expect(formatView(fixtureView())).toBe(
      [
        `run run-1 fixture: running, round 2/5, best ${"a".repeat(12)} score 1.5`,
        "  none: i-none00000000",
        "  L0: i-l0aaaaaaaaaa i-l0bbbbbbbbbb",
        "  L1: i-l1aaaaaaaaaa",
        "  L2: i-l2aaaaaaaaaa",
        "  L3: i-l3aaaaaaaaaa",
        "  running: i-runningaaaa",
        "",
      ].join("\n"),
    );
  });

  it("exits 69 with serve down and no local database, and creates none", async () => {
    const db = scratchDb();

    const listed = await cli(["--db", db, "autoresearch", "status", "--port", await deadPort()]);
    const one = await cli(["--db", db, "autoresearch", "status", "run-1", "--port", await deadPort()]);

    expect([listed.code, one.code]).toEqual([EXIT.UNAVAILABLE, EXIT.UNAVAILABLE]);
    expect(listed.err).toContain("there is no local database");
    expect(existsSync(db)).toBe(false);
  });

  it("reads the local database when serve is down and one exists", async () => {
    const db = scratchDb();
    await cli(["--db", db, "resume"]);

    const listed = await cli(["--db", db, "autoresearch", "status", "--port", await deadPort()]);

    expect(listed).toMatchObject({ code: EXIT.OK, out: "no autoresearch runs\n" });
  });
});

describe("autoresearch milestone and start", () => {
  it("refuses a milestone in-process with exit 69, even beside a local database", async () => {
    const db = scratchDb();
    await cli(["--db", db, "resume"]);

    const { code, err } = await cli(["--db", db, "autoresearch", "milestone", "run-1", "--port", await deadPort()]);

    expect(code).toBe(EXIT.UNAVAILABLE);
    expect(err).toContain("only serve can do");
    expect(err.trim().split("\n")).toHaveLength(1);
  });

  it("exits usage on a bad flag and failure when the factory has no autoresearch config", async () => {
    const db = scratchDb();
    const port = await deadPort();

    const badLanes = await cli(["--db", db, "autoresearch", "start", "fixture", "--pin", "c".repeat(40), "--lanes", "0", "--port", port]);
    const unconfigured = await cli(["--db", db, "autoresearch", "start", "fixture", "--pin", "c".repeat(40), "--port", port]);

    expect(badLanes.code).toBe(EXIT.USAGE);
    expect(unconfigured).toMatchObject({ code: EXIT.FAILURE, err: expect.stringContaining("[no-config]") });
  });
});

describe("autoresearch plan-dry-run", () => {
  it("fails without spawning when the factory has no autoresearch config", async () => {
    const { code, err, out } = await cli(["autoresearch", "plan-dry-run", "fixture"]);

    expect({ code, out }).toEqual({ code: EXIT.FAILURE, out: "" });
    expect(err).toContain("[no-config] autoresearch is not configured");
  });
});
