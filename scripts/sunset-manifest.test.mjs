import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, checkManifest, listRoots } from "./sunset-manifest.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sunset-manifest.mjs");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const del = (path) => ({ repo: "titan-platform", path, fate: "delete", task: "D-M3-19", milestone: "M3" });
const manifestOf = (...entries) => ({ roots: [{ repo: "titan-platform", path: "old" }], entries });
const listing = (...files) => ({ "titan-platform:old": files });

/** A git checkout whose `old/` holds `files`, and a manifest file that maps `mapped`. */
function sandbox(files, mapped) {
  const dir = mkdtempSync(join(tmpdir(), "sunset-manifest-"));
  dirs.push(dir);
  mkdirSync(join(dir, "old"));
  for (const file of files) writeFileSync(join(dir, "old", file), "x\n");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "."]);
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ roots: [{ repo: "agent-chat", path: "old" }], entries: mapped.map((name) => ({ ...del(`old/${name}`), repo: "agent-chat" })) }));
  return { dir, manifest };
}

const run = ({ dir, manifest }) => spawnSync(process.execPath, [SCRIPT, "check", "--agent-chat", dir, "--manifest", manifest], { encoding: "utf8" });

describe("sunset manifest check", () => {
  it("passes when every listed file is mapped once", () => {
    expect(checkManifest(manifestOf(del("old/a.ts"), del("old/b.ts")), listing("old/a.ts", "old/b.ts"))).toEqual([]);
  });

  it("names a file the root gained that no entry maps", () => {
    expect(checkManifest(manifestOf(del("old/a.ts")), listing("old/a.ts", "old/new.ts"))).toEqual(["titan-platform:old/new.ts: unmapped"]);
  });

  it("names an entry whose file git no longer lists", () => {
    expect(checkManifest(manifestOf(del("old/a.ts"), del("old/gone.ts")), listing("old/a.ts"))).toEqual(["titan-platform:old/gone.ts: mapped but not in git"]);
  });

  it("refuses a file mapped twice, a kept entry without a reason and a delete without a task", () => {
    const entries = [del("old/a.ts"), del("old/a.ts"), { repo: "titan-platform", path: "old/b.ts", fate: "kept" }, { repo: "titan-platform", path: "old/c.ts", fate: "delete", milestone: "M3" }];

    expect(checkManifest(manifestOf(...entries), listing("old/a.ts", "old/b.ts", "old/c.ts"))).toEqual([
      "titan-platform:old/a.ts: mapped twice",
      "old/b.ts: kept needs a reason",
      "old/c.ts: delete needs a D-task id",
    ]);
  });

  it("checks only the shape of a root whose repo has no checkout", () => {
    expect(checkManifest(manifestOf(del("old/a.ts")), {})).toEqual([]);
  });

  it("exits non-zero from the command line when a root gains an unmapped file, zero once it is mapped", () => {
    const box = sandbox(["a.ts", "b.ts"], ["a.ts"]);
    const red = run(box);
    writeFileSync(box.manifest, JSON.stringify({ roots: [{ repo: "agent-chat", path: "old" }], entries: ["a.ts", "b.ts"].map((name) => ({ ...del(`old/${name}`), repo: "agent-chat" })) }));

    expect({ status: red.status, stderr: red.stderr }).toEqual({ status: 1, stderr: "agent-chat:old/b.ts: unmapped\n" });
    expect(run(box).status).toBe(0);
  });
});

describe("the checked-in manifest", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  it("maps every file under products/factory/src/shepherd", () => {
    expect(checkManifest(manifest, listRoots(manifest, { "titan-platform": REPO }))).toEqual([]);
  });

  it("lists every A.2 compensator against a deleting task or a reason it has none", () => {
    const ids = manifest.compensators.map((c) => c.id);
    const firm = Array.from({ length: 36 }, (_, i) => `C${i + 1}`).filter((id) => id !== "C33");

    expect(firm.filter((id) => !ids.includes(id))).toEqual([]);
    expect(manifest.compensators.filter((c) => !c.deletedBy && !c.reason)).toEqual([]);
    expect(manifest.compensators.filter((c) => c.class === "temporary").map((c) => c.deletedBy)).toEqual(["D-M3-19", "D-M3-19", "D-M3-19", "D-M3-19", "D-M3-19", "D-M8-09"]);
  });
});
