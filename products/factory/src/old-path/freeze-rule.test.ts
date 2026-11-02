import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PrFile } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findSunsetManifest } from "../dispatch/old-paths.js";
import { A1_FROZEN_ROOTS, carveOutOf, frozenTouches, oldPathVerdict, readExited } from "./freeze-rule.js";

const Row = z.object({ repo: z.string(), path: z.string() });
const Manifest = z.object({ roots: z.array(Row), defaults: z.array(Row) });
const REPO = "acme/titan-platform";
const SHEPHERD_FILE = "products/factory/src/shepherd/example.ts";
const modified = (path: string): PrFile => ({ path, status: "modified" });
const exitedM1b = { exited: new Set(["M1b"]) };
const notExited = { exited: new Set<string>() };

describe("old-path freeze rule", () => {
  it("a PR touching products/factory/src/shepherd whose task has no carve-out tag is refused once M1b has exited", () => {
    const verdict = oldPathVerdict({
      repo: REPO,
      files: [modified(SHEPHERD_FILE)],
      task: { tags: ["kind:correctness"] },
      exited: exitedM1b,
    });

    expect(verdict).toMatchObject({ status: "untagged", active: true, touches: [SHEPHERD_FILE] });
  });

  it("the same PR is accepted when its task carries superseded-at:M3, or survives:factory", () => {
    const files = [modified(SHEPHERD_FILE)];

    const superseded = oldPathVerdict({ repo: REPO, files, task: { tags: ["superseded-at:M3"] }, exited: exitedM1b });
    const survives = oldPathVerdict({ repo: REPO, files, task: { tags: ["survives:factory"] }, exited: exitedM1b });

    expect(superseded).toMatchObject({ status: "carved", tag: "superseded-at:M3" });
    expect(survives).toMatchObject({ status: "carved", tag: "survives:factory" });
  });

  it("before M1b exits an untagged touch is recorded as advisory and does not refuse", () => {
    const verdict = oldPathVerdict({
      repo: REPO,
      files: [modified(SHEPHERD_FILE)],
      task: { tags: [] },
      exited: { exited: new Set(["M0", "M1a"]) },
    });

    expect(verdict).toMatchObject({ status: "untagged", active: false });
  });

  it("a PR that only deletes old-path files, or renames them out of the root, touches nothing frozen; a rename into the root does", () => {
    const removed: PrFile = { path: SHEPHERD_FILE, status: "removed" };
    const movedOut: PrFile = { path: "packages/new/example.ts", previousPath: SHEPHERD_FILE, status: "renamed" };
    const movedIn: PrFile = { path: SHEPHERD_FILE, previousPath: "packages/old/example.ts", status: "renamed" };

    expect(frozenTouches(REPO, [removed, movedOut])).toEqual([]);
    expect(frozenTouches(REPO, [movedIn])).toEqual([SHEPHERD_FILE]);
  });

  it("superseded-at naming an exited milestone is a stale carve-out and refuses", () => {
    const exited = new Set(["M1b", "M2"]);

    expect(carveOutOf(["superseded-at:M2"], exited)).toEqual({ stale: "superseded-at:M2" });
    expect(carveOutOf(["superseded-at:M2", "superseded-at:M3"], exited)).toEqual({ tag: "superseded-at:M3" });
    expect(
      oldPathVerdict({
        repo: REPO,
        files: [modified(SHEPHERD_FILE)],
        task: { tags: ["superseded-at:M2"] },
        exited: { exited },
      }),
    ).toMatchObject({ status: "stale-tag", active: true });
  });

  it("an unread milestones.json reads the freeze as active", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-rule-"));
    writeFileSync(join(dir, "milestones.json"), "{ not json");

    const malformed = readExited(dir);
    const absent = readExited(join(dir, "missing"));
    const verdict = oldPathVerdict({
      repo: REPO,
      files: [modified(SHEPHERD_FILE)],
      task: { tags: [] },
      exited: malformed,
    });

    expect(malformed).toHaveProperty("unread");
    expect(absent).toHaveProperty("unread");
    expect(verdict).toMatchObject({ status: "untagged", active: true });
  });

  it("reads exited milestones given as true or as a date, and the real file as not yet exited", () => {
    const dir = mkdtempSync(join(tmpdir(), "freeze-rule-"));
    const milestones = [
      { id: "M0", exited: true },
      { id: "M1a", exited: "2026-11-01" },
      { id: "M1b", exited: false },
    ];
    writeFileSync(join(dir, "milestones.json"), JSON.stringify({ schema: 1, milestones }));

    expect(readExited(dir)).toEqual({ exited: new Set(["M0", "M1a"]) });
    expect(readExited()).toEqual({ exited: new Set() });
  });

  it("every frozen root is a root or a default path of the checked-in sunset manifest", () => {
    const manifestPath = findSunsetManifest();
    expect(manifestPath).toBeDefined();
    const manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath ?? "", "utf8")));
    const known = [...manifest.roots, ...manifest.defaults].map((row) => `${row.repo}:${row.path}`);

    for (const root of A1_FROZEN_ROOTS) expect(known).toContain(`${root.repo}:${root.path}`);
    expect(dirname(manifestPath ?? "")).toContain("sunset");
  });

  it("agent-chat src outside burndown is not frozen, and products/factory/src/shepherd-x is not under the shepherd root", () => {
    const outside = frozenTouches("acme/agent-chat", [modified("src/other/example.ts")]);
    const burndown = frozenTouches("acme/agent-chat", [modified("src/agents/burndown/example.ts")]);
    const sibling = frozenTouches(REPO, [modified("products/factory/src/shepherd-x/example.ts")]);
    const wrongRepo = frozenTouches("acme/other", [modified(SHEPHERD_FILE)]);

    expect(outside).toEqual([]);
    expect(burndown).toEqual(["src/agents/burndown/example.ts"]);
    expect(sibling).toEqual([]);
    expect(wrongRepo).toEqual([]);
  });

  it("a PR outside old path is clear, and an absent or unread task refuses", () => {
    const base = { repo: REPO, files: [modified(SHEPHERD_FILE)], exited: notExited };

    expect(oldPathVerdict({ ...base, files: [modified("packages/a/b.ts")], task: { tags: [] } })).toEqual({
      status: "clear",
    });
    expect(oldPathVerdict({ ...base, task: { absent: true } })).toMatchObject({ status: "no-task" });
    expect(oldPathVerdict({ ...base, task: { unread: "timeout" } })).toMatchObject({ status: "task-unread" });
  });
});
