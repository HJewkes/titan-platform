import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consoleLogger } from "@titan-design/daemon";
import { fakeSha } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { FactoryConfigSchema, type FactoryConfig } from "../config.js";
import type { FactoryHost } from "../host.js";
import type { RosterReader } from "./roster.js";
import type { ShepherdServices } from "./services.js";
import { deliverGate } from "./visual-delivery.js";
import { configuredVisualDelivery, deliveryPortsOf, startVisualDeliverySweep, visualDeliveryWatch } from "./visual-delivery-sweep.js";
import { packetDirFor } from "./visual-packet-trigger.js";

const BIN = "/srv/synthetic-owner/.local/bin/titan-review";
const CONSOLE = ["/srv/synthetic-owner/bin/node", "/srv/synthetic-owner/console/dist/cli.js"];
const roster: RosterReader = { read: async () => ({ kind: "known", rows: [] }), rows: async () => [], invalidate: () => undefined };
const shepherdOf = (extra: object): FactoryConfig["shepherd"] => FactoryConfigSchema.parse({ shepherd: { agentChatBin: "/srv/synthetic-owner/bin/agent-chat", ...extra } }).shepherd;
const prompt = (head: string) => `Merge PR #7 in octo/demo at head ${head}? CI is green. Policy shepherd-merge-guard/visual-path: x`;

describe("visualDelivery config", () => {
  it("starts nothing when visualDelivery is absent or off", () => {
    expect(configuredVisualDelivery(shepherdOf({}), {}, roster, () => undefined)).toBeUndefined();
    expect(configuredVisualDelivery(shepherdOf({ visualDelivery: { mode: "off", console: CONSOLE } }), {}, roster, () => undefined)).toBeUndefined();
    expect(startVisualDeliverySweep(partialFake<FactoryHost>(), partialFake<ShepherdServices>(), consoleLogger)).toBeUndefined();
  });

  it("refuses an empty or relative console argv and a delivery with no agentChatBin", () => {
    const parse = (shepherd: object) => FactoryConfigSchema.safeParse({ shepherd }).success;
    expect(parse({ agentChatBin: "/srv/a", visualDelivery: { mode: "on", console: [] } })).toBe(false);
    expect(parse({ agentChatBin: "/srv/a", visualDelivery: { mode: "on", console: ["node", "cli.js"] } })).toBe(false);
    expect(parse({ visualDelivery: { mode: "shadow", console: CONSOLE } })).toBe(false);
  });

  it("execs the configured titanReviewBin and console argv, never a bare name", async () => {
    const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "visual-delivery-cfg-")) };
    const calls: string[][] = [];
    const lint = { schema: "titan-review/packet-lint@1", ok: true, packetId: "pkt-1", problems: [] };
    const report = { id: "demo-pr7-r1", created: true, url: "http://127.0.0.1:7500/#/rounds/demo-pr7-r1", lanUrl: null };
    const exec = async (argv: readonly string[]) => (calls.push([...argv]), { status: 0, stdout: JSON.stringify(argv.includes("lint") ? lint : report), stderr: "" });
    const ports = deliveryPortsOf(shepherdOf({ titanReviewBin: BIN, visualDelivery: { mode: "on", console: CONSOLE } }), env, roster, () => env.XDG_STATE_HOME, exec)!;
    const head = fakeSha("cfg-head");
    const dir = packetDirFor(ports.stateDir, "run-1", head);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "packet.json"), JSON.stringify({ packetId: "pkt-1" }));
    writeFileSync(join(dir, "prose.json"), "{}");
    const world = { pr: async () => ({ repo: "octo/demo", headSha: head, open: true }), pending: () => true };
    await deliverGate(ports, world, { runId: "run-1", gateId: "run-1/approve-merge", headSha: head, openedAt: 0 }, new AbortController().signal);
    expect(calls.map((argv) => argv[0])).toEqual([BIN, BIN, CONSOLE[0]]);
    expect(calls[2]!.slice(0, 2)).toEqual(CONSOLE);
  });
});

describe("visual delivery health", () => {
  it("counts waiting gates and lists failed ones, leaving a non-visual gate alone", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "visual-delivery-sweep-"));
    const [waiting, failing, plain] = ["wait", "fail", "plain"].map((name) => ({ runId: `run-${name}`, head: fakeSha(name) }));
    for (const gate of [waiting, failing]) mkdirSync(packetDirFor(stateDir, gate!.runId, gate!.head), { recursive: true });
    const gates = [waiting, failing, plain].map((gate) => {
      const createdAt = new Date(gate === failing ? 0 : Date.now()).toISOString();
      return { runId: gate!.runId, stepId: "approve-merge", gate: partialFake<GateRecord>({ id: `${gate!.runId}/approve-merge`, prompt: prompt(gate!.head), status: "pending", createdAt }) };
    });
    const host = partialFake<FactoryHost>({ pendingGates: () => gates, gates: partialFake<FactoryHost["gates"]>({ get: () => partialFake<GateRecord>({ status: "pending" }) }) });
    const services = partialFake<ShepherdServices>({ store: partialFake<ShepherdServices["store"]>({ get: () => partialFake<ReturnType<ShepherdServices["store"]["get"]>>({ byRun: () => undefined }) }) });
    const exec = async () => ({ status: 0, stdout: "", stderr: "" });
    const watch = visualDeliveryWatch({ mode: "shadow", stateDir, titanReviewBin: BIN, console: CONSOLE, roster, cwdFor: () => stateDir, exec, now: Date.now, readyTimeoutMs: 60_000 }, 30_000);
    await watch.tick(host, services, consoleLogger, new AbortController().signal);
    expect(watch.status()).toEqual({ waiting: 1, failed: [{ gateId: "run-fail/approve-merge", reason: "packet-incomplete" }] });
  });
});
