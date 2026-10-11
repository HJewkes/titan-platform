import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoPrivate,
  defaultPolicy,
  engineeringInitiativeOf,
  filterPrivate,
  privateHits,
  readPrivateMarkers,
  selfTest,
  type ExclusionPolicy,
} from "./exclusion.js";

/** A synthetic active-work root: two engineering initiatives and two fictional private ones. */
function writeRoot(root: string): void {
  const initiative = (slug: string, tasks: string[]) => {
    mkdirSync(join(root, slug, "tasks", "archive"), { recursive: true });
    writeFileSync(join(root, slug, "brief.md"), `# ${slug}\n`);
    for (const task of tasks) writeFileSync(join(root, slug, "tasks", `${task}.yml`), `id: ${task}\n`);
  };
  initiative("titan-platform", ["TP-1"]);
  initiative("relay", ["R-1"]);
  initiative("garden-plans", ["GDN-3"]);
  initiative("book-club", ["BKC-9", "TP-4"]);
  mkdirSync(join(root, "not-an-initiative"));
}

describe("private exclusion", () => {
  let root: string;
  let policy: ExclusionPolicy;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "exclusion-root-"));
    writeRoot(root);
    policy = defaultPolicy(root);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads every non-engineering initiative and its own task prefixes as private markers", () => {
    expect(readPrivateMarkers(root)).toEqual({ slugs: ["book-club", "garden-plans"], prefixes: ["BKC", "GDN"] });
  });

  it("self-test: the clean case passes and all four planted private cases are rejected", () => {
    expect(selfTest(policy)).toEqual({ ok: true, survivors: ["selftest-clean"], assertMissed: [], privateInitiatives: 2 });
  });

  it("self-test fails when the filter layer lets cases through", () => {
    const result = selfTest(policy, { filter: (subjects) => ({ kept: [...subjects], excluded: {} }), assert: assertNoPrivate });

    expect(result.ok).toBe(false);
    expect(result.survivors).toHaveLength(5);
  });

  it("self-test fails when the final assertion is skipped", () => {
    const result = selfTest(policy, { filter: filterPrivate, assert: () => undefined });

    expect(result.ok).toBe(false);
    expect(result.assertMissed).toHaveLength(4);
  });

  it("counts each private route under its own reason", () => {
    const { kept, excluded } = filterPrivate(
      [
        { id: "ok", repo: "owner/titan-platform", taskInitiative: "titan-platform", body: { task: "TP-2" } },
        { id: "repo", repo: "someone/diary", body: {} },
        { id: "task", repo: "owner/titan-platform", taskInitiative: "garden-plans", body: {} },
        { id: "marker", repo: "owner/titan-platform", body: { notes: "[from `book-club`] picks" } },
        { id: "task-id", repo: "owner/titan-platform", body: { notes: "see GDN-3" } },
      ],
      policy,
    );

    expect(kept.map((subject) => subject.id)).toEqual(["ok"]);
    expect(excluded).toEqual({ "private-repo": 1, "private-task": 1, "private-marker": 2 });
  });

  it("does not treat a bare word such as a slug used as an endpoint as a marker", () => {
    const markers = { slugs: ["status"], prefixes: [] };

    expect(privateHits("GET /status returns 200; status checks pass", markers)).toEqual([]);
    expect(privateHits("read active-work/status/brief.md", markers)).toEqual(["status"]);
  });

  it("aborts on the first private case it is asked to write", () => {
    expect(() => assertNoPrivate([{ id: "x", repo: "o/titan-platform", body: { p: "active-work/garden-plans/tasks" } }], policy)).toThrow(/private-marker/);
  });

  it("joins a task only from an engineering initiative", () => {
    expect(engineeringInitiativeOf("CC-12")).toBe("claude-channels");
    expect(engineeringInitiativeOf("GDN-3")).toBeUndefined();
  });
});
