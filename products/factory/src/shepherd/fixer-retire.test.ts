import { describe, expect, it } from "vitest";
import type { Freeze } from "./freeze.js";
import { retireEndedFixers, type FixerRetirePorts } from "./fixer-retire.js";
import type { Presence } from "./presence.js";

const frozen = (repo: string, fixer: string | null): Freeze => ({ repo, redSha: "a".repeat(40), fixTask: "titan-platform/TP-1", fixer, redCount: 1, frozenAt: "2026-10-11T00:00:00Z", episode: 1, cancelOnly: false, fixPr: null, fixPrActor: null });

function rig(rows: Record<string, Presence>, refuse: Record<string, string> = {}) {
  const calls: string[] = [];
  const ports: FixerRetirePorts = {
    roster: async () => Object.entries(rows).map(([name, presence]) => ({ name, presence })),
    park: async (name) => {
      calls.push(`park ${name}`);
      if (refuse[name]) throw new Error(refuse[name]);
    },
    retire: async (name) => void calls.push(`retire ${name}`),
  };
  return { ports, calls };
}

describe("retireEndedFixers", () => {
  it("parks then retires the fixer of a repo that is green again after the fixer's own merge", async () => {
    const { ports, calls } = rig({ "fix-widget-b09ac37": "detached" });

    const notes = await retireEndedFixers(ports, []);

    expect(calls).toEqual(["park fix-widget-b09ac37", "retire fix-widget-b09ac37"]);
    expect(notes).toEqual([expect.objectContaining({ fixer: "fix-widget-b09ac37", outcome: "retired" })]);
  });

  it("retires the fixer an earlier episode left behind while a later episode's fixer stays", async () => {
    const { ports, calls } = rig({ "fix-widget-f8f49ee": "exited", "fix-widget-1234567": "detached" });

    await retireEndedFixers(ports, [frozen("octo/widget", "fix-widget-1234567")]);

    expect(calls).toEqual(["park fix-widget-f8f49ee", "retire fix-widget-f8f49ee"]);
  });

  it("leaves a dirty or unpushed tree and its agent, and says why", async () => {
    const { ports, calls } = rig({ "fix-widget-b09ac37": "detached" }, { "fix-widget-b09ac37": "tree has uncommitted changes" });

    const notes = await retireEndedFixers(ports, []);

    expect(calls).toEqual(["park fix-widget-b09ac37"]);
    expect(notes).toEqual([expect.objectContaining({ outcome: "left", detail: expect.stringContaining("uncommitted") })]);
  });

  it("never touches a fixer that is still running", async () => {
    const { ports, calls } = rig({ "fix-widget-b09ac37": "live", "fix-widget-c09ac37": "exiting" });

    await retireEndedFixers(ports, []);

    expect(calls).toEqual([]);
  });

  it("waits out a repo frozen with no fixer recorded, because its fixer may be mid-spawn", async () => {
    const { ports, calls } = rig({ "fix-widget-b09ac37": "detached" });

    await retireEndedFixers(ports, [frozen("octo/widget", null)]);

    expect(calls).toEqual([]);
  });

  it("ignores agents that are not Shepherd fixers", async () => {
    const { ports, calls } = rig({ "fix-the-bug": "exited", "tc-tp-1732": "exited" });

    await retireEndedFixers(ports, []);

    expect(calls).toEqual([]);
  });
});
