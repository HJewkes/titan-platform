import { describe, expect, it } from "vitest";
import { itemRoutes } from "./eval-items.js";
import { paceInput } from "./eval-pace-cli.js";
import { cueKindRole, type PaceRole } from "./pace-items.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const ADDENDUM_KINDS: Record<string, PaceRole> = { wait: "action", edge: "item", orphan: "attribute", edit: "action" };

const cue = (target: string, atCue: string) => ({ action: "V11", target, atCue });

// An invented script shaped like a review addendum: a CI wait, an orphan marker, a code edit and a build/buy table.
const addendumLike = () =>
  scriptWith({
    visual: {
      assertion: "Each part is built or bought",
      job: "map",
      cues: [
        cue("wait:ci", "server"),
        cue("orphan:verdict,owner", "ledger"),
        cue("edit:perm|  permissions: write-all", "scan"),
        cue("edge:merge queue|buy|hosted", "desk"),
        cue("edge:event bus|build|one store", "reaches"),
      ],
    },
  });

describe("the addendum's cue kinds", () => {
  // Mutation: dropping any of the four kinds from CUE_KIND_ROLES makes cueKindRole throw.
  it("gives wait, edge, orphan and edit the roles the pace layer counts them by", () => {
    for (const [kind, role] of Object.entries(ADDENDUM_KINDS)) expect(cueKindRole(kind)).toBe(role);
  });

  // Mutation: dropping any of the four kinds from CUE_KIND_ROLES throws "unknown cue kind" in the reader all three evals share.
  it("reads an addendum-like script through paceInput, the reader pace, items and cold share", () => {
    const raw = addendumLike();

    const { beats, invariants } = paceInput(raw, "v1", undefined);

    expect(beats[0]?.items.map((i) => [i.kind, i.role])).toEqual([
      ["wait", "action"],
      ["orphan", "attribute"],
      ["edit", "action"],
      ["edge", "item"],
      ["edge", "item"],
    ]);
    expect(beats[0]?.newItems.map((i) => i.label)).toEqual(["merge queue|buy|hosted", "event bus|build|one store"]);
    expect(() => itemRoutes(beats, invariants)).not.toThrow();
  });
});
