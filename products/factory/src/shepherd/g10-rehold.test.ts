import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { shepherdEventMigration } from "./events.js";
import { g10ReholdRoutes } from "./g10-rehold.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";
import type { Git, GitResult } from "./tree-carry.js";

const REPO = "octo/demo";
const REVIEWED = fakeSha("reviewed");
const MOVED = fakeSha("moved");
const MAIN = fakeSha("main-tip");
const MERGED_TREE = fakeSha("merge-tree");
const ADVERSARY = "g10-adversary: trust rule (security); TP-1";

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

/** How the moved head came to be: a clean merge of main, a merge whose conflict was resolved by hand, or a plain fix push. */
type Shape = "clean" | "conflict-resolved" | "fix-push";

function scriptedGit(shape: Shape): Git {
  return async (_dir, args) => {
    const [command] = args;
    if (command === "rev-list") return ok(shape === "fix-push" ? `${args.at(-1)} ${REVIEWED}` : `${args.at(-1)} ${REVIEWED} ${MAIN}`);
    if (command === "merge-tree") return ok(`${MERGED_TREE}\n`);
    if (command === "rev-parse") return ok(shape === "conflict-resolved" ? fakeSha("resolved-tree") : MERGED_TREE);
    return ok();
  };
}

/** A run whose seat released a g10-adversary hold at REVIEWED, with the PR now at `head`. */
function rig(shape: Shape, head = MOVED) {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16)]);
  const ref = shepherdStoreRef();
  ref.bind(db);
  const store = ref.get();
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: head });
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: { ...OWNER_GATE_POLICY, seat: "trusted-seat" } });
  store.hold("run-1", ADVERSARY);
  store.release("run-1", { headSha: REVIEWED });
  const deps = { port: githubPort(fake.wire), store: ref, now: () => 0 };
  const [route] = g10ReholdRoutes(deps, { git: scriptedGit(shape) });
  const run = async (input: { head: string; cleared?: string[] }) => {
    const result = await route!.runner.run({ prompt: JSON.stringify({ runId: "run-1", repo: REPO, pr, cleared: [], ...input }), signal: new AbortController().signal } as never);
    if (!result.ok) throw new Error(result.error);
    return (JSON.parse(result.output) as { result: { reheld: boolean; reason?: string; seat?: string; clear?: boolean } }).result;
  };
  return { store, run };
}

describe("a g10-adversary hold the seat released", () => {
  it("is re-held with an event naming both heads when a fix round pushes", async () => {
    const { store, run } = rig("fix-push");

    const result = await run({ head: MOVED });

    expect(result).toMatchObject({ reheld: true, seat: "trusted-seat" });
    expect(store.byRun("run-1")).toMatchObject({ held: true });
    expect(store.byRun("run-1")?.holdReason).toContain(`from ${REVIEWED} to ${MOVED}`);
    expect(store.eventsOf("run-1").at(-1)).toMatchObject({ kind: "hold", actor: "shepherd", headSha: MOVED });
  });

  it("is re-held when a merge-up's conflicts were resolved by hand", async () => {
    const { store, run } = rig("conflict-resolved");

    expect(await run({ head: MOVED })).toMatchObject({ reheld: true });
    expect(store.byRun("run-1")?.held).toBe(true);
  });

  it("stays released across a clean merge-up whose tree is the merge-tree of its parents", async () => {
    const { store, run } = rig("clean");

    expect(await run({ head: MOVED })).toEqual({ reheld: false, clear: true });
    expect(store.byRun("run-1")?.held).toBe(false);
  });

  it("stays released at the head it was released at, and at a head already shown clean", async () => {
    const { store, run } = rig("fix-push", REVIEWED);

    expect(await run({ head: REVIEWED })).toEqual({ reheld: false });
    expect(await run({ head: MOVED, cleared: [MOVED] })).toEqual({ reheld: false });
    expect(store.byRun("run-1")?.held).toBe(false);
  });

  it("is not re-held again once it is held", async () => {
    const { store, run } = rig("fix-push");
    await run({ head: MOVED });
    const holds = store.eventsOf("run-1").length;

    expect(await run({ head: fakeSha("moved-again") })).toEqual({ reheld: false });
    expect(store.eventsOf("run-1")).toHaveLength(holds);
  });

  it("ignores a release of another hold class", async () => {
    const { store, run } = rig("fix-push");
    store.hold("run-1", "g10-review: auth change");
    store.release("run-1", { headSha: REVIEWED });

    expect(await run({ head: MOVED })).toEqual({ reheld: false });
  });
});

