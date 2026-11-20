import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DaemonHandle } from "@titan-design/daemon";
import { depositItemId, type OwnerItem } from "@titan-design/owner-queue";
import { writeDeposit } from "@titan-design/owner-queue/spool";
import { LINEAR_WORK_LIMIT, callMeter, linearWork } from "@titan-design/test-kit";
import { BLOCKED_AGENT_AFTER_MS, STALLED_RUN_AFTER_MS } from "./inbox-derived.js";
import { actionFor, inboxItems } from "./inbox-view.js";
import { ASKER, byId, FACTORY_ITEMS, fixtureFactory, gate, HEAD, item, MINUTE, okEnvelope, REPO, ROWS, row, RUN_G10, RUN_GONE, RUN_OWNER, RUN_PLAIN, TOKEN, useInboxViewWorld, type World } from "./inbox-view.test-helpers.js";
import { closedPort, send, startFakeBroker, type FakeBroker, type FakeDaemon, type RpcAnswer } from "./test-support.js";

let dir: string;
let factory: FakeDaemon | undefined;
let broker: FakeBroker;
let handle: DaemonHandle | undefined;

const world: World = {
  get dir() {
    return dir;
  },
  set dir(value) {
    dir = value;
  },
  get factory() {
    return factory;
  },
  set factory(value) {
    factory = value;
  },
  get broker() {
    return broker;
  },
  set broker(value) {
    broker = value;
  },
  get handle() {
    return handle;
  },
  set handle(value) {
    handle = value;
  },
};

const ROWLESS_GATE = "no live Shepherd row pins this gate's PR and head";

const { writeShipRound, writeImpostorDeposit, listInbox, serveFactory } = useInboxViewWorld(world);

describe("inbox.list on a fixture factory", () => {
  it("counts the planning items in the default view and lists only the blocking ones", async () => {
    await writeShipRound("ship-r1", new Date("2026-10-10T01:00:00.000Z"));

    const list = await listInbox(await serveFactory(fixtureFactory), {});

    expect(list.planningCount).toBe(3);
    expect(list.items.map((each) => each.section)).not.toContain("planning");
    expect(list.items.map((each) => each.id)).toContain("round:ship-r1/ship");
  });

  it("serves a second read inside the fresh window from the factory read it kept", async () => {
    let needsReads = 0;
    const counted: RpcAnswer = (command, args) => {
      if (command === "needs.list") needsReads += 1;
      return fixtureFactory(command, args);
    };
    await listInbox(await serveFactory(counted));

    const reply = await send("127.0.0.1", handle!.port, "POST", "/rpc/inbox.list", { host: `127.0.0.1:${handle!.port}`, "content-type": "application/json", "x-titan-client": "test" }, "{}");

    expect(okEnvelope.parse(JSON.parse(reply.body)).data.gaps).toEqual([]);
    expect(needsReads).toBe(1);
  });

  it("joins each gate on a live PR to its gate strip at that head", async () => {
    const reads: unknown[] = [];
    const gated: RpcAnswer = (command, args) => {
      if (command === "shepherd.timeline") return { row: ROWS.find((each) => each.pr === args["pr"]), entries: [{ kind: "event", event: "hold", reason: "g10-review: opus review at head", actor: "shepherd", at: "2026-10-10T01:00:00.000Z", headSha: HEAD }] };
      if (command === "shepherd.waiting") return { owner: [], seat: [] };
      if (command === "shepherd.ghRead") {
        reads.push(args["path"]);
        return { status: 200, body: { total_count: 1, check_runs: [{ name: "build", status: "in_progress", conclusion: null }] }, at: "2026-10-10T01:00:00.000Z", stale: false, source: "github" };
      }
      return fixtureFactory(command, args);
    };

    const list = await listInbox(await serveFactory(gated));

    expect(byId(list, `gate:${RUN_G10}/approve-merge`)?.gates?.unmet).toEqual([
      { key: "ci:build", label: "CI build (pending)" },
      { key: "hold:g10-review", label: "held: g10-review (0/1 MERGE) by shepherd" },
    ]);
    expect(byId(list, "chat:msg-7")?.gates).toBeUndefined();
    expect(reads).toContain(`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100`);
  });

  it("shows a gate's unreadable sources as unknown unmet rows without failing the list", async () => {
    const list = await listInbox(await serveFactory(fixtureFactory));

    expect(list.gaps).toEqual([]);
    expect(byId(list, `gate:${RUN_PLAIN}/approve-merge`)?.gates?.unmet.map((gate) => gate.key)).toEqual(["unknown:timeline", "unknown:waiting", "unknown:checkRuns"]);
  });

  it("releases an owner-asked hold before the gate it holds is offered", async () => {
    const list = await listInbox(await serveFactory(fixtureFactory));

    expect(byId(list, `gate:${RUN_OWNER}/approve-merge`)).toMatchObject({
      hold: { class: "owner-asked", reason: "owner-asked: wait for me" },
      action: { kind: "owner-release", repo: REPO, pr: 2, headSha: HEAD },
      then: { kind: "resolve-gate", gateId: `${RUN_OWNER}/approve-merge` },
      evidence: `#/shepherd/${encodeURIComponent(`${REPO}#2`)}`,
    });
  });

  it("shows Shepherd being down as a gap and offers its gates on the terminal only", async () => {
    const list = await listInbox(
      await serveFactory((command) => {
        if (command === "needs.list") return { items: FACTORY_ITEMS, gaps: [] };
        throw new Error("shepherd store is locked");
      }),
    );

    expect(list.gaps).toEqual(["shepherd: factory shepherd.list: shepherd store is locked"]);
    expect(list.items.filter((each) => each.sources[0]!.system === "hitl").map((each) => each.action.kind)).toEqual(["terminal", "terminal", "terminal", "terminal"]);
  });

  it("drops a deposit pinned to an old head of a PR Shepherd watches at a newer one", async () => {
    const pinned = (depositId: string, sha: string) =>
      writeDeposit(path.join(dir, "state", "inbox", "deposits"), { depositId, asker: ASKER, kind: "decide", door: "two-way", summary: `Deposit ${depositId}?`, context: "", keys: [`pr:${REPO}#1@${sha}`] });
    await pinned("stale", "a".repeat(40));
    await pinned("current", HEAD);

    const list = await listInbox(await serveFactory(fixtureFactory));

    expect(byId(list, depositItemId(ASKER, "stale"))).toBeUndefined();
    expect(byId(list, depositItemId(ASKER, "current"))).toBeDefined();
  });

  it("lists the console's own deposits and rounds with a gap line per dead leg when the factory is down", async () => {
    await writeShipRound("ship-r1", new Date("2026-10-10T01:00:00.000Z"));
    const depositId = await writeImpostorDeposit();

    const list = await listInbox(await closedPort());

    expect(list.gaps).toHaveLength(2);
    expect(list.gaps.map((gap) => gap.slice(0, gap.indexOf(":")))).toEqual(["factory", "shepherd"]);
    expect(list.items.map((each) => each.id)).toEqual([depositId, "round:ship-r1/ship"]);
    expect(list.derived).toEqual([]);
  });
});

describe("inbox.list's machine-derived rows", () => {
  const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
  const RUN_STALLED = "55555555-0000-4000-8000-000000000005";
  const RUN_FAILED = "66666666-0000-4000-8000-000000000006";
  const stalled = { ...row(RUN_STALLED, 5), phase: "ci", phaseSince: ago(75 * MINUTE), stalled: { reason: "75 min in ci, over the 60 min limit" } };
  const failed = { ...row(RUN_FAILED, 6), phase: "failed", phaseSince: ago(2 * 60 * MINUTE), stalled: { reason: "sh-ci exited 1" } };
  const shepherdByState: RpcAnswer = (command, args) => {
    if (command === "needs.list") return { items: [], gaps: [] };
    if (command === "shepherd.list") return args["state"] === "finished" ? [failed] : [stalled];
    throw new Error(`no fixture for ${command}`);
  };
  const blocked = { name: "relay-worker", workingOn: "EX-3: wire the relay", cwd: "/synthetic/relay", status: "blocked", idleMs: 40 * MINUTE, registeredAt: 1_000 };

  it("lists a stall, a failed run and a blocked agent, each with its evidence and crossed threshold and no action", async () => {
    await broker.close();
    broker = await startFakeBroker({ token: TOKEN, sessions: [blocked], items: [] });

    const list = await listInbox(await serveFactory(shepherdByState));

    expect(list.gaps).toEqual([]);
    expect(list.items).toEqual([]);
    expect(list.derived.map((each) => [each.kind, each.link])).toEqual([
      ["failed-run", `#/shepherd/${encodeURIComponent(`${REPO}#6`)}`],
      ["stalled-run", `#/shepherd/${encodeURIComponent(`${REPO}#5`)}`],
      ["blocked-agent", "#/agents/relay-worker"],
    ]);
    expect(list.derived[0]).toMatchObject({ evidence: { observed: "phase failed: sh-ci exited 1", source: `shepherd row ${RUN_FAILED}`, at: failed.phaseSince }, threshold: { name: "a failed run", limitMs: 0 } });
    expect(list.derived[1]).toMatchObject({ evidence: { observed: "stalled: 75 min in ci, over the 60 min limit", at: stalled.phaseSince }, threshold: { limitMs: STALLED_RUN_AFTER_MS } });
    expect(list.derived[2]).toMatchObject({ evidence: { observed: "presence blocked, silent for 40 min", source: "agent-chat presence" }, threshold: { limitMs: BLOCKED_AGENT_AFTER_MS } });
    expect(list.derived.every((each) => !("action" in each))).toBe(true);
  });

  it("names a dead broker as a gap and still derives Shepherd's rows", async () => {
    await broker.close();

    const list = await listInbox(await serveFactory(shepherdByState));

    expect(list.gaps.map((gap) => gap.slice(0, gap.indexOf(":")))).toEqual(["agents"]);
    expect(list.derived.map((each) => each.kind)).toEqual(["failed-run", "stalled-run"]);
  });
});

describe("actionFor", () => {
  it.each([
    ["device-flash", "a device or hardware gate"],
    ["after-stages", "an after-stages gate"],
  ])("keeps a %s gate on the terminal even with a live row", (step, reason) => {
    const { action } = actionFor(gate(RUN_PLAIN, "2026-10-10T00:00:00.000Z", step), row(RUN_PLAIN, 1));

    expect(action).toMatchObject({ kind: "terminal", command: `titan-factory gate resolve ${RUN_PLAIN} ${step} --json '<payload>'` });
    expect(action.kind === "terminal" && action.reason.startsWith(reason)).toBe(true);
  });

  it("answers a repeated approve-merge gate (`:<n>`) as the merge gate", () => {
    const repeated = item(`gate:${RUN_PLAIN}/approve-merge:2`, { sources: [{ system: "hitl", ref: `${RUN_PLAIN}/approve-merge:2` }] });

    expect(actionFor(repeated, row(RUN_PLAIN, 1)).action).toMatchObject({ kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge:2`, stepId: "approve-merge" });
  });

  it("taps an sh-sent-back gate offering await-new-head and abandon with await-new-head alone", () => {
    const offered = [
      { id: "await-new-head", label: "Wait for a new head" },
      { id: "abandon", label: "Abandon the PR" },
    ];
    const sentBack = { ...gate(RUN_PLAIN, "2026-10-10T00:00:00.000Z", "sh-sent-back"), options: offered };

    const { action } = actionFor(sentBack, row(RUN_PLAIN, 1));

    expect(action).toEqual({ kind: "resolve-gate", gateId: `${RUN_PLAIN}/sh-sent-back`, runId: RUN_PLAIN, stepId: "sh-sent-back", repo: REPO, pr: 1, headSha: HEAD, decision: "await-new-head" });
  });

  it("keeps an sh-sent-back gate whose options lack await-new-head on the terminal", () => {
    const offered = [
      { id: "abandon", label: "Abandon the PR" },
      { id: "waive-proof", label: "Waive the fix-proof" },
    ];
    const sentBack = { ...gate(RUN_PLAIN, "2026-10-10T00:00:00.000Z", "sh-sent-back"), options: offered };

    const { action } = actionFor(sentBack, row(RUN_PLAIN, 1));

    expect(action).toMatchObject({ kind: "terminal", command: `titan-factory gate resolve ${RUN_PLAIN} sh-sent-back --json '<payload>'` });
  });

  it("points an agent's approval request at its broker row, which inbox.prepare reads back", () => {
    const approval = item("chat:msg-8", { sources: [{ system: "agent-chat", ref: "msg-8" }], kind: "approve" });

    expect(actionFor(approval, undefined).action).toEqual({ kind: "approve-chat", msgId: "msg-8" });
  });

  it("taps a gate on a replay-diverged run at its row's head, since the diverged sweep merges on that answer", () => {
    const diverged = { ...row(RUN_PLAIN, 1), stalled: { reason: "replay diverged: step sh-await-verdict:2 changed" } };

    const { action } = actionFor(gate(RUN_PLAIN, "2026-10-10T00:00:00.000Z"), diverged);

    expect(action).toEqual({ kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge`, runId: RUN_PLAIN, stepId: "approve-merge", repo: REPO, pr: 1, headSha: HEAD, decision: "merge" });
  });

  it("keeps a rowless gate on the terminal with its command, even a land run's whose prompt names its head", () => {
    const land = { ...gate(RUN_GONE, "2026-10-10T00:00:00.000Z"), context: `Merge PR #9 in ${REPO} at head ${HEAD}? CI is green. Policy land/default: owner gate` };

    const { action } = actionFor(land, undefined);

    expect(action).toEqual({ kind: "terminal", reason: ROWLESS_GATE, command: `titan-factory gate resolve ${RUN_GONE} approve-merge --json '<payload>'` });
    expect(action.kind === "terminal" && action.reason).not.toMatch(/Morning/);
  });
});

describe("a deposit's typed op", () => {
  const deposited = (op: OwnerItem["op"], overrides: Partial<OwnerItem> = {}): OwnerItem =>
    item(`deposit:${op?.kind ?? "none"}`, { sources: [{ system: "deposit", ref: `${ASKER}/${op?.kind ?? "none"}` }], kind: "do", asker: ASKER, command: "titan-factory shepherd waiting", ...(op && { op }), ...overrides });
  const mergeOp = { kind: "merge-at-head", repo: REPO, pr: 7, headSha: HEAD } as const;

  it("becomes an owner-op tap when its kind is on the console's op allowlist", () => {
    expect(actionFor(deposited(mergeOp), undefined).action).toEqual({ kind: "owner-op", op: mergeOp });
  });

  it("becomes an owner-op tap for a close-pr", () => {
    const closeOp = { kind: "close-pr", repo: REPO, pr: 7, headSha: HEAD } as const;

    expect(actionFor(deposited(closeOp), undefined).action).toEqual({ kind: "owner-op", op: closeOp });
  });

  it("becomes an owner-op tap for a deploy-pause-clear", () => {
    const pauseOp = { kind: "deploy-pause-clear", pausedAt: "2026-10-18T12:00:00.000Z", target: "f".repeat(40) } as const;

    expect(actionFor(deposited(pauseOp), undefined).action).toEqual({ kind: "owner-op", op: pauseOp });
  });

  it("stays on the terminal for a kind with no console tap yet", () => {
    const { action } = actionFor(deposited({ kind: "factory-config-set", path: "shepherd.spawnGate.load5", value: 4 }), undefined);

    expect(action.kind === "terminal" && action.reason).toBe("a factory-config-set op has no console tap yet; run its command");
  });

  it("holds a gate op with no live row to the terminal, as a rowless hitl gate is", () => {
    const op = { kind: "resolve-gate", gateId: `${RUN_GONE}/approve-merge`, headSha: HEAD, decision: "merge" } as const;

    const { action } = actionFor(deposited(op), undefined);

    expect(action).toMatchObject({ kind: "terminal", reason: ROWLESS_GATE });
    expect(action.kind === "terminal" && action.reason).not.toMatch(/Morning/);
  });

  it("offers the gate's own tap, never the agent-written refusal, while the gate is open at the deposit's head", () => {
    const op = { kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge`, headSha: HEAD, decision: "merge" } as const;

    const [listed] = inboxItems([deposited(op)], [row(RUN_PLAIN, 1)]);

    expect(listed!.action).toEqual({ kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge`, runId: RUN_PLAIN, stepId: "approve-merge", repo: REPO, pr: 1, headSha: HEAD, decision: "merge" });
  });

  it("offers no tap once the live row's head moved past the deposit's head, and names both heads", () => {
    const op = { kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge`, headSha: "f".repeat(40), decision: "merge" } as const;

    const [listed] = inboxItems([deposited(op)], [row(RUN_PLAIN, 1)]);

    expect(listed!.action).toEqual({ kind: "terminal", reason: `this deposit asks at ffffffff, but the gate now pins ${HEAD.slice(0, 8)}; answer the gate's own item at that head` });
  });

  it("offers no tap once the gate is answered and the row waits on another step", () => {
    const op = { kind: "resolve-gate", gateId: `${RUN_PLAIN}/approve-merge`, headSha: HEAD, decision: "merge" } as const;
    const answered = { ...row(RUN_PLAIN, 1), pendingGate: { gateId: `${RUN_PLAIN}/sh-sent-back`, stepId: "sh-sent-back", since: "2026-10-10T00:00:00.000Z" } };

    const [listed] = inboxItems([deposited(op)], [answered]);

    expect(listed!.action).toEqual({ kind: "terminal", reason: `gate ${RUN_PLAIN}/approve-merge is no longer open on ${REPO}#1; withdraw this deposit` });
  });

  it("maps a hold op onto the live row's release only when the row is held in that class", () => {
    const op = { kind: "release-hold", repo: REPO, pr: 2, headSha: HEAD, holdClass: "owner-asked" } as const;

    const [held] = inboxItems([deposited(op)], [row(RUN_OWNER, 2, "owner-asked: wait for me")]);
    const [other] = inboxItems([deposited(op)], [row(RUN_OWNER, 2, "g10-review: opus review at head")]);

    expect(held!.action).toEqual({ kind: "owner-release", repo: REPO, pr: 2, headSha: HEAD });
    expect(other!.action.kind === "terminal" && other!.action.reason).toBe(`${REPO}#2 is held as g10-review, not owner-asked`);
  });

  it("maps a g10 hold op onto a hold-release for whichever g10 class the row is held in", () => {
    const op = { kind: "release-hold", repo: REPO, pr: 2, headSha: HEAD, holdClass: "g10" } as const;

    const [review] = inboxItems([deposited(op)], [row(RUN_G10, 2, "g10-review: opus review at head")]);
    const [adversary] = inboxItems([deposited(op)], [row(RUN_G10, 2, "g10-adversary: authority change")]);
    const [owner] = inboxItems([deposited(op)], [row(RUN_OWNER, 2, "owner-asked: wait for me")]);

    expect(review!.action).toEqual({ kind: "hold-release", repo: REPO, pr: 2, headSha: HEAD, holdClass: "g10-review" });
    expect(adversary!.action).toMatchObject({ kind: "hold-release", holdClass: "g10-adversary" });
    expect(owner!.action.kind === "terminal" && owner!.action.reason).toBe(`${REPO}#2 is held as owner-asked, not g10`);
  });

  it("shows the live row's g10 hold on a merge-at-head, so the page can offer the approve-and-wait tap beside the forced merge", () => {
    const [held] = inboxItems([deposited({ ...mergeOp, pr: 3 })], [row(RUN_G10, 3, "g10-adversary: authority change")]);
    const [open] = inboxItems([deposited(mergeOp)], [row(RUN_PLAIN, 7)]);

    expect(held).toMatchObject({ action: { kind: "owner-op" }, hold: { class: "g10-adversary", reason: "g10-adversary: authority change" } });
    expect(open).not.toHaveProperty("hold");
  });
});

describe("inbox ordering", () => {
  it("puts the newest blocker first", () => {
    const older = gate(RUN_PLAIN, "2026-10-10T00:00:00.000Z");
    const newer = gate(RUN_G10, "2026-10-10T09:00:00.000Z");

    const items = inboxItems([older, newer], []);

    expect(items.map((each) => each.id)).toEqual([newer.id, older.id]);
  });

  const liveSized = (count: number) => {
    const many = Array.from({ length: count }, (_, n) =>
      n % 3 === 0 ? gate(`${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`, new Date(Date.UTC(2026, 9, 1) + n * 1000).toISOString()) : item(`ask-${n}`, { lens: n % 2 === 0 ? "planning" : "blocking-agent" }),
    );
    const rows = many.filter((_, n) => n % 3 === 0).map((each, n) => row(each.sources[0]!.ref.slice(0, each.sources[0]!.ref.indexOf("/")), n + 1));
    return { many, rows };
  };

  it("orders 3000 live-sized items", () => {
    const { many, rows } = liveSized(3000);

    expect(inboxItems(many, rows)).toHaveLength(3000);
  });

  it("orders live-sized items in work linear in their count", () => {
    // Keying the rows lowercases each run id once and a gate's lookup lowercases its own; a scan of the rows per gate is quadratic.
    const meter = callMeter([[String.prototype, "toLowerCase"]]);
    try {
      const { ratio } = linearWork((size) => {
        const { many, rows } = liveSized(size);
        return () => inboxItems(many, rows);
      }, { from: 48, to: 3072, meter: meter.calls });

      expect(ratio).toBeLessThan(LINEAR_WORK_LIMIT);
    } finally {
      meter.restore();
    }
  });
});
