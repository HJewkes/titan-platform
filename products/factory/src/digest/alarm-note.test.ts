import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FrictionDay } from "../shepherd/owner-friction.js";
import type { WaitingGate } from "../shepherd/waiting.js";
import { alarmNote, gateAlarm } from "./gate-alarm.js";
import { ALARM_NOTE_FILE, syncAlarmNote } from "./run.js";

const ORIGIN = "https://console.example.ts.net";

const friction = (medianHours: number): FrictionDay => ({ day: "2026-03-10", ownerTouches: 1, kinds: [{ kind: "approve-merge", gates: 4, medianHours, maxHours: medianHours }] });

function gate(n: number, ageHours: number): WaitingGate {
  return { gateId: `run-${n}/approve-merge`, stepId: "approve-merge", repo: "acme/widgets", pr: n, head: null, task: "T-1", since: "2026-03-01T00:00:00Z", ageHours, headIsCurrent: null, held: null };
}

describe("the planner alarm note", () => {
  const noteDir = () => mkdtempSync(join(tmpdir(), "gate-alarm-note-"));
  const fired = () => alarmNote(gateAlarm(friction(98), [gate(12, 148), gate(13, 80)])!, ORIGIN);

  it("a firing alarm writes owner-gate-alarm.md listing the stale gates", () => {
    const dir = noteDir();

    syncAlarmNote(dir, fired());

    const text = readFileSync(join(dir, ALARM_NOTE_FILE), "utf8");
    expect(text).toContain("approve-merge median 98h (>24h); 2 over 72h");
    expect(text).toContain("- acme/widgets#12 148h https://console.example.ts.net/#/inbox/gate%3Arun-12%2Fapprove-merge");
    expect(text).toContain("- acme/widgets#13 80h");
  });

  it("no alarm writes no file (or clears a stale one)", () => {
    const dir = noteDir();
    syncAlarmNote(dir, undefined);
    expect(existsSync(join(dir, ALARM_NOTE_FILE))).toBe(false);

    syncAlarmNote(dir, fired());
    syncAlarmNote(dir, undefined);

    expect(existsSync(join(dir, ALARM_NOTE_FILE))).toBe(false);
  });
});
