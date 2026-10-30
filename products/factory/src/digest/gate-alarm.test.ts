import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { emptyModel } from "../test-support/digest.js";
import type { WaitingGate } from "../shepherd/waiting.js";
import type { FrictionDay } from "../shepherd/owner-friction.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateAlarm } from "./gate-alarm.js";
import { rankDigest } from "./rank.js";
import { renderMarkdown } from "./render-md.js";

const ORIGIN = "https://console.example.ts.net";

const friction = (medianHours: number): FrictionDay => ({ day: "2026-03-10", ownerTouches: 1, kinds: [{ kind: "approve-merge", gates: 4, medianHours, maxHours: medianHours }] });

function gate(n: number, ageHours: number): WaitingGate {
  return { gateId: `run-${n}/approve-merge`, stepId: "approve-merge", repo: "acme/widgets", pr: n, head: null, task: "T-1", since: "2026-03-01T00:00:00Z", ageHours, headIsCurrent: null, held: null };
}

function configWith(consoleOrigin: string) {
  const dir = mkdtempSync(join(tmpdir(), "gate-alarm-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ digest: { consoleOrigin } }));
  return () => loadConfig(join(dir, "config.json"));
}

describe("gateAlarm", () => {
  it("median 24 h exactly does not alarm, just over does", () => {
    expect(gateAlarm(friction(24), [gate(1, 10)])).toBeUndefined();
    expect(gateAlarm(friction(24.1), [gate(1, 10)])?.medianHours).toBe(24.1);
  });

  it("one gate at 72 h exactly does not alarm, just over does", () => {
    expect(gateAlarm(friction(1), [gate(1, 72)])).toBeUndefined();
    expect(gateAlarm(friction(1), [gate(1, 72.1)])?.over72.map((g) => g.ageHours)).toEqual([72.1]);
  });

  it("lists the oldest gates when only the median fired", () => {
    const gates = Array.from({ length: 7 }, (_, i) => gate(i, 30 - i));

    expect(gateAlarm(friction(30), gates)?.listed).toEqual(gates.slice(0, 5));
  });
});

describe("the alarm line", () => {
  it("a 98 h median fixture puts the alarm on the top line with links", () => {
    const model = emptyModel({ friction: friction(98), ownerGateAlarm: [gate(12, 148), gate(13, 100), gate(14, 20)], consoleOrigin: ORIGIN });

    const lines = renderMarkdown(rankDigest(model)).split("\n");

    expect(lines[0]).toBe("# Owner digest 2026-03-10 12:00");
    expect(lines[2]).toBe(`Owner gates stale: approve-merge median 98h (>24h); 2 over 72h: acme/widgets#12 148h ${ORIGIN}/#/inbox/gate%3Arun-12%2Fapprove-merge, acme/widgets#13 100h ${ORIGIN}/#/inbox/gate%3Arun-13%2Fapprove-merge`);
  });

  it("omits links and says so under gaps when no origin is set", () => {
    const markdown = renderMarkdown(rankDigest(emptyModel({ friction: friction(98), ownerGateAlarm: [gate(12, 148)] })));

    expect(markdown.split("\n")[2]).toBe("Owner gates stale: approve-merge median 98h (>24h); 1 over 72h: acme/widgets#12 148h");
    expect(markdown).toContain("- digest.consoleOrigin unset: alarm links omitted");
  });

  it("leaves the digest unchanged when nothing alarms", () => {
    const model = emptyModel({ friction: friction(5), ownerGateAlarm: [gate(12, 10)], consoleOrigin: ORIGIN });

    expect(renderMarkdown(rankDigest(model))).toBe(renderMarkdown(rankDigest(emptyModel({ friction: friction(5), ownerGateAlarm: [gate(12, 10)] }))));
    expect(renderMarkdown(rankDigest(model))).not.toContain("Owner gates stale");
  });

  it("omits links for a loopback origin that reached the model", () => {
    const model = emptyModel({ friction: friction(98), ownerGateAlarm: [gate(12, 148)], consoleOrigin: "https://localhost" });

    expect(renderMarkdown(rankDigest(model))).not.toContain("/#/inbox/");
  });

  it("cuts the list to three gates and counts the rest when the digest would pass its word limit", () => {
    const gates = Array.from({ length: 200 }, (_, i) => gate(i, 300 - i));
    const filler = Array.from({ length: 9 }, (_, i) => ({ text: `ask ${i} a long synthetic sentence that keeps going well past any sensible clip`, source: "seat-a", keys: [`pr:widgets#${i}`] }));

    const markdown = renderMarkdown(rankDigest(emptyModel({ friction: friction(98), ownerGateAlarm: gates, consoleOrigin: ORIGIN, needsYou: filler })));

    expect(markdown.split("\n")[2]).toMatch(/, and 197 more$/);
  });
});

describe("digest.consoleOrigin", () => {
  it("a loopback consoleOrigin is refused", () => {
    for (const origin of ["http://127.0.0.1:7500", "https://127.0.0.1:7500", "https://localhost", "https://[::1]:7500"]) {
      expect(configWith(origin)).toThrow(/consoleOrigin/);
    }
  });

  it("refuses a plain http origin and accepts an https host", () => {
    expect(configWith("http://console.example.ts.net")).toThrow(/consoleOrigin/);
    expect(configWith(ORIGIN)().digest?.consoleOrigin).toBe(ORIGIN);
  });
});
