import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import type { AncestryProbe } from "../build-ancestry.js";
import { readWanted, type WantedStore } from "./deploy-pacer.js";
import { MainWatchLedger } from "./main-watch-ledger.js";
import { sweepMain, watchedRepos, type MainDeploy, type MainWatchDeps } from "./main-watch.js";
import { mainDeployQueue, type DeployerPorts } from "./redeploy.js";
import type { SeatBook } from "./seats.js";

const REPO = "acme/factory";
const OTHER = "acme/widgets";
const T0 = Date.parse("2026-10-17T16:00:00Z");
const MINUTE = 60_000;
const iso = (at: number): string => new Date(at).toISOString();
const BOOK: SeatBook = { seats: [{ name: "alpha-coord", remotes: [OTHER], paths: {}, grants: [] }], denied: [] };

function memoryStore(): WantedStore {
  const files = new Map<string, string>();
  return {
    readFile: (path) => files.get(path),
    writeFile: (path, text) => void files.set(path, text),
    rename: (from, to) => (files.set(to, files.get(from) ?? ""), void files.delete(from)),
    remove: (path) => void files.delete(path),
  };
}

const unused = (): never => {
  throw new Error("the queue path starts no process");
};
const queueOnlyPorts: DeployerPorts = { spawn: unused, mkdir: () => undefined, append: unused, openAppend: unused, close: unused };

interface World {
  fake: FakeGitHub;
  store: WantedStore;
  deploy: MainDeploy;
  clock: { now: number };
  ledger: MainWatchLedger;
}

/** Each later sha in `line` descends from every earlier one, as main's commits do. */
function world(line: readonly string[] = []): World {
  const store = memoryStore();
  const clock = { now: T0 };
  const isAncestor: AncestryProbe = async (ancestor, descendant) => line.indexOf(ancestor) < line.indexOf(descendant);
  const queue = mainDeployQueue({ bin: "/factory/dist/bin.js", stateDir: "/state", isAncestor, now: () => new Date(clock.now) }, queueOnlyPorts, store);
  return { fake: fakeGitHub({ repo: REPO }), store, deploy: { repo: REPO, queue }, clock, ledger: new MainWatchLedger(openDatabase(":memory:")) };
}

function deps(w: World): MainWatchDeps {
  return { port: githubPort(w.fake.wire), ledger: w.ledger, store: { byPr: () => undefined }, seats: () => BOOK, ports: { hubSeat: () => "hub-coord", send: async () => undefined, deploy: w.deploy }, now: () => w.clock.now };
}

function merged(w: World, pr: number, at: number, conclusion: string | undefined): string {
  const sha = fakeSha(`merge-${pr}`);
  w.fake.history.push({ sha, message: `Change ${pr} (#${pr})`, committedAt: iso(at) });
  if (conclusion !== undefined) finish(w, sha, conclusion);
  return sha;
}

const finish = (w: World, sha: string, conclusion: string): void =>
  w.fake.setRuns(sha, [successRun("validate", 1, iso(w.clock.now), conclusion), successRun("dag-check", 2, iso(w.clock.now), conclusion)]);
const queued = (w: World): string | undefined => readWanted("/state", w.store)?.sha;

describe("main CI watch queues a redeploy for every green merge on the factory repo", () => {
  it("queues a seat merge Shepherd never ran, once its main CI is green", async () => {
    const w = world();
    await sweepMain(deps(w), [REPO]);
    const sha = merged(w, 1, T0 + MINUTE, "success");
    w.clock.now = T0 + 5 * MINUTE;

    const notes = await sweepMain(deps(w), [REPO]);

    expect(queued(w)).toBe(sha);
    expect(notes).toMatchObject([{ repo: REPO, sha, outcome: "queued" }]);
  });

  it("queues nothing while main CI is pending or red", async () => {
    const w = world();
    await sweepMain(deps(w), [REPO]);
    merged(w, 1, T0 + MINUTE, undefined);
    merged(w, 2, T0 + 2 * MINUTE, "failure");
    w.clock.now = T0 + 5 * MINUTE;

    await sweepMain(deps(w), [REPO]);

    expect(queued(w)).toBeUndefined();
  });

  it("queues nothing for a green merge on a repo that is not the factory's", async () => {
    const w = world();
    w.fake = fakeGitHub({ repo: OTHER });
    await sweepMain(deps(w), [OTHER]);
    merged(w, 1, T0 + MINUTE, "success");
    w.clock.now = T0 + 5 * MINUTE;

    await sweepMain(deps(w), [OTHER]);

    expect(queued(w)).toBeUndefined();
  });

  it("deploys a seat merge that lands after a Shepherd land, not the land's older sha", async () => {
    const land = fakeSha("merge-1");
    const seatMerge = fakeSha("merge-2");
    const w = world([land, seatMerge]);
    await sweepMain(deps(w), [REPO]);
    await w.deploy.queue(land);
    merged(w, 1, T0 + MINUTE, "success");
    merged(w, 2, T0 + 2 * MINUTE, "success");
    w.clock.now = T0 + 5 * MINUTE;

    await sweepMain(deps(w), [REPO]);

    expect(queued(w)).toBe(seatMerge);
  });

  it("keeps the newer queued sha when an older merge's main CI goes green late", async () => {
    const older = fakeSha("merge-1");
    const newer = fakeSha("merge-2");
    const w = world([older, newer]);
    await sweepMain(deps(w), [REPO]);
    merged(w, 1, T0 + MINUTE, undefined);
    merged(w, 2, T0 + 2 * MINUTE, "success");
    w.clock.now = T0 + 5 * MINUTE;
    await sweepMain(deps(w), [REPO]);
    finish(w, older, "success");
    w.clock.now = T0 + 10 * MINUTE;

    const notes = await sweepMain(deps(w), [REPO]);

    expect(queued(w)).toBe(newer);
    expect(notes).toMatchObject([{ sha: older, outcome: "queued", detail: `kept the queued ${newer}, which contains ${older}` }]);
  });

  it("watches the factory repo though no seat owns it, and lists a seat-owned one once", () => {
    expect(watchedRepos(BOOK, REPO)).toEqual([OTHER, REPO]);
    expect(watchedRepos(BOOK, "ACME/Widgets")).toEqual([OTHER]);
    expect(watchedRepos(BOOK, undefined)).toEqual([OTHER]);
  });

  it("reports a queue that failed, by error class only", async () => {
    const w = world();
    w.deploy = { repo: REPO, queue: async () => Promise.reject(new Error("EACCES: state dir not writable")) };
    await sweepMain(deps(w), [REPO]);
    const sha = merged(w, 1, T0 + MINUTE, "success");
    w.clock.now = T0 + 5 * MINUTE;

    const notes = await sweepMain(deps(w), [REPO]);

    expect(notes).toEqual([{ repo: REPO, sha, outcome: "error", detail: "the redeploy was not queued: Error" }]);
  });
});
