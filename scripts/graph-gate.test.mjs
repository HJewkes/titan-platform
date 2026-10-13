import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { combineExits, runGate } from "./graph-gate.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratchDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "graph-gate-test-"));
  dirs.push(dir);
  return dir;
}

function fakeCheck(dir, name) {
  const file = path.join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.env.RECORD_DIR + "/${name}.json", JSON.stringify({ argv: process.argv.slice(2), baseRef: process.env.BASE_REF ?? null }));
process.exit(Number(process.env.${name.toUpperCase()}_EXIT));
`,
  );
  return file;
}

function gitRepo({ withOriginMain }) {
  const dir = scratchDir();
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "base");
  if (withOriginMain) git("update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function gate({ dag, dead, argv = [], env = {}, withOriginMain = false }) {
  const records = scratchDir();
  const scripts = scratchDir();
  const code = runGate({
    dagScript: fakeCheck(scripts, "dag"),
    deadScript: fakeCheck(scripts, "dead"),
    argv,
    env: { PATH: process.env.PATH, RECORD_DIR: records, DAG_EXIT: String(dag), DEAD_EXIT: String(dead), ...env },
    cwd: gitRepo({ withOriginMain }),
  });
  const read = (name) => (existsSync(path.join(records, `${name}.json`)) ? JSON.parse(readFileSync(path.join(records, `${name}.json`), "utf8")) : null);
  return { code, dag: read("dag"), dead: read("dead") };
}

describe("graph gate exit code", () => {
  it("fails on a new dead export even when the DAG is clean", () => {
    expect(gate({ dag: 0, dead: 1 }).code).toBe(1);
  });

  it("fails on a DAG violation even when no export is dead", () => {
    expect(gate({ dag: 1, dead: 0 }).code).toBe(1);
  });

  it("passes when both checks pass", () => {
    expect(gate({ dag: 0, dead: 0 }).code).toBe(0);
  });

  it("skips dead:check when the DAG check kept no graph", () => {
    const r = gate({ dag: 2, dead: 0 });
    expect(r.code).toBe(2);
    expect(r.dead).toBeNull();
  });

  it("surfaces a busy lock or failed run over a finding", () => {
    expect(gate({ dag: 0, dead: 75 }).code).toBe(75);
    expect(combineExits(1, 2)).toBe(2);
    expect(combineExits(75, 0)).toBe(75);
  });
});

describe("graph gate graph handoff", () => {
  it("hands dead:check the temp graph dag-check kept, then removes it", () => {
    const r = gate({ dag: 0, dead: 0, argv: ["--json"] });
    const at = r.dag.argv.indexOf("--db");
    const db = r.dag.argv[at + 1];
    expect(r.dag.argv[0]).toBe("--json");
    expect(r.dead.argv).toEqual(["--db", db]);
    expect(existsSync(path.dirname(db))).toBe(false);
  });

  it("keeps a graph path the caller passed", () => {
    const keep = path.join(scratchDir(), "graph.db");
    writeFileSync(keep, "ci graph");
    const r = gate({ dag: 0, dead: 0, argv: ["--db", keep] });
    expect(r.dag.argv).toEqual(["--db", keep]);
    expect(r.dead.argv).toEqual(["--db", keep]);
    expect(existsSync(keep)).toBe(true);
  });
});

describe("graph gate BASE_REF", () => {
  it("defaults BASE_REF to origin/main for dead:check only", () => {
    const r = gate({ dag: 0, dead: 0, withOriginMain: true });
    expect(r.dead.baseRef).toBe("origin/main");
    expect(r.dag.baseRef).toBeNull();
  });

  it("runs dead:check without BASE_REF when origin/main does not exist", () => {
    const r = gate({ dag: 0, dead: 1 });
    expect(r.dead.baseRef).toBeNull();
    expect(r.code).toBe(1);
  });

  it("passes a caller's BASE_REF to both checks unchanged", () => {
    const r = gate({ dag: 0, dead: 0, env: { BASE_REF: "origin/feature" }, withOriginMain: true });
    expect(r.dag.baseRef).toBe("origin/feature");
    expect(r.dead.baseRef).toBe("origin/feature");
  });
});
