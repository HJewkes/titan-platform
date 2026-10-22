import { POOL_PRIORITY } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { appendEvent } from "../event-log/event-log.js";
import { advanceEpoch, readEpoch } from "../head-guard/epoch-store.js";
import { commit, fakeObserve, OTHER_REPO, REPO, rig } from "./fakes.test-helpers.js";
import { createObserve } from "./observe.js";
import { createReconciler, hasPending, type Observe } from "./service.js";

const ONE_REPO = { repos: [REPO], fullEvery: 3 };
const RESET_MS = 61_000;

const messages = (lines: ReturnType<typeof rig>["lines"], msg: string) => lines.filter((line) => line.msg === msg);

describe("reconciler pool claims (I1)", () => {
  it("sends every GitHub read as a backstop-priority claim of its own call class", async () => {
    const r = rig({ conditionalGates: true });
    const service = createReconciler({ repos: [REPO, OTHER_REPO], fullEvery: 1 }, r.deps);

    await service.tick();
    await service.tick();

    expect(r.claims.length).toBe(r.github.calls.length);
    expect(r.claims.every((claim) => claim.priority === POOL_PRIORITY.backstop)).toBe(true);
    expect(new Set(r.claims.map((claim) => `${claim.kind}:${claim.callClass}`))).toEqual(new Set(["snapshot:graphql", "gates:core-read"]));
  });
});

describe("reconciler refused claims (I6)", () => {
  it("writes nothing and moves no cursor on a refused tick, then the next granted tick catches up once", async () => {
    const r = rig();
    const service = createReconciler(ONE_REPO, r.deps);
    r.github.limited.add("snapshot");

    await service.tick();
    expect(r.rows()).toBe(0);
    expect(r.cursor.read(REPO)).toEqual({});

    r.github.main.unshift(commit("c2"));
    r.github.limited.clear();
    await r.clock.advance(RESET_MS);
    await service.tick();

    expect(r.rows()).toBe(2);
    expect(r.cursor.read(REPO).main?.value).toBe("c2");
  });

  it("refuses itself while the pool holds a pair closed, sending nothing", async () => {
    const r = rig();
    const service = createReconciler({ repos: [REPO, OTHER_REPO], fullEvery: 3 }, r.deps);
    r.github.limited.add("snapshot");

    await service.tick();

    expect(r.github.calls.length).toBe(1);
    expect(messages(r.lines, "reconciler.skipped").map((line) => line.fields.repo)).toEqual([REPO, OTHER_REPO]);
  });

  it("logs reconciler.starved once, on the third consecutive skipped interval, and again only after a grant", async () => {
    const r = rig();
    const service = createReconciler(ONE_REPO, r.deps);
    r.github.limited.add("snapshot");

    await service.tick();
    await service.tick();
    expect(messages(r.lines, "reconciler.starved")).toEqual([]);
    await service.tick();
    await service.tick();
    expect(messages(r.lines, "reconciler.starved")).toEqual([{ level: "warn", msg: "reconciler.starved", fields: { repo: REPO, since: new Date(r.clock.now()).toISOString() } }]);

    r.github.limited.clear();
    await r.clock.advance(RESET_MS);
    await service.tick();
    r.github.limited.add("snapshot");
    for (let tick = 0; tick < 3; tick += 1) await service.tick();

    expect(messages(r.lines, "reconciler.starved").length).toBe(2);
  });
});

describe("reconciler start pass", () => {
  it("forces a repo the pool refused at start on the next granted tick, past quiet gates", async () => {
    const r = rig({ conditionalGates: true });
    const service = createReconciler(ONE_REPO, r.deps);
    r.github.limited.add("snapshot");
    await service.tick();

    r.github.limited.clear();
    await r.clock.advance(RESET_MS);
    await service.tick();

    expect(r.github.count("gates")).toBe(2);
    expect(r.github.count("snapshot")).toBe(2);
    expect(r.cursor.read(REPO).main?.value).toBe("c1");
  });

  it("reads the gates on the start pass, so the next tick sends the ETags it answered", async () => {
    const r = rig({ conditionalGates: true });
    const service = createReconciler(ONE_REPO, r.deps);

    await service.tick();
    await service.tick();

    expect(r.github.calls.filter((call) => call.kind === "gates").map((call) => call.etags)).toEqual([{}, { pulls: '"e1"' }]);
  });
});

describe("reconciler crash before the cursor write (I5)", () => {
  it("re-reads the same range next tick, appends no new row, and then moves the cursor", async () => {
    const r = rig();
    let failWrite = true;
    const cursor = {
      read: r.cursor.read,
      write: (repo: string, next: Parameters<typeof r.cursor.write>[1]) => {
        if (failWrite) throw new Error("crash before the cursor write");
        r.cursor.write(repo, next);
      },
    };
    const service = createReconciler(ONE_REPO, { ...r.deps, cursor });

    await service.tick();
    expect(r.rows()).toBe(1);
    expect(r.cursor.read(REPO)).toEqual({});

    failWrite = false;
    await service.tick();

    expect(r.rows()).toBe(1);
    expect(r.cursor.read(REPO).main?.value).toBe("c1");
    expect(messages(r.lines, "reconciler.confirmed").length).toBe(1);
  });
});

describe("reconciler conditional gates (I10)", () => {
  it("snapshots a quiet repo on the first tick, then skips GraphQL until fullEvery ticks have passed", async () => {
    const r = rig({ conditionalGates: true });
    const service = createReconciler(ONE_REPO, r.deps);
    const perTick: number[] = [];

    for (let tick = 0; tick < 4; tick += 1) {
      const before = r.github.count("snapshot");
      await service.tick();
      perTick.push(r.github.count("snapshot") - before);
    }

    expect(perTick).toEqual([1, 0, 0, 1]);
  });

  it("snapshots on every tick while a gate reports a change or a check is still running", async () => {
    const changed = rig({ conditionalGates: true });
    changed.github.gatesChanged = true;
    const holdsCursor: Observe = (...args) => ({ ...fakeObserve()(...args), cursor: { main: "c0", done: "2027-01-15T07:30:00Z" } });
    const pending = rig({ conditionalGates: true, observe: holdsCursor });
    pending.github.main = [commit("c1", null)];

    for (const r of [changed, pending]) {
      const service = createReconciler(ONE_REPO, r.deps);
      for (let tick = 0; tick < 3; tick += 1) await service.tick();
      expect(r.github.count("snapshot")).toBe(3);
    }
  });

  it("keeps the last landed pass's ETags when a snapshot is refused, so the next gate read reports the change again", async () => {
    const r = rig({ conditionalGates: true });
    const service = createReconciler(ONE_REPO, r.deps);
    await service.tick();
    r.github.gateEtag = '"e2"';
    r.github.gatesChanged = true;
    r.github.limited.add("snapshot");
    await service.tick();

    r.github.limited.clear();
    await r.clock.advance(RESET_MS);
    await service.tick();

    expect(r.github.calls.filter((call) => call.kind === "gates").map((call) => call.etags.pulls)).toEqual([undefined, '"e1"', '"e1"']);
  });

  it("hands observe the ruleset list the gates carried, and none on a pass whose gates carried none", async () => {
    const seen: unknown[] = [];
    const r = rig({ conditionalGates: true, observe: (...args) => (seen.push(args[3]), fakeObserve()(...args)) });
    const list = { notModified: false, unreadable: false, rulesets: { 7: "2027-01-15T07:05:00Z" }, etag: '"r1"' } as const;
    r.github.rulesets = list;
    const service = createReconciler({ repos: [REPO], fullEvery: 1 }, r.deps);

    await service.tick();
    r.github.rulesets = undefined;
    await service.tick();

    expect(seen).toEqual([list, undefined]);
  });

  it("snapshots every tick when no conditional gate is wired yet", async () => {
    const r = rig();
    const service = createReconciler(ONE_REPO, r.deps);

    for (let tick = 0; tick < 3; tick += 1) await service.tick();

    expect(r.github.count("snapshot")).toBe(3);
    expect(r.github.count("gates")).toBe(0);
  });
});

describe("reconciler disagreement log (plan §3)", () => {
  it("writes reconciler.filled for a new occurrence and reconciler.confirmed for one a webhook row holds", async () => {
    const r = rig();
    r.github.main = [commit("c2"), commit("c1")];
    appendEvent(r.db, { rule: "identity", source: "webhook", deliveryId: "webhook:synthetic-1", kind: "CIConcluded", subject: `${REPO}@c1`, keys: {}, occurrenceKey: `v1|CIConcluded|${REPO}|check|1001`, observedAt: "2027-01-15T07:00:00Z", payload: {} });
    const service = createReconciler(ONE_REPO, r.deps);

    await service.tick();

    expect(messages(r.lines, "reconciler.filled").map((line) => line.fields)).toEqual([{ repo: REPO, kind: "CIConcluded", seq: 2 }]);
    expect(messages(r.lines, "reconciler.confirmed").map((line) => line.fields)).toEqual([{ repo: REPO, kind: "CIConcluded", seq: 1, by: "occurrence" }]);
    const sources = r.db.prepare<[], { source: string; delivery_id: string | null }>("SELECT source, delivery_id FROM factory_event ORDER BY seq").all();
    expect(sources).toEqual([{ source: "webhook", delivery_id: "webhook:synthetic-1" }, { source: "backstop", delivery_id: null }]);
  });

  it("writes one reconciler.disagree line per class the observation names", async () => {
    const classes = ["stale-read", "field-parity", "main-ancestry-lost", "unconfirmed"] as const;
    const r = rig({ observe: fakeObserve(classes.map((name) => ({ class: name, subject: `${REPO}#7` }))) });
    const service = createReconciler(ONE_REPO, r.deps);

    await service.tick();

    expect(messages(r.lines, "reconciler.disagree").map((line) => line.fields.class)).toEqual([...classes]);
  });

  it("logs a failed unit and leaves its cursor, without stopping the other repos", async () => {
    const observe: Observe = (...args) => {
      if (args[0] === REPO) throw new Error("synthetic observe failure");
      return fakeObserve()(...args);
    };
    const r = rig({ observe });
    const service = createReconciler({ repos: [REPO, OTHER_REPO], fullEvery: 3 }, r.deps);

    await service.tick();

    expect(messages(r.lines, "reconciler.unit-failed").map((line) => line.fields.repo)).toEqual([REPO]);
    expect(r.cursor.read(REPO)).toEqual({});
    expect(r.cursor.read(OTHER_REPO).main?.value).toBe("c1");
  });
});

describe("reconciler head guard (TP-3097 through TP-3431)", () => {
  const STALE = "a1".padEnd(40, "0");
  const STORED = "a2".padEnd(40, "0");
  const at = "2027-01-15T07:00:00.000Z";

  function openPr(head: string) {
    const r = rig({ observe: createObserve({ now: () => Date.parse("2027-01-15T08:00:00Z") }) });
    advanceEpoch(r.db, { repo: REPO, pr: 7, expectedEpoch: 0, head: STORED, by: "bootstrap", at });
    const pr = { number: 7, headRefOid: head, baseRefName: "main", updatedAt: at, head: null, reviews: [] };
    r.github.snapshot = () => ({ open: [pr], done: [], main: { tip: "c1", commits: [] }, trains: [], rateLimit: { cost: 1, remaining: 4999, resetAt: at, queries: 1 } });
    r.github.remote = (ref) => ("pr" in ref ? STORED : "c1");
    return r;
  }
  const headRows = (r: ReturnType<typeof rig>) => r.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM factory_event WHERE kind = 'HeadPushed' AND subject = '${REPO}#7'`).get()?.n;

  it("appends no head row for a stale read, an ancestor of the stored head, and logs one stale-read", async () => {
    const r = openPr(STALE);
    r.github.ancestry = () => "behind";

    await createReconciler(ONE_REPO, r.deps).tick();

    expect(headRows(r)).toBe(0);
    expect(messages(r.lines, "reconciler.disagree").map((line) => line.fields)).toEqual([{ repo: REPO, class: "stale-read", subject: `${REPO}#7`, detail: STALE }]);
    expect(r.claims.filter((claim) => claim.kind === "ancestry").map((claim) => [claim.callClass, claim.priority])).toEqual([["core-read", POOL_PRIORITY.backstop]]);
  });

  it("appends the head row once the guard confirms a fast-forward, and moves the epoch", async () => {
    const r = openPr("a3".padEnd(40, "0"));

    await createReconciler(ONE_REPO, r.deps).tick();

    expect(headRows(r)).toBe(1);
    expect(readEpoch(r.db, { repo: REPO, pr: 7 })?.epoch).toBe(2);
    expect(messages(r.lines, "reconciler.disagree")).toEqual([]);
  });

  it("leaves a head unconfirmed when the pool refuses its compare", async () => {
    const r = openPr(STALE);
    r.github.limited.add("ancestry");

    await createReconciler(ONE_REPO, r.deps).tick();

    expect(headRows(r)).toBe(0);
    expect(messages(r.lines, "reconciler.disagree").map((line) => line.fields.class)).toEqual(["unconfirmed"]);
  });
});

describe("reconciler cost line (F11)", () => {
  const costs = (r: ReturnType<typeof rig>) => messages(r.lines, "reconciler.cost").map((line) => line.fields);

  it("logs one reconciler.cost per repo per pass: GraphQL points, gate reads, their 304s and the kinds appended", async () => {
    const r = rig({ conditionalGates: true });
    r.github.main = [commit("c2"), commit("c1")];
    const service = createReconciler(ONE_REPO, r.deps);

    await service.tick();
    await service.tick();

    expect(costs(r)).toEqual([
      { repo: REPO, graphqlCost: 1, restCalls: 3, notModified: 3, appended: { CIConcluded: 2 } },
      { repo: REPO, graphqlCost: 0, restCalls: 3, notModified: 3, appended: {} },
    ]);
  });

  it("counts a row a webhook already holds as no append", async () => {
    const r = rig();
    appendEvent(r.db, { rule: "identity", source: "webhook", deliveryId: "webhook:synthetic-1", kind: "CIConcluded", subject: `${REPO}@c1`, keys: {}, occurrenceKey: `v1|CIConcluded|${REPO}|check|1001`, observedAt: "2027-01-15T07:00:00Z", payload: {} });

    await createReconciler(ONE_REPO, r.deps).tick();

    expect(costs(r)).toEqual([{ repo: REPO, graphqlCost: 1, restCalls: 0, notModified: 0, appended: {} }]);
  });

  it("still logs a pass the pool refused, and one whose unit failed, each as spending what it sent", async () => {
    const observe: Observe = (...args) => {
      if (args[0] === OTHER_REPO) throw new Error("synthetic observe failure");
      return fakeObserve()(...args);
    };
    const r = rig({ observe });
    r.github.limited.add("snapshot");
    const service = createReconciler({ repos: [REPO, OTHER_REPO], fullEvery: 3 }, r.deps);
    await service.tick();
    r.github.limited.clear();
    await r.clock.advance(RESET_MS);

    await service.tick();

    expect(costs(r).map(({ repo, graphqlCost }) => [repo, graphqlCost])).toEqual([
      [REPO, 0],
      [OTHER_REPO, 0],
      [REPO, 1],
      [OTHER_REPO, 1],
    ]);
  });

  it("counts the head guard's compare as a REST read", async () => {
    const at = "2027-01-15T07:00:00.000Z";
    const r = rig({ observe: createObserve({ now: () => Date.parse("2027-01-15T08:00:00Z") }) });
    advanceEpoch(r.db, { repo: REPO, pr: 7, expectedEpoch: 0, head: "a2".padEnd(40, "0"), by: "bootstrap", at });
    const pr = { number: 7, headRefOid: "a3".padEnd(40, "0"), baseRefName: "main", updatedAt: at, head: null, reviews: [] };
    r.github.snapshot = () => ({ open: [pr], done: [], main: { tip: "c1", commits: [] }, trains: [], rateLimit: { cost: 4, remaining: 4990, resetAt: at, queries: 2 } });

    await createReconciler(ONE_REPO, r.deps).tick();

    expect(costs(r)).toEqual([{ repo: REPO, graphqlCost: 4, restCalls: 1, notModified: 0, appended: { BaseChanged: 1, HeadPushed: 1, MainMoved: 1 } }]);
  });
});

describe("hasPending", () => {
  it("counts a running check or a pending status, never a finished one", () => {
    const snapshot = (contexts: Parameters<typeof hasPending>[0]["main"]["commits"][number]["contexts"]) => ({ open: [], done: [], main: { tip: "c1", commits: [{ oid: "c1", contexts }] }, trains: [], rateLimit: { cost: 1, remaining: 1, resetAt: "", queries: 1 } });

    expect(hasPending(snapshot(commit("c1", null).contexts))).toBe(true);
    expect(hasPending(snapshot([{ kind: "status", context: "deploy", state: "PENDING", createdAt: "2027-01-15T07:00:00Z" }]))).toBe(true);
    expect(hasPending(snapshot([...commit("c1").contexts, { kind: "status", context: "deploy", state: "SUCCESS", createdAt: "2027-01-15T07:00:00Z" }]))).toBe(false);
  });
});
