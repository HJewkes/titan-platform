import type { Verbs } from "../../cli-types.js";
import { activeWorkOrigin } from "../../shepherd/cleanup-ports.js";
import { readLaneCensusRows } from "../active-work.js";
import { censusDispatchable } from "./census.js";
import type { RefillOutcome, RefillPorts } from "./refill.js";

/** Counts over active-work's rpc and sends through the CLI's injected `refillSend`; nothing is read until a lane has a floor. */
export function liveRefillPorts(verbs: Verbs): RefillPorts {
  const source = { origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) };
  return {
    dispatchable: async (lane) => {
      const rows = await readLaneCensusRows(source, { initiative: lane.initiative, ...(lane.tag !== null && { tag: lane.tag }) });
      return rows.filter(censusDispatchable).length;
    },
    send: async (to, text) => {
      const send = verbs.deps.refillSend?.(verbs.io.env);
      if (send === undefined) throw new Error("no refill sender: set shepherd.agentChatBin in the factory config");
      await send(to, text);
    },
  };
}

/** One summary line per outcome, for the tick's stdout or stderr. */
export function refillLine(outcome: RefillOutcome): string {
  const count = outcome.count === undefined ? "unread" : String(outcome.count);
  const tail = outcome.detail === undefined ? "" : `: ${outcome.detail}`;
  return `ready-stock refill ${outcome.result} for ${outcome.lane} (${count} dispatchable, floor ${outcome.floor}) -> ${outcome.to}${tail}\n`;
}
