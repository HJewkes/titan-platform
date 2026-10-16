import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_PATH, MILESTONES_PATH, checkManifest, classifyManifest, defaultedNotices, exitedMilestones, listRoots, milestoneOf } from "./sunset-manifest.mjs";

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

describe("sunset check directory defaults", () => {
  const rule = { repo: "titan-platform", path: "old", fate: "kept", reason: "new files here default to kept" };

  it("lets a new file under a dir with a default pass without an entry", () => {
    expect(checkManifest({ ...manifestOf(del("old/a.ts")), defaults: [rule] }, listing("old/a.ts", "old/new.ts"))).toEqual([]);
  });

  it("still fails a new file under a dir that has no default", () => {
    const sub = { ...rule, path: "old/sub" };

    expect(checkManifest({ ...manifestOf(del("old/a.ts")), defaults: [sub] }, listing("old/a.ts", "old/new.ts", "old/sub/x.ts"))).toEqual(["titan-platform:old/new.ts: unmapped"]);
  });

  it("refuses a default without a reason or outside every root", () => {
    const bad = [{ ...rule, reason: undefined }, { ...rule, path: "elsewhere" }];

    expect(checkManifest({ ...manifestOf(del("old/a.ts")), defaults: bad }, listing("old/a.ts"))).toEqual([
      "default old: kept needs a reason",
      "titan-platform:elsewhere: default under no root",
    ]);
  });
});

describe("sunset check defaulted notice", () => {
  const rule = { repo: "titan-platform", path: "old", fate: "kept", reason: "default: entry owed" };
  const withDefault = (...entries) => ({ ...manifestOf(...entries), defaults: [rule] });

  it("lists a file only a default covers and drops it once an entry maps it", () => {
    expect(defaultedNotices(withDefault(del("old/a.ts")), listing("old/a.ts", "old/new.ts"))).toEqual(["defaulted: titan-platform:old/new.ts (old)"]);
    expect(defaultedNotices(withDefault(del("old/a.ts"), del("old/new.ts")), listing("old/a.ts", "old/new.ts"))).toEqual([]);
  });

  it("passes the command with a notice and the same exit code for a defaulted file", () => {
    const box = sandbox(["a.ts", "new.ts"], ["a.ts"]);
    writeFileSync(box.manifest, JSON.stringify({ roots: [{ repo: "agent-chat", path: "old" }], entries: [{ ...del("old/a.ts"), repo: "agent-chat" }], defaults: [{ ...rule, repo: "agent-chat" }] }));

    const result = run(box);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("::notice::defaulted: agent-chat:old/new.ts (old)");
    expect(result.stderr).toContain("::notice::defaulted: 1 files");
  });
});

describe("sunset check --agent-chat-drift", () => {
  const withMode = (box, mode, extra = []) => spawnSync(process.execPath, [SCRIPT, "check", "--agent-chat", box.dir, "--manifest", box.manifest, "--agent-chat-drift", mode, ...extra], { encoding: "utf8" });
  const exitM3 = (box) => {
    const milestones = join(box.dir, "milestones.json");
    writeFileSync(milestones, JSON.stringify({ milestones: [{ id: "M3", exited: "2026-01-01" }] }));
    return ["--milestones", milestones];
  };

  it("tags each problem as overdue, drift or shape", () => {
    const entries = [del("old/a.ts"), del("old/a.ts"), del("old/gone.ts")];

    expect(classifyManifest(manifestOf(...entries), listing("old/a.ts", "old/new.ts"), new Set(["M3"])).map((p) => p.kind)).toEqual(["shape", "overdue", "overdue", "drift", "drift"]);
  });

  it("warns on an unmapped agent-chat file and exits 0 under warn, 1 under fail", () => {
    const box = sandbox(["a.ts", "b.ts"], ["a.ts"]);
    const warn = withMode(box, "warn");

    expect({ status: warn.status, stderr: warn.stderr }).toEqual({ status: 0, stderr: "::warning::agent-chat:old/b.ts: unmapped\n" });
    expect(withMode(box, "fail").status).toBe(1);
    expect(run(box).status).toBe(1);
  });

  it("still fails an overdue agent-chat delete under warn, and passes once the file is gone", () => {
    const box = sandbox(["a.ts", "keep.ts"], ["a.ts"]);
    const kept = { ...del("old/keep.ts"), repo: "agent-chat", fate: "kept", reason: "stays" };
    writeFileSync(box.manifest, JSON.stringify({ roots: [{ repo: "agent-chat", path: "old" }], entries: [{ ...del("old/a.ts"), repo: "agent-chat" }, kept] }));
    const red = withMode(box, "warn", exitM3(box));
    rmSync(join(box.dir, "old", "a.ts"));
    execFileSync("git", ["-C", box.dir, "rm", "-q", "--cached", "old/a.ts"]);
    writeFileSync(box.manifest, JSON.stringify({ roots: [{ repo: "agent-chat", path: "old" }], entries: [kept] }));

    expect({ status: red.status, stderr: red.stderr }).toEqual({ status: 1, stderr: "agent-chat:old/a.ts: still exists but D-M3-19 was due at the exit of M3\n" });
    expect(withMode(box, "warn", exitM3(box)).status).toBe(0);
  });

  it("fails under warn when the agent-chat checkout lists no files at all", () => {
    const box = sandbox([], ["a.ts"]);

    const empty = withMode(box, "warn");

    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("agent-chat: every root lists 0 files");
  });

  it("rejects a mode other than fail or warn", () => {
    const box = sandbox(["a.ts"], ["a.ts"]);

    expect(withMode(box, "ignore").status).toBe(1);
  });
});

describe("sunset check by milestone exit", () => {
  const exitedM3 = new Set(["M3"]);

  it("reads the milestone from the task id", () => {
    expect([milestoneOf("D-M3-12"), milestoneOf("D-M1b-02"), milestoneOf("D-M0-07"), milestoneOf("nope")]).toEqual(["M3", "M1b", "M0", undefined]);
  });

  it("fails a file whose deleting task sits in an exited milestone", () => {
    expect(checkManifest(manifestOf(del("old/a.ts")), listing("old/a.ts"), exitedM3)).toEqual(["titan-platform:old/a.ts: still exists but D-M3-19 was due at the exit of M3"]);
  });

  it("passes once the file is deleted, or while its milestone has not exited", () => {
    expect(checkManifest(manifestOf(del("old/a.ts")), listing("old/a.ts"), new Set(["M2"]))).toEqual([]);
    expect(checkManifest(manifestOf(), listing(), exitedM3)).toEqual([]);
  });

  it("ignores kept and surviving files in an exited milestone", () => {
    const entries = [{ repo: "titan-platform", path: "old/k.ts", fate: "kept", reason: "r" }, { repo: "titan-platform", path: "old/s.ts", fate: "survives", task: "D-M3-12" }];

    expect(checkManifest(manifestOf(...entries), listing("old/k.ts", "old/s.ts"), exitedM3)).toEqual([]);
  });

  it("exits non-zero from the command line when a milestone exits with the file still present, zero when it is unexited", () => {
    const box = sandbox(["a.ts"], ["a.ts"]);
    const milestones = join(box.dir, "milestones.json");
    writeFileSync(milestones, JSON.stringify({ milestones: [{ id: "M3", exited: "2026-01-01" }] }));
    const withMilestones = () => spawnSync(process.execPath, [SCRIPT, "check", "--agent-chat", box.dir, "--manifest", box.manifest, "--milestones", milestones], { encoding: "utf8" });
    const red = withMilestones();
    writeFileSync(milestones, JSON.stringify({ milestones: [{ id: "M3", exited: false }] }));

    expect({ status: red.status, stderr: red.stderr }).toEqual({ status: 1, stderr: "agent-chat:old/a.ts: still exists but D-M3-19 was due at the exit of M3\n" });
    expect(withMilestones().status).toBe(0);
  });
});

describe("the checked-in manifest", () => {
  it("lists M0 to M8 with none exited, so main stays green", () => {
    const file = JSON.parse(readFileSync(MILESTONES_PATH, "utf8"));

    expect(file.milestones.map((m) => m.id)).toEqual(["M0", "M1a", "M1b", "M2", "M3", "M4", "M5", "M6", "M7", "M8"]);
    expect(exitedMilestones(file).size).toBe(0);
  });

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

  it("maps every file under products/factory/src/shepherd", () => {
    expect(checkManifest(manifest, listRoots(manifest, { "titan-platform": REPO }), exitedMilestones(JSON.parse(readFileSync(MILESTONES_PATH, "utf8"))))).toEqual([]);
  });

  it("carries no entry whose reason starts with unclear:", () => {
    expect(manifest.entries.filter((e) => (e.reason ?? "").startsWith("unclear:")).map((e) => `${e.repo}:${e.path}`)).toEqual([]);
  });

  it("lists every A.2 compensator against a deleting task or a reason it has none", () => {
    const ids = manifest.compensators.map((c) => c.id);
    const firm = Array.from({ length: 36 }, (_, i) => `C${i + 1}`).filter((id) => id !== "C33");

    expect(firm.filter((id) => !ids.includes(id))).toEqual([]);
    expect(manifest.compensators.filter((c) => !c.deletedBy && !c.reason)).toEqual([]);
    expect(manifest.compensators.filter((c) => c.class === "temporary").map((c) => c.deletedBy)).toEqual(["D-M3-19", "D-M3-19", "D-M3-19", "D-M3-19", "D-M3-19", "D-M8-09"]);
  });

  it("says plainly which docs were searched for every compensator with no deleting task", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    const undeleted = manifest.compensators.filter((c) => !c.deletedBy);

    expect(undeleted.length).toBeGreaterThan(0);
    expect(undeleted.filter((c) => !/^no v9\.1 task deletes it: .*v9\.1-amendments-421\.md.*v9\.1-decomposition-draft-r2\.md/.test(c.reason))).toEqual([]);
  });

  it("carries the three root defaults, with burndown on its D-M8-08 rung", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

    expect(manifest.defaults.map(({ repo, path, fate, task }) => [repo, path, fate, task])).toEqual([
      ["titan-platform", "products/factory/src/shepherd", "kept", undefined],
      ["agent-chat", "src/agents/burndown", "delete", "D-M8-08"],
      ["agent-chat", "scripts/seat", "kept", undefined],
    ]);
  });
});
