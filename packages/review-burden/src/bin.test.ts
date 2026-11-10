import { describe, expect, it } from "vitest";
import { BODY_ENV, run, type CliDeps } from "./cli.js";

const FOOTER = (door: string) =>
  `Summary\n<!-- merge-danger:v1 -->\nDoor: ${door}\nBlast radius: one command\nRollback: revert\nContract: none\n`;
const TWO_WAY_DIFF = "10\t2\tsrc/cli/status.ts\0" + "20\t1\tsrc/cli/status.test.ts\0";
const MIGRATION_DIFF = "10\t0\tsrc/db/migrations/001-init.sql\0";

function harness(diff: string, body: string, extraEnv: Record<string, string> = {}, files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    diff: () => diff,
    readText: (path) => {
      if (path === "body.md") return body;
      if (path in files) return files[path] ?? "";
      throw new Error(`unexpected read ${path}`);
    },
    env: extraEnv,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  };
  return { deps, out, err };
}

function doorOf(out: readonly string[]): { facts: { kind: string; path?: string }[] } {
  return JSON.parse(out.join("").trim().split("\n").at(-1) ?? "").door;
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

  it("keeps the path class of a path with a space and a non-ASCII character", () => {
    const { deps, out } = harness("10\t0\tsrc/db/migrations/été 1.sql\0", "");
    run(["--body-file", "body.md"], deps);
    expect(doorOf(out).facts).toEqual([{ kind: "migration", path: "src/db/migrations/été 1.sql" }]);
  });

  it("reads the NUL-separated rename form, where the old and new paths are separate fields", () => {
    const { deps, out } = harness("5\t1\t\0src/db/migrations/été old.sql\0src/été new.ts\0", "");
    run(["--body-file", "body.md"], deps);
    expect(doorOf(out).facts).toEqual([{ kind: "migration", path: "src/db/migrations/été old.sql" }]);
  });

  it("expands the a/{x => y}/b rename form to both sides", () => {
    const { deps, out } = harness("1\t1\tsrc/db/migrations/{x => y}/f.sql\0", "");
    run(["--body-file", "body.md"], deps);
    expect(doorOf(out).facts.map((fact) => fact.path)).toEqual([
      "src/db/migrations/y/f.sql",
      "src/db/migrations/x/f.sql",
    ]);
  });

  it("expands the whole-path {old => new} rename form", () => {
    const { deps, out } = harness("1\t1\t{src/db/migrations/a.sql => src/b.ts}\0", "");
    run(["--body-file", "body.md"], deps);
    expect(doorOf(out).facts).toEqual([{ kind: "migration", path: "src/db/migrations/a.sql" }]);
  });

  it("collapses the doubled slash left by an empty brace side", () => {
    const { deps, out } = harness("1\t1\tsrc/db/{ => migrations}/f.sql\0", "");
    run(["--body-file", "body.md"], deps);
    expect(doorOf(out).facts).toEqual([{ kind: "migration", path: "src/db/migrations/f.sql" }]);
  });

  it("reports a major-changeset fact for a changeset whose package name is quoted", () => {
    const changeset = `---\n"@scope/pkg": major\n---\n\nBreak it.\n`;
    const { deps, out } = harness("3\t0\t.changeset/brave-owl.md\0", "", {}, { ".changeset/brave-owl.md": changeset });
    run(["--body-file", "body.md"], deps);
    expect(doorOf(out).facts).toEqual([{ kind: "major-changeset" }]);
  });
});
