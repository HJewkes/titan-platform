import { describe, expect, it } from "vitest";
import { BODY_ENV, run, type CliDeps } from "./cli.js";

const FOOTER = (door: string) =>
  `Summary\n<!-- merge-danger:v1 -->\nDoor: ${door}\nBlast radius: one command\nRollback: revert\nContract: none\n`;
const TWO_WAY_DIFF = "10\t2\tsrc/cli/status.ts\n20\t1\tsrc/cli/status.test.ts\n";
const MIGRATION_DIFF = "10\t0\tsrc/db/migrations/001-init.sql\n";

function harness(diff: string, body: string, extraEnv: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    diff: () => diff,
    readText: (path) => {
      if (path === "body.md") return body;
      throw new Error(`unexpected read ${path}`);
    },
    env: extraEnv,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { deps, out, err };
}

describe("review-burden bin", () => {
  it("exits 0 and prints the table and a JSON line by default, even with no footer", () => {
    const { deps, out, err } = harness(TWO_WAY_DIFF, "");
    expect(run(["--body-file", "body.md"], deps)).toBe(0);
    const json = JSON.parse(out.join("").trim().split("\n").at(-1) ?? "");
    expect(out.join("")).toContain("total");
    expect(json.score.facts.footer).toBe(false);
    expect(json.door.door).toBe("two-way");
    expect(err).toEqual([]);
  });

  it("exits 1 with a remediation message under --enforce when the footer is missing", () => {
    const { deps, err } = harness(TWO_WAY_DIFF, "no footer here");
    expect(run(["--enforce", "--body-file", "body.md"], deps)).toBe(1);
    expect(err.join("")).toContain("merge-danger footer");
  });

  it("exits 1 under --enforce when the door is declared two-way but the diff is one-way", () => {
    const { deps, err } = harness(MIGRATION_DIFF, FOOTER("two-way"));
    expect(run(["--enforce", "--body-file", "body.md"], deps)).toBe(1);
    expect(err.join("")).toContain("Declare Door: one-way");
  });

  it("exits 0 under --enforce for a clean footer, reading the body from the env var", () => {
    const { deps, err } = harness(TWO_WAY_DIFF, "", { [BODY_ENV]: FOOTER("two-way") });
    expect(run(["--enforce"], deps)).toBe(0);
    expect(err).toEqual([]);
  });

  it("exits 0 under --enforce for a one-way diff that declares one-way", () => {
    const { deps } = harness(MIGRATION_DIFF, FOOTER("one-way"));
    expect(run(["--enforce", "--body-file", "body.md"], deps)).toBe(0);
  });

  it("exits 2 on an unknown argument", () => {
    const { deps, err } = harness("", "");
    expect(run(["--nope"], deps)).toBe(2);
    expect(err.join("")).toContain("unknown argument");
  });
});
