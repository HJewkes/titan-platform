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
import type { GateReads, ShepherdServices } from "./services.js";
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

  it("refuses url tailnet without origins.tailnet, and falls back to digest.push only when visualDelivery has none", () => {
    const parse = (visualDelivery: object) => FactoryConfigSchema.safeParse({ shepherd: { agentChatBin: "/srv/a", visualDelivery: { mode: "on", console: CONSOLE, ...visualDelivery } } }).success;
    expect(parse({ url: "tailnet", origins: { lan: "http://lan.example.test" } })).toBe(false);
    expect(parse({ url: "tailnet", origins: { lan: "http://lan.example.test", tailnet: "https://tail.example.test" } })).toBe(true);
    const own = { url: "https://ntfy.example.test/own" };
    const digestPush = { url: "https://ntfy.example.test/digest" };
    const config = (extra: object) => shepherdOf({ visualDelivery: { mode: "on", console: CONSOLE, ...extra } });
    expect(deliveryPortsOf(config({}), {}, roster, () => undefined, { digestPush })?.push).toEqual(digestPush);
    expect(deliveryPortsOf(config({ push: own }), {}, roster, () => undefined, { digestPush })?.push).toEqual(own);
    expect(deliveryPortsOf(config({}), {}, roster, () => undefined)?.push).toBeUndefined();
  });

  it("execs the configured titanReviewBin and console argv, never a bare name", async () => {
    const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "visual-delivery-cfg-")) };
    const calls: string[][] = [];
    const lint = { schema: "titan-review/packet-lint@1", ok: true, packetId: "pkt-1", problems: [] };
    const report = { id: "demo-pr7-r1", created: true, frames: 2, url: "http://127.0.0.1:7500/#/rounds/demo-pr7-r1", lanUrl: null };
    const exec = async (argv: readonly string[]) => (calls.push([...argv]), { status: 0, stdout: JSON.stringify(argv.includes("lint") ? lint : report), stderr: "" });
    const ports = deliveryPortsOf(shepherdOf({ titanReviewBin: BIN, visualDelivery: { mode: "on", console: CONSOLE } }), env, roster, () => env.XDG_STATE_HOME, { exec })!;
    const head = fakeSha("cfg-head");
    const dir = packetDirFor(ports.stateDir, "run-1", head);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "packet.json"), JSON.stringify({ packetId: "pkt-1" }));
    writeFileSync(join(dir, "prose.json"), "{}");
    const world = { pr: async () => ({ repo: "octo/demo", pr: 7, headSha: head, open: true }), pending: () => true, resolvedVia: () => undefined };
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
    const reads: GateReads = { pendingGates: () => gates, gate: () => partialFake<GateRecord>({ status: "pending" }) };
    const services = partialFake<ShepherdServices>({ store: partialFake<ShepherdServices["store"]>({ get: () => partialFake<ReturnType<ShepherdServices["store"]["get"]>>({ byRun: () => undefined }) }) });
    const exec = async () => ({ status: 0, stdout: "", stderr: "" });
    const watch = visualDeliveryWatch({ mode: "shadow", stateDir, titanReviewBin: BIN, console: CONSOLE, roster, cwdFor: () => stateDir, exec, now: Date.now, readyTimeoutMs: 60_000 }, 30_000);
    await watch.tick(reads, services, consoleLogger, new AbortController().signal);
    expect(watch.status()).toEqual({ waiting: 1, failed: [{ gateId: "run-fail/approve-merge", reason: "packet-incomplete" }] });
  });
});

describe("the delivery sweep at an owner's ask to accept regenerated baselines", () => {
  it("delivers the packet of the red head the accept gate pins, as at a visual land gate", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "visual-delivery-accept-"));
    const head = fakeSha("accept-red");
    mkdirSync(packetDirFor(stateDir, "run-accept", head), { recursive: true });
    const text = `Accept the regenerated baselines of PR #7 in octo/demo at head ${head}? CI is red only on visual.`;
    const gate = partialFake<GateRecord>({ id: "run-accept/sh-visual-accept", prompt: text, status: "pending", createdAt: new Date().toISOString() });
    const reads: GateReads = { pendingGates: () => [{ runId: "run-accept", stepId: "sh-visual-accept", gate }], gate: () => gate };
    const services = partialFake<ShepherdServices>({ store: partialFake<ShepherdServices["store"]>({ get: () => partialFake<ReturnType<ShepherdServices["store"]["get"]>>({ byRun: () => undefined }) }) });
    const exec = async () => ({ status: 0, stdout: "", stderr: "" });
    const watch = visualDeliveryWatch({ mode: "shadow", stateDir, titanReviewBin: BIN, console: CONSOLE, roster, cwdFor: () => stateDir, exec, now: Date.now, readyTimeoutMs: 60_000 }, 30_000);

    await watch.tick(reads, services, consoleLogger, new AbortController().signal);

    expect(watch.status()).toEqual({ waiting: 1, failed: [] });
  });
});
