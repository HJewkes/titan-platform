// Twin fixtures for the owner's planning ops (TP-5453 P3b): one inbox item per op. Synthetic.
// The twin is a snapshot, so its rows offer no tap; `src/inbox-plan.test.tsx` renders the read-backs a tap opens.
import type { ServedCommands } from "../../src/data/rpc.js";
import { TWIN_NOW } from "./clock.js";

type Served = ServedCommands;
type InboxItem = Served["inbox.list"]["result"]["items"][number];
type OwnerOpAction = Extract<InboxItem["action"], { kind: "owner-op" }>;

const HOUR = 3_600_000;
const at = (msAgo: number): string => new Date(TWIN_NOW - msAgo).toISOString();
const ASKER = "orbit-coord";
const OUTCOME = "orbit-relay/steady-relay";

const BET_SELECT: OwnerOpAction = { kind: "owner-op", op: { kind: "plan-bet-select", initiative: "orbit-relay", week: "2031-W10", bets: ["orbit-relay/B1", "orbit-relay/B2"] } };
const OUTCOME_EDIT: OwnerOpAction = { kind: "owner-op", op: { kind: "plan-outcome-edit", outcome: OUTCOME, to: { measure: "handshake recoveries per 1,000 drops" } } };
const FREEZE_SET: OwnerOpAction = {
  kind: "owner-op",
  op: { kind: "plan-freeze-set", initiative: "orbit-relay", freeze: { action: "set", tag: "upkeep", reason: "Upkeep waits until the retry bet reads", end_condition: { kind: "task-done", task: "orbit-relay/OR-12" }, intent_ref: "D41", quote_ref: "msg:9a8b7c" } },
};

function planItem(id: string, summary: string, action: OwnerOpAction): InboxItem {
  return {
    id, sources: [{ system: "deposit", ref: `${ASKER}/${id}` }], kind: "do", door: "one-way", summary, keys: [], asker: ASKER,
    personal: false, lens: "blocking-agent", section: "blocking", unblocks: [], openedAt: at(3 * HOUR), status: "open", evidence: undefined, action,
  };
}

export const PLAN_ITEMS: readonly InboxItem[] = [
  planItem("plan-bets", "Pick the relay bets for 2031-W10", BET_SELECT),
  planItem("plan-outcome", "Measure the steady-relay outcome per 1,000 drops", OUTCOME_EDIT),
  planItem("plan-freeze", "Freeze upkeep until the retry bet reads", FREEZE_SET),
];
