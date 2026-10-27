import type { BeatSlotRef } from "../beat-slots.js";
import { deriveButton, deriveChapter, deriveClaim, deriveCompanionLink, deriveHeld, deriveHook, deriveOutro, derivePromise, deriveUserFlow } from "./derive-cards.js";
import { deriveCodeWalk, deriveDocsVsCode, deriveFix } from "./derive-code.js";
import { deriveChart, deriveStakes, deriveStat } from "./derive-figures.js";
import { deriveMap } from "./derive-graph.js";
import { deriveCompare, deriveMisconception } from "./derive-pairs.js";
import { deriveIssues, deriveItems, deriveList, deriveVerdict } from "./derive-rows.js";
import type { Deriver } from "./types.js";

/** A ref whose slots carry structure (dates, severities, edges, params) that a script's labels do not hold. */
const fromSlotsOnly =
  (ref: BeatSlotRef): Deriver =>
  () => ({ reason: `${ref} derives no slots from a script; fill them through visual.slots or a slots pin` });

/** How each slot schema is read off a script beat. Keyed by every ref, so a new ref without a row fails typecheck. */
export const DERIVERS: Record<BeatSlotRef, Deriver> = {
  hook: deriveHook,
  promise: derivePromise,
  "claim-card": deriveClaim,
  stat: deriveStat,
  "entry-points": fromSlotsOnly("entry-points"),
  "user-flow": deriveUserFlow,
  misconception: deriveMisconception,
  stakes: deriveStakes,
  map: deriveMap,
  "info-flow": fromSlotsOnly("info-flow"),
  "request-walk": fromSlotsOnly("request-walk"),
  sequence: fromSlotsOnly("sequence"),
  schema: fromSlotsOnly("schema"),
  "code-walk": deriveCodeWalk,
  "algo-trace": fromSlotsOnly("algo-trace"),
  compare: deriveCompare,
  "docs-vs-code": deriveDocsVsCode,
  "issue-pin": deriveIssues,
  fix: deriveFix,
  chapter: deriveChapter,
  history: fromSlotsOnly("history"),
  held: deriveHeld,
  takeaways: deriveItems("items"),
  button: deriveButton,
  outro: deriveOutro,
  "context-map": fromSlotsOnly("context-map"),
  "metrics-panel": fromSlotsOnly("metrics-panel"),
  dsm: fromSlotsOnly("dsm"),
  "verdict-chip": fromSlotsOnly("verdict-chip"),
  scorecard: fromSlotsOnly("scorecard"),
  "reading-list": fromSlotsOnly("reading-list"),
  "fact-flash": deriveItems("facts"),
  chart: deriveChart,
  list: deriveList,
  "verdict-card": deriveVerdict,
  "change-group": fromSlotsOnly("change-group"),
  "diff-map": fromSlotsOnly("diff-map"),
  "finding-card": fromSlotsOnly("finding-card"),
  proof: fromSlotsOnly("proof"),
  "frame-flow": fromSlotsOnly("frame-flow"),
  replot: fromSlotsOnly("replot"),
  sim: fromSlotsOnly("sim"),
  "rule-diff": fromSlotsOnly("rule-diff"),
  "kanban-flow": fromSlotsOnly("kanban-flow"),
  gantt: fromSlotsOnly("gantt"),
  forecast: fromSlotsOnly("forecast"),
  "history-why": fromSlotsOnly("history-why"),
  attempt: fromSlotsOnly("attempt"),
  "companion-link": deriveCompanionLink,
};
