import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase } from "@titan-design/store-sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAIN_WATCH_DB, MainWatchLedger } from "./main-watch-ledger.js";
import { MAIN_WATCH_WINDOW_MS, prNumberOf, seatByPrefix, sweepMain, type MainWatchDeps } from "./main-watch.js";
import type { SeatBook } from "./seats.js";
import type { Registration } from "./store.js";

const REPO = "acme/widgets";
const T0 = Date.parse("2026-09-20T10:00:00Z");
const MINUTE = 60_000;
const iso = (at: number): string => new Date(at).toISOString();
const merge = (pr: number): string => fakeSha(`merge-${pr}`);

const BOOK: SeatBook = {
  seats: [
    { name: "alpha-coord", remotes: [REPO], paths: {}, grants: [] },
    { name: "beta-coord", remotes: [REPO], paths: {}, grants: [] },
  ],
  denied: [],
};

interface Sent {
  seat: string;
  text: string;
}

interface World {
  fake: FakeGitHub;
  sent: Sent[];
  registrations: Map<number, Registration>;
  clock: { now: number };
  /** Fails this many sends before one goes through. */
  failSends: { count: number };
}

function world(): World {
  return { fake: fakeGitHub({ repo: REPO }), sent: [], registrations: new Map(), clock: { now: T0 }, failSends: { count: 0 } };
}

function depsOver(w: World, ledger: MainWatchLedger, hubSeat: string | undefined = "hub-coord"): MainWatchDeps {
  return {
    port: githubPort(w.fake.wire),
    ledger,
    store: { byPr: (_repo, pr) => w.registrations.get(pr) },
    seats: () => BOOK,
    ports: {
      hubSeat: () => hubSeat,
      send: async (seat, text) => {
        if (w.failSends.count-- > 0) throw new Error("broker down");
        w.sent.push({ seat, text });
      },
    },
    now: () => w.clock.now,
  };
}

function registration(fields: Pick<Registration, "implementer" | "policy">): Registration {
  return { repo: REPO, pr: 2, branch: null, runId: "run-2", task: "T/X-1", reviewer: null, kind: "feature", slice: null, held: false, holdReason: null, holdReviewer: null, holdSatisfied: null, releaseReady: null, createdAt: iso(T0), updatedAt: iso(T0), ...fields };
}

const memoryLedger = (): MainWatchLedger => new MainWatchLedger(openDatabase(":memory:"));

/** PR `pr` merged onto main at `at`, with required jobs `validate` and `dag-check` concluding as given. */
function merged(w: World, pr: number, at: number, conclusions: { validate: string; "dag-check": string } | undefined, headRef = `agent-chat/zz-pr-${pr}`): string {
  const sha = merge(pr);
  w.fake.history.push({ sha, message: `Change ${pr} (#${pr})\n\nbody`, committedAt: iso(at) });
  w.fake.addPr({ number: pr, headSha: fakeSha(`head-${pr}`), headRef, state: "closed", merged: true, mergeSha: sha });
  if (conclusions) w.fake.setRuns(sha, [successRun("validate", pr * 10, iso(at), conclusions.validate), successRun("dag-check", pr * 10 + 1, iso(at), conclusions["dag-check"])]);
  return sha;
}

async function sweep(w: World, ledger: MainWatchLedger, hubSeat?: string) {
  return sweepMain(depsOver(w, ledger, hubSeat), [REPO]);
}

describe("main CI watch", () => {
  it("stays silent when main CI goes green after a merge, and on every later sweep", async () => {
    const w = world();
    const ledger = memoryLedger();
    await sweep(w, ledger);
    w.clock.now = T0 + 5 * MINUTE;
    merged(w, 1, T0 + MINUTE, { validate: "success", "dag-check": "success" });

    const notes = [...(await sweep(w, ledger)), ...(await sweep(w, ledger))];

    expect(w.sent).toEqual([]);
    expect(notes).toEqual([]);
    expect(ledger.inState(REPO, "green").map((row) => row.sha)).toEqual([merge(1)]);
  });

  it("sends one event, with the failing job and the sha, to the seat a Shepherd run names", async () => {
    const w = world();
    const ledger = memoryLedger();
    await sweep(w, ledger);
    const sha = merged(w, 2, T0 + MINUTE, { validate: "failure", "dag-check": "success" });
    w.registrations.set(2, registration({ implementer: "zz-impl", policy: { merge: "auto", mergeMethod: "squash", fixer: false, seat: "beta-coord" } }));
    w.clock.now = T0 + 5 * MINUTE;

    await sweep(w, ledger);
    await sweep(w, ledger);

    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.seat).toBe("beta-coord");
    expect(w.sent[0]!.text).toContain(`main CI is red on ${REPO} at ${sha} after PR #2. Failing: validate.`);
  });

  it("sends a seat-merge with no run to the seat whose initials prefix the PR's agent branch", async () => {
    const w = world();
    const ledger = memoryLedger();
    await sweep(w, ledger);
    merged(w, 3, T0 + MINUTE, { validate: "success", "dag-check": "failure" }, "agent-chat/ac-fix-the-parser");
    w.clock.now = T0 + 5 * MINUTE;

    const notes = await sweep(w, ledger);

    expect(w.sent.map((sent) => sent.seat)).toEqual(["alpha-coord"]);
    expect(w.sent[0]!.text).toContain("Failing: dag-check.");
    expect(notes).toMatchObject([{ outcome: "sent", seat: "alpha-coord", sha: merge(3) }]);
  });

  it("sends a red merge no seat can be mapped to the hub seat", async () => {
    const w = world();
    const ledger = memoryLedger();
    await sweep(w, ledger);
    merged(w, 4, T0 + MINUTE, { validate: "failure", "dag-check": "failure" }, "owner/quick-fix");
    w.clock.now = T0 + 5 * MINUTE;

    await sweep(w, ledger);

    expect(w.sent.map((sent) => sent.seat)).toEqual(["hub-coord"]);
    expect(w.sent[0]!.text).toContain("Failing: validate, dag-check.");
  });

  it("does not send a red event twice across a serve restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "main-watch-")), MAIN_WATCH_DB);
    const w = world();
    const first = MainWatchLedger.open(path);
    await sweep(w, first);
    merged(w, 5, T0 + MINUTE, { validate: "failure", "dag-check": "success" });
    w.clock.now = T0 + 5 * MINUTE;
    await sweep(w, first);
    first.close();

    const second = MainWatchLedger.open(path);
    await sweep(w, second);
    second.close();

    expect(w.sent).toHaveLength(1);
  });

  it("retries a red event whose send failed, after a restart, and sends it once", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "main-watch-")), MAIN_WATCH_DB);
    const w = world();
    const first = MainWatchLedger.open(path);
    await sweep(w, first);
    merged(w, 6, T0 + MINUTE, { validate: "failure", "dag-check": "success" });
    w.clock.now = T0 + 5 * MINUTE;
    w.failSends.count = 1;
    const failed = await sweep(w, first);
    first.close();

    const second = MainWatchLedger.open(path);
    await sweep(w, second);
    await sweep(w, second);
    second.close();

    expect(failed).toMatchObject([{ outcome: "unsent", detail: expect.stringContaining("the next sweep retries") }]);
    expect(w.sent).toHaveLength(1);
  });

  it("raises nothing for a red commit that landed before the watch began", async () => {
    const w = world();
    const ledger = memoryLedger();
    merged(w, 7, T0 - MINUTE, { validate: "failure", "dag-check": "success" });

    await sweep(w, ledger);

    expect(w.sent).toEqual([]);
  });

  it("keeps watching while main CI is still running, then goes quiet once the window passes with no settled run", async () => {
    const w = world();
    const ledger = memoryLedger();
    await sweep(w, ledger);
    merged(w, 8, T0 + MINUTE, undefined);
    w.clock.now = T0 + 5 * MINUTE;
    const running = await sweep(w, ledger);
    w.clock.now = T0 + 5 * MINUTE + MAIN_WATCH_WINDOW_MS + 1;

    const expired = await sweep(w, ledger);

    expect(running).toEqual([]);
    expect(expired).toMatchObject([{ outcome: "expired", sha: merge(8) }]);
    expect(w.sent).toEqual([]);
  });

  it("treats a red made only of cancelled runs as superseded, not red", async () => {
    const w = world();
    const ledger = memoryLedger();
    await sweep(w, ledger);
    merged(w, 9, T0 + MINUTE, { validate: "cancelled", "dag-check": "cancelled" });
    w.clock.now = T0 + 5 * MINUTE;

    await sweep(w, ledger);

    expect(w.sent).toEqual([]);
    expect(ledger.inState(REPO, "cancelled").map((row) => row.sha)).toEqual([merge(9)]);
  });

  it("reports a repo whose main cannot be read and still watches the others", async () => {
    const w = world();
    const ledger = memoryLedger();
    const deps = depsOver(w, ledger);
    const port = { ...deps.port, listDefaultBranchCommits: async (repo: string) => (repo === "acme/broken" ? Promise.reject(new FakeHttpError(502, "bad gateway")) : deps.port.listDefaultBranchCommits(repo, iso(T0))) };

    const notes = await sweepMain({ ...deps, port }, ["acme/broken", REPO]);

    expect(notes).toMatchObject([{ repo: "acme/broken", outcome: "error", detail: expect.stringContaining("502") }]);
  });
});

describe("merge to seat mapping", () => {
  it.each([
    ["Add a widget (#12)", 12],
    ["Merge pull request #34 from acme/agent-chat/ac-x", 34],
    ["Bump version", undefined],
  ])("reads the PR number from %j", (subject, pr) => {
    expect(prNumberOf(subject)).toBe(pr);
  });

  it.each([
    ["agent-chat/ac-tp-1-fix", "alpha-coord"],
    ["bc-impl", "beta-coord"],
    ["agent-chat/zz-other", undefined],
    ["changeset-release/main", undefined],
  ])("maps branch %j to seat %j", (branch, seat) => {
    expect(seatByPrefix(BOOK, branch)).toBe(seat);
  });

  it("names no seat when two seats share the initials", () => {
    const book: SeatBook = { seats: [...BOOK.seats, { name: "acme-crew", remotes: [], paths: {}, grants: [] }], denied: [] };

    expect(seatByPrefix(book, "agent-chat/ac-fix")).toBeUndefined();
  });
});
