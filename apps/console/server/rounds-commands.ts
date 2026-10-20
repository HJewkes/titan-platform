import { z } from "zod";
import { readCommand } from "./owner-guard.js";
import { getRound, listRounds, roundDetail, roundSummary, type RoundsSource } from "./rounds.js";

export function roundsCommands(source: RoundsSource) {
  return {
    "rounds.list": readCommand({
      name: "rounds.list",
      description: "Every review round in the rounds dir, newest first: open, sent or withdrawn, and the schema's reason for any invalid one",
      args: z.object({}),
      result: z.object({ rounds: z.array(roundSummary), truncated: z.boolean(), dir: z.string() }),
      run: () => listRounds(source),
    }),
    "rounds.get": readCommand({
      name: "rounds.get",
      description: "One review round's manifest; an unsent after-answer round comes without its recommendations, and a Ship round with its proven head's lineage",
      args: z.object({ id: z.string().min(1).max(64) }),
      result: roundDetail,
      run: ({ id }) => getRound(source, id),
    }),
  };
}
