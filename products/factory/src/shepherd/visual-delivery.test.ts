import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import type { RosterRead } from "./roster.js";
import { deliverGate, deliveryFileFor, type DeliveryGate, type DeliveryWorld, type VisualDeliveryPorts } from "./visual-delivery.js";
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

/** A packet dir with packet.json and, unless `prose` is false, prose.json; every exec answers from `replies` by verb. */
function scenario(options: { prose?: boolean; roster?: RosterRead; replies?: Partial<Record<"round" | "lint" | "import", Reply>>; mode?: "shadow" | "on"; now?: number } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "visual-delivery-"));
  const dir = packetDirFor(stateDir, RUN, H);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "packet.json"), JSON.stringify({ packetId: "pkt-1" }));
  if (options.prose !== false) writeFileSync(join(dir, "prose.json"), "{}");
  const calls: string[][] = [];
  const replies = { round: { status: 0 }, lint: { status: 0, stdout: CLEAN }, import: { status: 0, stdout: IMPORTED }, ...options.replies };
  const ports: VisualDeliveryPorts = {
    mode: options.mode ?? "on", stateDir, titanReviewBin: BIN, console: CONSOLE, cwdFor: () => stateDir, now: () => options.now ?? 2_000, readyTimeoutMs: 10_000,
    roster: { read: async () => options.roster ?? { kind: "known", rows: [] }, rows: async () => [], invalidate: () => undefined },
    exec: async (argv) => {
      calls.push([...argv]);
      const reply: Reply = argv.includes("import") ? replies.import : argv.includes("lint") ? replies.lint : replies.round;
      return { status: reply.status, stdout: typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout ?? ""), stderr: reply.stderr ?? "" };
    },
  };
  const file = deliveryFileFor(stateDir, RUN, H);
  return { ports, calls, dir, file, record: () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> };
}

const verbs = (calls: string[][]) => calls.map((argv) => argv.find((arg) => ["round", "lint", "import"].includes(arg)));
const world = (heads: string[] = [H], pending = true): DeliveryWorld => ({ pr: async () => ({ repo: "octo/demo", headSha: heads.shift() ?? H, open: true }), pending: () => pending });
const row = (name: string): AgentRow => ({ name, agentId: "a", state: "live", presence: "live", status: "running", profile: "review-packager", surface: "headless", cwd: "/srv/synthetic-owner", sessionId: "", generation: 1 });

describe("deliverGate", () => {
  it("rounds, lints, then imports a finished packet with the configured absolute paths and records it 0600", async () => {
    const { ports, calls, dir, file, record } = scenario();
    await expect(deliverGate(ports, world(), GATE, signal)).resolves.toEqual({ gateId: GATE.gateId, state: "imported" });
    expect(verbs(calls)).toEqual(["round", "lint", "import"]);
    expect(calls[1]).toEqual([BIN, "packet", "lint", dir, "--gate-head", H, "--require", "prose,round", "--clone", ports.stateDir, "--json"]);
    expect(calls[2]).toEqual([...CONSOLE, "rounds", "import", dir, "--json"]);
    expect(record()).toMatchObject({ state: "imported", packetId: "pkt-1", roundId: "demo-pr7-r1", url: IMPORTED.url, lanUrl: null });
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
    expect(record()).toMatchObject({ state: "imported", created: false });
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
