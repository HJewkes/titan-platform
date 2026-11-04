import type { GateRecord } from "@titan-design/hitl";
import type { OnSilence, OwnerItem } from "@titan-design/owner-queue";
import { decisionClassOf, policyRowOf } from "../decision-class.js";

/** What the owner card adds to a gate step's question: the cost of each answer and what cannot be undone. */
interface GateCard {
  /** The option the weekly meter counts as approving what the factory proposed. */
  proceed: string;
  consequence: Record<string, string>;
  irreversible: string;
  onSilence: OnSilence;
}

const WAIT: OnSilence = { action: "wait" };
const ABANDON = "The run stops for good; the PR stays open and unmerged until someone registers it again.";
const ABANDON_IRREVERSIBLE = "Abandon ends this run; landing the PR afterwards needs a new registration.";

const FROZEN: GateCard = {
  proceed: "stay-frozen",
  consequence: {
    "stay-frozen": "Shepherd merges nothing into this repo until a green head on main thaws it.",
    unfreeze: "Shepherd merges again at once, with main still red.",
  },
  irreversible: "Merges made after an unfreeze land on a red main and are not held back.",
  onSilence: WAIT,
};

/** Keyed by gate step; options and recommendations come from `gate-brief.ts`, so the card only annotates them. */
const GATE_CARDS: Readonly<Record<string, GateCard>> = {
  "approve-merge": {
    proceed: "merge",
    consequence: {
      merge: "Shepherd merges the PR into its base; undoing it takes a revert PR.",
      abandon: ABANDON,
    },
    irreversible: "A merge lands on the base branch and can only be undone by a revert.",
    onSilence: WAIT,
  },
  "ci-failed": {
    proceed: "rerun",
    consequence: {
      rerun: "The failed checks run again at this head.",
      abandon: ABANDON,
      "await-fix": "The run waits for a fixer to push a new head.",
    },
    irreversible: ABANDON_IRREVERSIBLE,
    onSilence: WAIT,
  },
  "sh-sent-back": {
    proceed: "await-new-head",
    consequence: { "await-new-head": "The run waits for a pushed head and reviews it.", abandon: ABANDON },
    irreversible: ABANDON_IRREVERSIBLE,
    onSilence: WAIT,
  },
  "sh-visual-accept": {
    proceed: "accept-set",
    consequence: {
      "accept-set": "The fixer is told to commit exactly this regenerated set and nothing else.",
      "send-back": "The fixer gets your note and pushes a new head.",
      abandon: ABANDON,
    },
    irreversible: ABANDON_IRREVERSIBLE,
    onSilence: WAIT,
  },
  "stuck-behind": {
    proceed: "retry",
    consequence: { retry: "Shepherd updates the PR branch from its base again.", abandon: ABANDON },
    irreversible: ABANDON_IRREVERSIBLE,
    onSilence: WAIT,
  },
  "main-red": {
    proceed: "acknowledged",
    consequence: {},
    irreversible: "Nothing: acknowledging only records that the owner saw the red main.",
    onSilence: WAIT,
  },
  "main-frozen": FROZEN,
  "main-red-again": FROZEN,
  "device-check": {
    proceed: "pass",
    consequence: {
      pass: "build-surface goes on to review this slice at the head you checked.",
      fail: "The implementer gets your note as a failed check and pushes a new head.",
    },
    irreversible: "Nothing: either answer only steers the slice's next round.",
    onSilence: WAIT,
  },
  "infra-park": {
    proceed: "retry",
    consequence: {
      retry: "build-surface runs this slice's gates again at the same head; no fix round is counted.",
      stop: "This slice stops and the run goes on with the others; a second stopped slice ends the run.",
    },
    irreversible: "Nothing: the branch stays, and a fresh start picks the slice up.",
    onSilence: WAIT,
  },
  "deploy-approve": {
    proceed: "deploy",
    consequence: {
      deploy: "build-surface runs the repo's deploy command at this merge; a failed deploy stops the whole run.",
      skip: "This slice stays merged and undeployed; the run goes on to the next slice.",
    },
    irreversible: "A deploy changes what the live surface serves; undoing it takes the repo's own rollback.",
    onSilence: WAIT,
  },
  "final-walk": {
    proceed: "accept",
    consequence: {
      accept: "The build-surface run completes with the build accepted.",
      changes: "The run completes with your notes recorded for follow-up tasks.",
    },
    irreversible: "Either answer ends the run; more work needs a new run.",
    onSilence: WAIT,
  },
};

const SHOWN_REF = /^(https:\/\/\S+|\/[^\n]*|\$ [^\n]+)$/;

/** A step's own card, else its family's: build-surface opens one `deploy-approve:<slice>` per slice. */
const cardOf = (step: string): GateCard | undefined => GATE_CARDS[step] ?? GATE_CARDS[step.split(":")[0]!];

/** Gate ids are `<runId>/<stepId>` or `<runId>/<stepId>:<n>`. */
export const gateStepOf = (gateId: string): string => gateId.slice(gateId.indexOf("/") + 1).replace(/:\d+$/, "");

type CardFields = Pick<OwnerItem, "class" | "irreversible" | "shown" | "onSilence">;

/** The card fields a gate carries; a step with no card row gets only what its policy row says. */
export function cardFields(gate: GateRecord): CardFields {
  const step = gateStepOf(gate.id);
  const row = policyRowOf(gate.prompt) ?? (gate.rule && { table: gate.rule.table, rowId: gate.rule.ruleId });
  const decisionClass = decisionClassOf({ ...row, step, prompt: gate.prompt });
  const card = cardOf(step);
  return {
    ...(decisionClass && { class: decisionClass }),
    ...(card && { irreversible: card.irreversible, onSilence: card.onSilence }),
    ...(gate.evidenceRef !== undefined && SHOWN_REF.test(gate.evidenceRef) && { shown: [gate.evidenceRef] }),
  };
}

/** The option the weekly meter counts as approve for a step; a step with no card row answers with `approve: true`. */
export const proceedOf = (step: string): string => cardOf(step)?.proceed ?? "approve";

/** The consequence the step's card names for an option; undefined leaves `card:consequence` to say it is missing. */
export function consequenceOf(gate: GateRecord, optionId: string): string | undefined {
  return cardOf(gateStepOf(gate.id))?.consequence[optionId];
}
