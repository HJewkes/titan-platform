/**
 * The beat editor's form model: which control each JSON Schema node gets, the row bounds an array keeps, and how a
 * draft becomes an edit. The schema is whatever the installed explainer emits (zod's `toJSONSchema`), so a node the
 * form has no control for is shown read-only rather than guessed at.
 */

type Schema = Readonly<Record<string, unknown>>;

export type Control =
  | { kind: "text"; minLength?: number; maxLength?: number }
  | { kind: "select"; options: readonly string[] }
  | { kind: "number"; integer: boolean }
  | { kind: "boolean" }
  | { kind: "object"; fields: readonly Field[] }
  | { kind: "array"; item: Control; minItems: number; maxItems: number }
  | { kind: "raw" };

export interface Field {
  name: string;
  required: boolean;
  control: Control;
}

export type Fields = Record<string, unknown>;

/** A beat's span on the render. */
export interface BeatSpan {
  id: string;
  startS: number;
  endS: number;
}

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
export const isFields = isSchema as (value: unknown) => value is Fields;
const numberOr = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

function textControl(schema: Schema): Control {
  const { minLength, maxLength } = schema;
  return { kind: "text", ...(typeof minLength === "number" ? { minLength } : {}), ...(typeof maxLength === "number" ? { maxLength } : {}) };
}

function objectControl(schema: Schema): Control {
  if (!isSchema(schema.properties)) return { kind: "raw" };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(schema.properties).map(([name, node]) => ({ name, required: required.has(name), control: controlOf(node) }));
  return { kind: "object", fields };
}

function arrayControl(schema: Schema): Control {
  if (!isSchema(schema.items) || "prefixItems" in schema) return { kind: "raw" };
  return { kind: "array", item: controlOf(schema.items), minItems: numberOr(schema.minItems, 0), maxItems: numberOr(schema.maxItems, Number.POSITIVE_INFINITY) };
}

/** The control for one schema node: a string enum is a select, every other string a text field with its length bounds. */
export function controlOf(node: unknown): Control {
  if (!isSchema(node)) return { kind: "raw" };
  if (Array.isArray(node.enum) && node.enum.every((option) => typeof option === "string")) return { kind: "select", options: node.enum };
  switch (node.type) {
    case "string":
      return textControl(node);
    case "number":
    case "integer":
      return { kind: "number", integer: node.type === "integer" };
    case "boolean":
      return { kind: "boolean" };
    case "object":
      return objectControl(node);
    case "array":
      return arrayControl(node);
    default:
      return { kind: "raw" };
  }
}

/** Every element id anywhere in a beat's slots, so a new row's id is unique across the beat, not only its own list. */
export function idsIn(value: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isFields(node)) {
      if (typeof node.id === "string") ids.add(node.id);
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return ids;
}

/** The first `<stem>-<n>` not taken: kebab case, so it passes the element id pattern. */
export function uniqueId(taken: ReadonlySet<string>, stem = "row"): string {
  let n = 1;
  while (taken.has(`${stem}-${n}`)) n += 1;
  return `${stem}-${n}`;
}

/** A blank value for a control; an object gets its required fields only, and an `id` field a fresh unique id. */
export function blankOf(control: Control, taken: ReadonlySet<string>): unknown {
  switch (control.kind) {
    case "text":
      return "";
    case "select":
      return control.options[0] ?? "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return Object.fromEntries(control.fields.filter((f) => f.required).map((f) => [f.name, f.name === "id" && f.control.kind === "text" ? uniqueId(taken) : blankOf(f.control, taken)]));
    default:
      return null;
  }
}

type ArrayControl = Extract<Control, { kind: "array" }>;

const rowId = (row: unknown): string | undefined => (isFields(row) && typeof row.id === "string" ? row.id : undefined);

export const canAddRow = (rows: readonly unknown[], control: ArrayControl): boolean => rows.length < control.maxItems;

/** A row a cue targets stays: removing it would strand the cue, which the edit check refuses anyway. */
export function canRemoveRow(rows: readonly unknown[], index: number, control: ArrayControl, locked: readonly string[]): boolean {
  const id = rowId(rows[index]);
  return rows.length > control.minItems && (id === undefined || !locked.includes(id));
}

export function addRow(rows: readonly unknown[], control: ArrayControl, taken: ReadonlySet<string>): unknown[] {
  return canAddRow(rows, control) ? [...rows, blankOf(control.item, taken)] : [...rows];
}

export function removeRow(rows: readonly unknown[], index: number, control: ArrayControl, locked: readonly string[]): unknown[] {
  return canRemoveRow(rows, index, control, locked) ? rows.filter((_, i) => i !== index) : [...rows];
}

export function moveRow(rows: readonly unknown[], from: number, to: number): unknown[] {
  if (to < 0 || to >= rows.length || from === to) return [...rows];
  const next = [...rows];
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

/** The top-level slot fields the draft changed; each replaces the field whole, as `visual.slots` does. */
export function changedFields(original: Fields, draft: Fields): Fields {
  return Object.fromEntries(Object.entries(draft).filter(([field, value]) => JSON.stringify(original[field]) !== JSON.stringify(value)));
}

/** The beat under the playhead: the one whose `[startS, endS)` holds it, so a boundary belongs to the beat it opens. */
export function beatAt<Beat extends BeatSpan>(beats: readonly Beat[], seconds: number): Beat | null {
  return beats.find((beat) => beat.startS <= seconds && seconds < beat.endS) ?? null;
}

export interface PlacedProblems {
  /** Keyed by the path under the beat's slots, such as `rows.1.left`. */
  byPath: ReadonlyMap<string, readonly string[]>;
  /** Problems that name no slot field of this beat: a fill refusal, a cue, another beat. */
  general: readonly string[];
}

/** Places each `beats.<id>.visual.slots.<path>: <message>` problem at its field; everything else is general. */
export function placeProblems(problems: readonly string[], beatId: string): PlacedProblems {
  const prefix = `beats.${beatId}.visual.slots.`;
  const byPath = new Map<string, string[]>();
  const general: string[] = [];
  for (const problem of problems) {
    const split = problem.indexOf(": ");
    if (!problem.startsWith(prefix) || split < 0) {
      general.push(problem);
      continue;
    }
    const path = problem.slice(prefix.length, split);
    byPath.set(path, [...(byPath.get(path) ?? []), problem.slice(split + 2)]);
  }
  return { byPath, general };
}
