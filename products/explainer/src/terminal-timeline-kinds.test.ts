import { describe, expect, it } from "vitest";
import { itemRoutes } from "./eval-items.js";
import { paceInput } from "./eval-pace-cli.js";
import { cueKindRole, type PaceRole } from "./pace-items.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const TERMINAL_TIMELINE_KINDS: Record<string, PaceRole> = { cmd: "item", out: "attribute", event: "item" };

const cue = (target: string, atCue: string) => ({ action: "V11", target, atCue });

// An invented script shaped like a CI repro and a dated timeline: typed commands, their output lines, dated events.
const terminalLike = () =>
  scriptWith({
    visual: {
      assertion: "The failure reproduces and the timeline explains it",
      job: "map",
      cues: [
        cue("cmd:run the suite", "server"),
        cue("out:3 passed, 1 failed", "ledger"),
        cue("event:Mar 3 release cut", "scan"),
        cue("event:Mar 9 fix lands", "desk"),
      ],
    },
  });

describe("the terminal and timeline cue kinds", () => {
  // Mutation: dropping any of the three kinds from CUE_KIND_ROLES makes cueKindRole throw.
  it("gives cmd, out and event the roles the pace layer counts them by", () => {
    for (const [kind, role] of Object.entries(TERMINAL_TIMELINE_KINDS)) expect(cueKindRole(kind)).toBe(role);
  });

  // Mutation: dropping any of the three kinds from CUE_KIND_ROLES throws "unknown cue kind" in the reader all three evals share.
  it("reads a terminal-and-timeline script through paceInput without stand-in kinds", () => {
    const raw = terminalLike();

    const { beats, invariants } = paceInput(raw, "v1", undefined);

    expect(beats[0]?.items.map((i) => [i.kind, i.role])).toEqual([
      ["cmd", "item"],
      ["out", "attribute"],
      ["event", "item"],
      ["event", "item"],
    ]);
    expect(beats[0]?.newItems.map((i) => i.label)).toEqual(["run the suite", "Mar 3 release cut", "Mar 9 fix lands"]);
    expect(() => itemRoutes(beats, invariants)).not.toThrow();
  });
});
