import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRepo, hostReport, readToolchain, runDoctor } from "./env-doctor.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const CANON = { nodeVersion: "24.21.0", packageManager: "pnpm@9.15.0", enginesNode: ">=24 <25" };

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "env-doctor-"));
  roots.push(dir);
  const { nodeVersion, packageManager, enginesNode } = { ...CANON, ...files };
  if (nodeVersion !== null) writeFileSync(join(dir, ".node-version"), `${nodeVersion}\n`);
  const pkg = { packageManager, engines: { node: enginesNode } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}

const host = (node = "24.21.0", pnpm = "9.15.0") => ({ node: () => node, pnpm: () => pnpm });

describe("readToolchain", () => {
  it("reads the three declarations, trimming a leading v from .node-version", () => {
    expect(readToolchain(repo({ nodeVersion: "v24.21.0" }))).toEqual(CANON);
  });

  it("reports a missing .node-version as null", () => {
    expect(readToolchain(repo({ nodeVersion: null })).nodeVersion).toBeNull();
  });
});

describe("checkRepo", () => {
  it("finds no drift when repo and host match the canonical values", () => {
    expect(checkRepo(CANON, CANON, { node: "24.21.0", pnpm: "9.15.0" })).toEqual([]);
  });

  it("names each repo declaration that differs from canonical", () => {
    const drifted = { nodeVersion: "22.1.0", packageManager: "pnpm@10.0.0", enginesNode: ">=22" };
    const drift = checkRepo(drifted, CANON, { node: "22.1.0", pnpm: "10.0.0" });
    expect(drift.map((d) => d.subject)).toEqual([".node-version", "packageManager", "engines.node"]);
    expect(drift[0].message).toContain("22.1.0");
    expect(drift[0].message).toContain("24.21.0");
  });

  it("names a missing .node-version", () => {
    const drift = checkRepo({ ...CANON, nodeVersion: null }, CANON, { node: "24.21.0", pnpm: "9.15.0" });
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain(".node-version is missing");
  });

  it("names host node and pnpm that differ from the repo", () => {
    const drift = checkRepo(CANON, CANON, { node: "20.0.0", pnpm: "8.0.0" });
    expect(drift.map((d) => d.subject)).toEqual(["host node", "host pnpm"]);
  });
});

describe("hostReport", () => {
  it("reports host versions, canonical values and an empty drift list", () => {
    expect(hostReport(CANON, { node: "24.21.0", pnpm: "9.15.0" })).toEqual({
      node: "24.21.0",
      pnpm: "9.15.0",
      canonical: { node: "24.21.0", pnpm: "9.15.0", engines: ">=24 <25" },
      drift: [],
    });
  });

  it("lists host drift", () => {
    expect(hostReport(CANON, { node: "20.0.0", pnpm: "9.15.0" }).drift).toHaveLength(1);
  });
});

describe("runDoctor", () => {
  const run = (argv, probes) => {
    const out = [];
    const code = runDoctor(argv, { probes, canonicalRoot: repo(), log: (line) => out.push(line) });
    return { code, out };
  };
  it("exits 0 and says ok when everything matches", () => {
    const { code, out } = run(["--repo", repo()], host());
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("ok");
  });

  it("exits 1 and prints one line per drift for a drifted repo", () => {
    const { code, out } = run(["--repo", repo({ packageManager: "pnpm@10.0.0" })], host());
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("packageManager");
  });

  it("exits 1 when the host differs from the repo", () => {
    expect(run(["--repo", repo()], host("20.0.0")).code).toBe(1);
  });

  it("exits 1 for a repo with no .node-version", () => {
    expect(run(["--repo", repo({ nodeVersion: null })], host()).code).toBe(1);
  });

  it("prints a single JSON line in --host mode", () => {
    const { code, out } = run(["--host"], host("20.0.0"));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ node: "20.0.0", pnpm: "9.15.0", drift: [expect.any(Object)] });
    expect(code).toBe(1);
  });

  it("exits 0 in --host mode when the host matches", () => {
    expect(run(["--host"], host()).code).toBe(0);
  });
});

