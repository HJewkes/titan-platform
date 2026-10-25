import { z } from "zod";

/**
 * The slot schemas a beat spec's `slots` names (VT §5.3 "zod ref"): what the builder must fill
 * before a beat renders. A top-level array whose items carry an `id` is an emphasis target list:
 * a script cue's `target` names one of those ids (plan, owner override 1).
 */

const Id = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case element id");
const Line = z.string().min(1).max(160);
const Label = z.string().min(1).max(48);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date");

const Source = z.object({ label: Label, ref: z.string().min(1) }).strict();
const Item = z.object({ id: Id, text: Line }).strict();
const Node = z.object({ id: Id, label: Label }).strict();
const Edge = z.object({ id: Id, from: Id, to: Id, label: Label.optional() }).strict();
const CodeLine = z.object({ id: Id, text: z.string(), op: z.enum(["add", "del", "ctx"]).optional() }).strict();
const Figure = z
  .object({
    id: Id,
    value: z.number(),
    unit: Label.optional(),
    label: Label,
    delta: z.number().optional(),
    interval: z.tuple([z.number(), z.number()]).optional(),
    grade: z.enum(["A", "B", "C", "D"]).optional(),
  })
  .strict();
const Change = z.enum(["added", "removed", "changed", "same"]);
const Severity = z.enum(["low", "medium", "high"]);

const Point = z.object({ id: Id, label: Label, value: z.number() }).strict();
const Finding = z.object({ id: Id, title: Line, severity: Severity, status: z.enum(["open", "fixed", "waived"]), round: z.number().int().positive().optional() }).strict();
const ProofCheck = z.object({ id: Id, name: Label, base: z.enum(["fail", "pass", "absent"]), head: z.enum(["fail", "pass"]) }).strict();

// A row's lane is the short chip a `<lane> · <text>` label names.
const ListRow = z.object({ id: Id, text: Line, mark: z.enum(["tick", "cross", "risk", "open", "dot"]), lane: Label.max(12).optional() }).strict();

const items = (min: number, max: number) => z.array(Item).min(min).max(max);
const graph = { nodes: z.array(Node).min(2).max(12), edges: z.array(Edge).max(16) };

/** Every slot schema by ref. A spec names one ref; two specs may share it. */
export const BEAT_SLOTS = {
  hook: z.object({ line: Line, cards: items(0, 12).default([]) }).strict(),
  promise: z.object({ line: Line, chapters: items(2, 6) }).strict(),
  "claim-card": z.object({ claim: Line, quote: z.object({ text: Line, source: Source }).strict().optional(), source: Source.optional() }).strict(),
  stat: z.object({ figures: z.array(Figure).min(1).max(4) }).strict(),
  "entry-points": z.object({ entries: z.array(z.object({ id: Id, command: Line, does: Line }).strict()).min(1).max(5) }).strict(),
  "user-flow": z.object({ actor: Label, steps: items(2, 6) }).strict(),
  misconception: z.object({ belief: Line, reality: Line, source: Source.optional() }).strict(),
  stakes: z.object({ cost: Line, figures: z.array(Figure).max(2).default([]) }).strict(),
  map: z.object({ title: Label.optional(), ...graph, focus: Id.optional() }).strict(),
  "info-flow": z.object({ ...graph, token: Label.optional() }).strict(),
  "request-walk": z.object({ ...graph, request: Line, hops: z.array(Id).min(1) }).strict(),
  sequence: z.object({ actors: z.array(Node).min(2).max(6), messages: z.array(Edge).min(1).max(12) }).strict(),
  schema: z.object({ tables: z.array(z.object({ id: Id, name: Label, columns: z.array(Label).min(1) }).strict()).min(1).max(6), relations: z.array(Edge).default([]) }).strict(),
  "code-walk": z.object({ path: z.string().min(1), language: Label, mode: z.enum(["plain", "diff"]), simplified: z.boolean(), lines: z.array(CodeLine).min(1).max(10) }).strict(),
  "algo-trace": z.object({ steps: z.array(z.object({ id: Id, state: z.array(Label).min(1), note: Line }).strict()).min(2).max(12) }).strict(),
  compare: z.object({ leftTitle: Label, rightTitle: Label, rows: z.array(z.object({ id: Id, left: Line, right: Line }).strict()).min(1).max(4) }).strict(),
  "docs-vs-code": z.object({ docs: Line, source: Source, path: z.string().min(1), lines: z.array(CodeLine).min(1).max(6) }).strict(),
  "issue-pin": z.object({ title: Line.optional(), issues: z.array(z.object({ id: Id, title: Line, severity: Severity, pin: Id.optional() }).strict()).min(1).max(5) }).strict(),
  fix: z.object({ path: z.string().min(1), lines: z.array(CodeLine).min(1).max(10) }).strict(),
  chapter: z.object({ n: z.number().int().positive(), title: Label, question: Line.optional() }).strict(),
  history: z.object({ events: z.array(z.object({ id: Id, date: Day, text: Line }).strict()).min(2).max(8) }).strict(),
  held: z.object({ line: Line.optional() }).strict(),
  takeaways: z.object({ items: items(1, 5) }).strict(),
  button: z.object({ line: Line, action: Label, href: z.string().min(1).optional() }).strict(),
  outro: z.object({ line: Line }).strict(),
  "context-map": z.object({ system: Label, actors: z.array(Node).min(1).max(8) }).strict(),
  "metrics-panel": z.object({ rows: z.array(z.object({ id: Id, measure: Label, today: Label, target: Label.optional() }).strict()).min(1).max(6) }).strict(),
  dsm: z.object({ modules: z.array(Node).min(2).max(12), cells: z.array(z.object({ from: Id, to: Id, weight: z.number().nonnegative() }).strict()) }).strict(),
  "verdict-chip": z.object({ call: Label, reason: Line }).strict(),
  scorecard: z.object({ rows: z.array(z.object({ id: Id, label: Label, call: Label, reason: Line.optional() }).strict()).min(2).max(8) }).strict(),
  "reading-list": z.object({ items: z.array(z.object({ id: Id, path: z.string().min(1), why: Line }).strict()).min(1).max(6) }).strict(),
  "fact-flash": z.object({ facts: items(1, 4) }).strict(),
  chart: z.object({ kind: z.enum(["bar", "line", "spark", "gauge"]), title: Label.optional(), unit: Label.optional(), cap: z.number().optional(), series: z.array(Point).min(1).max(12) }).strict(),
  list: z.object({ title: Label.optional(), rows: z.array(ListRow).min(1).max(5) }).strict(),
  "verdict-card": z.object({ verdict: Line, call: Label, reasons: items(1, 3) }).strict(),
  "change-group": z.object({ groups: z.array(z.object({ id: Id, title: Label, why: Line, files: z.array(z.string().min(1)).min(1), pin: Id.optional() }).strict()).min(2).max(4) }).strict(),
  "diff-map": z.object({ nodes: z.array(Node.extend({ change: Change })).min(2).max(12), edges: z.array(Edge.extend({ change: Change })).max(16) }).strict(),
  "finding-card": z.object({ findings: z.array(Finding).min(1).max(4) }).strict(),
  proof: z.object({ command: Line.optional(), checks: z.array(ProofCheck).min(1).max(6) }).strict(),
  "frame-flow": z.object({ frames: z.array(z.object({ id: Id, image: z.string().min(1), caption: Line }).strict()).min(2).max(6) }).strict(),
  replot: z
    .object({
      kind: z.enum(["bar", "line", "scatter"]),
      x: Label,
      y: Label,
      source: Source,
      series: z.array(z.object({ id: Id, label: Label, points: z.array(z.object({ x: z.number(), y: z.number() }).strict()).min(1) }).strict()).min(1).max(6),
    })
    .strict(),
  sim: z
    .object({
      model: Id,
      seed: z.number().int(),
      params: z.record(z.string(), z.number()),
      sweep: z.object({ param: z.string().min(1), from: z.number(), to: z.number(), steps: z.number().int().min(2) }).strict(),
      claim: z.object({ value: z.number(), tolerance: z.number().nonnegative() }).strict().optional(),
      readouts: z.array(z.object({ id: Id, label: Label }).strict()).min(1).max(4),
    })
    .strict(),
  "rule-diff": z.object({ rule: Label, reason: Line, changes: z.array(z.object({ id: Id, op: z.enum(["add", "remove", "change"]), text: Line }).strict()).min(1).max(4) }).strict(),
  "kanban-flow": z.object({ columns: z.array(Node).min(2).max(6), cards: z.array(z.object({ id: Id, title: Label, from: Id, to: Id }).strict()).min(1).max(12) }).strict(),
  gantt: z
    .object({
      tasks: z.array(z.object({ id: Id, label: Label, start: Day, end: Day, lane: Label.optional() }).strict()).min(1).max(12),
      milestones: z.array(z.object({ id: Id, label: Label, at: Day }).strict()).default([]),
    })
    .strict(),
  forecast: z
    .object({ metric: Label, unit: Label, history: z.array(z.number()).min(2), quantiles: z.array(z.object({ id: z.enum(["p50", "p80", "p95"]), value: z.number() }).strict()).min(1).max(3) })
    .strict(),
  "history-why": z.object({ decision: Line, date: Day, quote: z.object({ text: Line, source: Source }).strict(), alternatives: items(0, 3).default([]) }).strict(),
  attempt: z.object({ attempts: z.array(z.object({ id: Id, tried: Line, outcome: z.enum(["worked", "broke", "partial"]), why: Line }).strict()).min(1).max(4) }).strict(),
  "companion-link": z.object({ title: Line, section: Label, href: z.string().min(1) }).strict(),
} as const satisfies Record<string, z.ZodObject>;

export type BeatSlotRef = keyof typeof BEAT_SLOTS;

export const isSlotRef = (ref: string): ref is BeatSlotRef => Object.hasOwn(BEAT_SLOTS, ref);

/** Whether slot `field` of schema `ref` is a list of elements with ids, so a cue may target its items. */
export function isTargetField(ref: BeatSlotRef, field: string): boolean {
  const slot: z.ZodType | undefined = (BEAT_SLOTS[ref].shape as Record<string, z.ZodType>)[field];
  const list = slot instanceof z.ZodDefault ? slot.unwrap() : slot;
  if (!(list instanceof z.ZodArray)) return false;
  const element: unknown = list.element;
  return element instanceof z.ZodObject && "id" in element.shape;
}
