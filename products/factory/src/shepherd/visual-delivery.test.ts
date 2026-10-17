import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RosterRead } from "./roster.js";
import { deliverGate, deliveryFileFor, withdrawDelivered, type DeliveryGate, type DeliveryWorld, type VisualDeliveryPorts } from "./visual-delivery.js";
import { packagerName, packetDirFor } from "./visual-packet-trigger.js";

const RUN = "run-visual-1";
const H = fakeSha("visual-head");
const H2 = fakeSha("visual-moved");
const GATE: DeliveryGate = { runId: RUN, gateId: `${RUN}/approve-merge`, headSha: H, openedAt: 1_000 };
const BIN = "/srv/synthetic-owner/.local/bin/titan-review";
const CONSOLE = ["/srv/synthetic-owner/bin/node", "/srv/synthetic-owner/console/apps/console/dist/cli.js"];
const CLEAN = { schema: "titan-review/packet-lint@1", ok: true, packetId: "pkt-1", problems: [] };
const IMPORTED = { id: "demo-pr7-r1", created: true, frames: 2, feedback: "none", url: "http://127.0.0.1:7500/#/rounds/demo-pr7-r1", lanUrl: null };
const signal = new AbortController().signal;

type Reply = { status: number; stdout?: unknown; stderr?: string };
const TOPIC = "https://ntfy.example.test/synthetic-topic-9f2";
const WITHDRAWN = { id: "demo-pr7-r1", outcome: "withdrawn" };

/** A packet dir with packet.json and, unless `prose` is false, prose.json; every exec answers from `replies` by verb. */
function scenario(options: { prose?: boolean; roster?: RosterRead; replies?: Partial<Record<"round" | "lint" | "import" | "withdraw", Reply>>; mode?: "shadow" | "on"; now?: number; push?: boolean; httpStatus?: number; extra?: Partial<VisualDeliveryPorts> } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "visual-delivery-"));
  const dir = packetDirFor(stateDir, RUN, H);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "packet.json"), JSON.stringify({ packetId: "pkt-1" }));
  if (options.prose !== false) writeFileSync(join(dir, "prose.json"), "{}");
  const calls: string[][] = [];
  const replies = { round: { status: 0 }, lint: { status: 0, stdout: CLEAN }, import: { status: 0, stdout: IMPORTED }, withdraw: { status: 0, stdout: WITHDRAWN }, ...options.replies };
  const fetched: { url: string; init: RequestInit }[] = [];
  const file = deliveryFileFor(stateDir, RUN, H);
  const sentWhileRecorded: unknown[] = [];
  const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
    fetched.push({ url: String(url), init: init! });
    sentWhileRecorded.push(JSON.parse(readFileSync(file, "utf8")).state);
    return new Response("", { status: options.httpStatus ?? 200 });
  };
  const pushed = options.push === false ? {} : { push: { url: TOPIC, tokenFile: "/srv/synthetic-owner/ntfy-token" }, ntfy: { fetch: fakeFetch, readFile: () => "tok-1\n" } };
  const ports: VisualDeliveryPorts = {
    ...pushed, ...options.extra, mode: options.mode ?? "on", stateDir, titanReviewBin: BIN, console: CONSOLE, cwdFor: () => stateDir, now: () => options.now ?? 2_000, readyTimeoutMs: 10_000,
    roster: { read: async () => options.roster ?? { kind: "known", rows: [] }, rows: async () => [], invalidate: () => undefined },
    exec: async (argv) => {
      calls.push([...argv]);
      const reply: Reply = argv.includes("withdraw") ? replies.withdraw : argv.includes("import") ? replies.import : argv.includes("lint") ? replies.lint : replies.round;
      return { status: reply.status, stdout: typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout ?? ""), stderr: reply.stderr ?? "" };
    },
  };
  return { ports, calls, dir, file, fetched, sentWhileRecorded, record: () => z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, "utf8"))) };
}

const verbs = (calls: string[][]) => calls.map((argv) => argv.find((arg) => ["round", "lint", "import", "withdraw"].includes(arg)));
const world = (heads: string[] = [H], pending = true, via?: string, open = true): DeliveryWorld => ({ pr: async () => ({ repo: "octo/demo", pr: 7, headSha: heads.shift() ?? H, open }), pending: () => pending, resolvedVia: () => via });
const row = (name: string): AgentRow => ({ name, agentId: "a", state: "live", presence: "live", status: "running", profile: "review-packager", surface: "headless", cwd: "/srv/synthetic-owner", sessionId: "", generation: 1 });

describe("deliverGate", () => {
  it("rounds, lints, then imports a finished packet with the configured absolute paths and records it 0600", async () => {
    const { ports, calls, dir, file, record } = scenario();
    await expect(deliverGate(ports, world(), GATE, signal)).resolves.toEqual({ gateId: GATE.gateId, state: "delivered" });
    expect(verbs(calls)).toEqual(["round", "lint", "import"]);
    expect(calls[1]).toEqual([BIN, "packet", "lint", dir, "--gate-head", H, "--require", "prose,round", "--clone", ports.stateDir, "--json"]);
    expect(calls[2]).toEqual([...CONSOLE, "rounds", "import", dir, "--json"]);
    expect(record()).toMatchObject({ state: "delivered", packetId: "pkt-1", roundId: "demo-pr7-r1", url: IMPORTED.url, repo: "octo/demo", pr: 7 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("waits while the packager is on the roster, or when the roster could not be read", async () => {
    for (const roster of [{ kind: "known", rows: [row(packagerName(RUN, H))] }, { kind: "unknown", error: new Error("broker down") }] as RosterRead[]) {
      const { ports, calls } = scenario({ roster });
      await expect(deliverGate(ports, world(), GATE, signal)).resolves.toMatchObject({ state: "waiting" });
      expect(calls).toEqual([]);
    }
  });

  it("cancels on a head that moved between the lint and the import", async () => {
    const { ports, calls, record } = scenario();
    await deliverGate(ports, world([H, H2]), GATE, signal);
    expect(record()).toMatchObject({ state: "cancelled", reason: `new-head:${H2}` });
    expect(verbs(calls)).toEqual(["round", "lint"]);
  });

  it("cancels a gate that no longer waits, though the PR head is still the packet's", async () => {
    const { ports, calls, record } = scenario();
    await deliverGate(ports, world([H], false), GATE, signal);
    expect(record()).toMatchObject({ state: "cancelled", reason: "gate-gone" });
    expect(calls).toEqual([]);
  });

  it("parses exit 3's problems as a lint failure and imports nothing", async () => {
    const problems = [{ rule: "prose-binding", message: "prose.json is for another packetId" }];
    const { ports, calls, record } = scenario({ replies: { lint: { status: 3, stdout: { ...CLEAN, ok: false, problems } } } });
    await deliverGate(ports, world(), GATE, signal);
    expect(record()).toMatchObject({ state: "failed", reason: "lint", problems });
    expect(verbs(calls)).toEqual(["round", "lint"]);
  });

  it("records an exec error for exit 2 or unparseable output", async () => {
    for (const lint of [{ status: 2, stdout: CLEAN, stderr: "usage" }, { status: 0, stdout: "packet lint: clean" }]) {
      const { ports, record } = scenario({ replies: { lint } });
      await deliverGate(ports, world(), GATE, signal);
      expect(record()).toMatchObject({ state: "failed", reason: "lint-error" });
    }
  });

  it("fails a clean lint whose packetId is not packet.json's", async () => {
    const { ports, calls, record } = scenario({ replies: { lint: { status: 0, stdout: { ...CLEAN, packetId: "pkt-other" } } } });
    await deliverGate(ports, world(), GATE, signal);
    expect(record()).toMatchObject({ state: "failed", reason: "lint" });
    expect(verbs(calls)).not.toContain("import");
  });

  it("records shadow with the packetId and never imports", async () => {
    const { ports, calls, record } = scenario({ mode: "shadow" });
    await deliverGate(ports, world(), GATE, signal);
    expect(record()).toMatchObject({ state: "shadow", packetId: "pkt-1" });
    expect(verbs(calls)).toEqual(["round", "lint"]);
  });

  it("runs nothing once recorded, and a crash before the record re-imports idempotently and then records", async () => {
    const { ports, calls, file, record } = scenario({ replies: { import: { status: 0, stdout: { ...IMPORTED, created: false } } } });
    await deliverGate(ports, world(), GATE, signal);
    await deliverGate(ports, world(), GATE, signal);
    expect(verbs(calls).filter((verb) => verb === "import")).toHaveLength(1);
    rmSync(file);
    await deliverGate(ports, world(), GATE, signal);
    expect(record()).toMatchObject({ state: "delivered", roundId: "demo-pr7-r1" });
  });

  it("fails packet-incomplete only once the ready timeout has passed", async () => {
    const at = scenario({ prose: false, now: GATE.openedAt + 10_000 });
    await expect(deliverGate(at.ports, world(), GATE, signal)).resolves.toMatchObject({ state: "waiting" });
    const past = scenario({ prose: false, now: GATE.openedAt + 10_001 });
    await expect(deliverGate(past.ports, world(), GATE, signal)).resolves.toMatchObject({ state: "failed", reason: "packet-incomplete" });
    expect(past.calls).toEqual([]);
  });

  it("refuses a symlinked state file rather than following it", async () => {
    const { ports, calls, file, dir } = scenario();
    writeFileSync(join(dir, "..", "elsewhere.json"), JSON.stringify({ state: "cancelled", reason: "planted" }));
    symlinkSync(join(dir, "..", "elsewhere.json"), file);
    await expect(deliverGate(ports, world(), GATE, signal)).resolves.toMatchObject({ state: "refused", reason: expect.stringContaining("symlink") });
    expect(calls).toEqual([]);
  });

  it("leaves a gate with no packet dir alone", async () => {
    const { ports, calls } = scenario();
    await expect(deliverGate(ports, world(), { ...GATE, headSha: H2 }, signal)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("maps the console's already-imported refusal to import-conflict", async () => {
    const stderr = `import refused: round demo-pr7-r1 is already imported with a different round.json; build round 2`;
    const { ports, record } = scenario({ replies: { import: { status: 65, stderr } } });
    await deliverGate(ports, world(), GATE, signal);
    expect(record()).toMatchObject({ state: "failed", reason: "import-conflict" });
  });

  it("fails no-clone when the repo has no usable checkout", async () => {
    const { ports, calls, record } = scenario();
    await deliverGate({ ...ports, cwdFor: () => undefined }, world(), GATE, signal);
    expect(record()).toMatchObject({ state: "failed", reason: "no-clone" });
    expect(calls).toEqual([]);
  });
});

describe("delivery push", () => {
  it("writes the delivered record, then pushes one line with the token, title, body and click", async () => {
    const { ports, fetched, sentWhileRecorded } = scenario({ extra: { origins: { lan: "http://lan.example.test:7500/" } } });
    await deliverGate(ports, world(), GATE, signal);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.url).toBe(TOPIC);
    expect(fetched[0]!.init.headers).toMatchObject({ Authorization: "Bearer tok-1", Title: "Visual review: octo/demo#7", Click: "http://lan.example.test:7500/#/rounds/demo-pr7-r1" });
    expect(fetched[0]!.init.body).toBe(`2 images at ${H.slice(0, 8)}`);
    expect(sentWhileRecorded).toEqual(["delivered"]);
  });

  it("clicks the tailnet origin when url is tailnet, and the import's own LAN URL when there are no origins", async () => {
    const origins = { lan: "http://lan.example.test:7500", tailnet: "https://tail.example.test" };
    const tail = scenario({ extra: { origins, urlKind: "tailnet" } });
    await deliverGate(tail.ports, world(), GATE, signal);
    expect(tail.fetched[0]!.init.headers).toMatchObject({ Click: "https://tail.example.test/#/rounds/demo-pr7-r1" });
    const lanUrl = "http://lan-import.example.test:7500/#/rounds/demo-pr7-r1";
    const bare = scenario({ replies: { import: { status: 0, stdout: { ...IMPORTED, lanUrl } } } });
    await deliverGate(bare.ports, world(), GATE, signal);
    expect(bare.fetched[0]!.init.headers).toMatchObject({ Click: lanUrl });
  });

  it("records a pushWarning for a failed push and never retries it", async () => {
    const { ports, fetched, record } = scenario({ httpStatus: 500 });
    await deliverGate(ports, world(), GATE, signal);
    await deliverGate(ports, world(), GATE, signal);
    expect(fetched).toHaveLength(1);
    expect(record()).toMatchObject({ state: "delivered", pushWarning: "push failed: HTTP 500" });
  });

  it("delivers with a no push config warning, and sends nothing, when no topic is configured", async () => {
    const { ports, fetched, record } = scenario({ push: false });
    await expect(deliverGate(ports, world(), GATE, signal)).resolves.toMatchObject({ state: "delivered" });
    expect(fetched).toEqual([]);
    expect(record()).toMatchObject({ state: "delivered", pushWarning: "no push config" });
  });

  it("replays an imported record to one push without importing again, then never pushes again", async () => {
    const { ports, calls, fetched, file } = scenario();
    const imported = { state: "imported", packetId: "pkt-1", roundId: "demo-pr7-r1", frames: 2, url: IMPORTED.url, lanUrl: null, repo: "octo/demo", pr: 7 };
    writeFileSync(file, JSON.stringify(imported));
    await deliverGate(ports, world(), GATE, signal);
    await deliverGate(ports, world(), GATE, signal);
    expect(calls).toEqual([]);
    expect(fetched).toHaveLength(1);
  });

  it.each([
    ["a failed lint", { lint: { status: 3, stdout: { ...CLEAN, ok: false, problems: [] } } }, "on" as const],
    ["a failed round", { round: { status: 1, stderr: "boom" } }, "on" as const],
    ["a failed import", { import: { status: 1, stderr: "boom" } }, "on" as const],
    ["shadow mode", {}, "shadow" as const],
  ])("sends no push for %s", async (_name, replies, mode) => {
    const { ports, fetched } = scenario({ replies, mode });
    await deliverGate(ports, world(), GATE, signal);
    expect(fetched).toEqual([]);
  });
});

describe("withdrawDelivered", () => {
  const delivered = async (options: Parameters<typeof scenario>[0] = {}) => {
    const run = scenario(options);
    await deliverGate(run.ports, world(), GATE, signal);
    run.calls.length = 0;
    run.fetched.length = 0;
    return run;
  };
  const withdrawArgs = (reason: string) => [...CONSOLE, "rounds", "withdraw", "demo-pr7-r1", "--reason", reason, "--json"];

  it("withdraws on a new head with the live sha and pushes one line", async () => {
    const run = await delivered();
    await withdrawDelivered(run.ports, world([H2], false), signal);
    expect(run.calls).toEqual([withdrawArgs(`new-head:${H2}`)]);
    expect(run.record()).toMatchObject({ state: "withdrawn", reason: `new-head:${H2}`, outcome: "withdrawn" });
    expect(run.fetched).toHaveLength(1);
    expect(run.fetched[0]!.init.headers).toMatchObject({ Title: "Visual review withdrawn: octo/demo#7" });
    expect(run.fetched[0]!.init.body).toBe(`new head ${H2.slice(0, 8)}`);
  });

  it("withdraws a closed PR with a PR closed line, and runs nothing more on the next tick", async () => {
    const run = await delivered();
    await withdrawDelivered(run.ports, world([H], false, undefined, false), signal);
    await withdrawDelivered(run.ports, world([H], false, undefined, false), signal);
    expect(run.calls).toEqual([withdrawArgs("closed")]);
    expect(run.fetched.map((sent) => sent.init.body)).toEqual(["PR closed"]);
  });

  it("leaves a round alone while its gate waits", async () => {
    const run = await delivered();
    await withdrawDelivered(run.ports, world([H2], true), signal);
    expect(run.calls).toEqual([]);
  });

  it("records a console Ship answer as answered, with no withdraw and no push", async () => {
    const run = await delivered();
    await withdrawDelivered(run.ports, world([H2], false, "console:ship"), signal);
    expect(run.calls).toEqual([]);
    expect(run.fetched).toEqual([]);
    expect(run.record()).toMatchObject({ state: "answered", roundId: "demo-pr7-r1" });
  });

  it("withdraws an answer given elsewhere silently", async () => {
    const run = await delivered();
    await withdrawDelivered(run.ports, world([H], false, "terminal"), signal);
    expect(run.calls).toEqual([withdrawArgs("answered-elsewhere")]);
    expect(run.fetched).toEqual([]);
  });

  it("pushes nothing when the console kept an answered round", async () => {
    const run = await delivered({ replies: { withdraw: { status: 0, stdout: { id: "demo-pr7-r1", outcome: "kept-answered" } } } });
    await withdrawDelivered(run.ports, world([H2], false), signal);
    expect(run.record()).toMatchObject({ state: "withdrawn", outcome: "kept-answered" });
    expect(run.fetched).toEqual([]);
  });

  it("records a failed withdraw with its stderr line and pushes nothing", async () => {
    const run = await delivered({ replies: { withdraw: { status: 65, stderr: "withdraw refused: no round named x\nmore" } } });
    await expect(withdrawDelivered(run.ports, world([H2], false), signal)).resolves.toMatchObject([{ state: "failed", reason: "withdraw" }]);
    expect(run.record()).toMatchObject({ state: "failed", reason: "withdraw", detail: "exit 65: withdraw refused: no round named x" });
    expect(run.fetched).toEqual([]);
  });

  it("does nothing in shadow mode", async () => {
    const run = await delivered();
    await expect(withdrawDelivered({ ...run.ports, mode: "shadow" }, world([H2], false), signal)).resolves.toEqual([]);
    expect(run.calls).toEqual([]);
  });
});
