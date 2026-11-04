import { describe, expect, it } from "vitest";
import { z } from "zod";
import PROPS_JSON from "../../fixtures/explainer/props.json?raw";
import { addRow, beatAt, canAddRow, changedFields, controlOf, idsIn, moveRow, placeProblems, removeRow, uniqueId, type Control } from "./slot-form.js";

/** The fake explainer's canned props: zod's JSON Schema for the compare and list slots, with synthetic values. */
const FixtureBeat = z.object({ id: z.string(), schema: z.unknown(), value: z.record(z.string(), z.unknown()), startS: z.number(), endS: z.number() });
const PROPS = z.object({ beats: z.tuple([FixtureBeat, FixtureBeat]) }).parse(JSON.parse(PROPS_JSON));
const [COMPARE, LIST] = PROPS.beats;
const ROWS = z.array(z.object({ id: z.string() }).loose()).parse(COMPARE.value.rows);

type ArrayControl = Extract<Control, { kind: "array" }>;
const fieldOf = (control: Control, name: string): Control => {
  if (control.kind !== "object") throw new Error(`not an object: ${control.kind}`);
  const field = control.fields.find((each) => each.name === name);
  if (field === undefined) throw new Error(`no field ${name}`);
  return field.control;
};
const arrayOf = (control: Control): ArrayControl => {
  if (control.kind !== "array") throw new Error(`not an array: ${control.kind}`);
  return control;
};

describe("a slot JSON Schema as form controls", () => {
  it("gives each node type its control, with length and row bounds", () => {
    const compare = controlOf(COMPARE.schema);
    const list = controlOf(LIST.schema);
    const rows = arrayOf(fieldOf(list, "rows"));

    expect(fieldOf(compare, "leftTitle")).toEqual({ kind: "text", minLength: 1, maxLength: 48 });
    expect([arrayOf(fieldOf(compare, "rows")).minItems, arrayOf(fieldOf(compare, "rows")).maxItems]).toEqual([1, 4]);
    expect(fieldOf(rows.item, "mark")).toEqual({ kind: "select", options: ["tick", "cross", "risk", "open", "dot"] });
    expect(controlOf({ type: "integer" })).toEqual({ kind: "number", integer: true });
    expect(controlOf({ type: "number" })).toEqual({ kind: "number", integer: false });
    expect(controlOf({ type: "boolean" })).toEqual({ kind: "boolean" });
  });

  it("shows a node it has no control for read-only rather than guessing", () => {
    expect(controlOf({ type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: { type: "number" } })).toEqual({ kind: "raw" });
    expect(controlOf({ type: "object", additionalProperties: { type: "number" } })).toEqual({ kind: "raw" });
    expect(controlOf({ anyOf: [{ type: "string" }, { type: "null" }] })).toEqual({ kind: "raw" });
  });
});

describe("array rows", () => {
  const rows = arrayOf(fieldOf(controlOf(COMPARE.schema), "rows"));
  const value = ROWS;

  it("adds rows up to maxItems and no further", () => {
    let current: unknown[] = [...value];
    for (let i = 0; i < 5; i += 1) current = addRow(current, rows, idsIn(current));

    expect(current).toHaveLength(4);
    expect(canAddRow(current, rows)).toBe(false);
  });

  it("removes rows down to minItems and never a row a cue targets", () => {
    const one = removeRow(value, 1, rows, []);

    expect(removeRow(one, 0, rows, [])).toEqual(one);
    expect(removeRow(value, 0, rows, ["latency"])).toEqual(value);
  });

  it("gives a new row a kebab id no element of the beat already has, and only its required fields", () => {
    const taken = new Set(["row-1", "row-2", "latency"]);

    const added = addRow(value, rows, taken).at(-1);

    expect(added).toEqual({ id: "row-3", left: "", right: "" });
    expect(uniqueId(new Set())).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("moves a row within the list and leaves an out-of-range move alone", () => {
    expect(moveRow(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveRow(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });
});

describe("a draft as an edit", () => {
  it("names only the top-level fields that changed, each whole", () => {
    const draft = { ...COMPARE.value, rows: ROWS.slice(0, 1) };

    expect(changedFields(COMPARE.value, draft)).toEqual({ rows: draft.rows });
    expect(changedFields(COMPARE.value, { ...COMPARE.value })).toEqual({});
  });

  it("places each problem at the slot path it names and keeps the rest general", () => {
    const placed = placeProblems(
      ["beats.b-compare.visual.slots.rows.1.left: Too big", "beats.b-compare.visual.slots.leftTitle: Too small", "beats.b-compare: the fill refused", "beats.b-list.visual.slots.title: Too big"],
      "b-compare",
    );

    expect(Object.fromEntries(placed.byPath)).toEqual({ "rows.1.left": ["Too big"], leftTitle: ["Too small"] });
    expect(placed.general).toEqual(["beats.b-compare: the fill refused", "beats.b-list.visual.slots.title: Too big"]);
  });
});

describe("the beat under the playhead", () => {
  it("is the beat whose [startS, endS) holds it, so a boundary opens the next beat", () => {
    expect(beatAt(PROPS.beats, 0)?.id).toBe("b-compare");
    expect(beatAt(PROPS.beats, 6.399)?.id).toBe("b-compare");
    expect(beatAt(PROPS.beats, 6.4)?.id).toBe("b-list");
    expect(beatAt(PROPS.beats, 12.8)).toBeNull();
  });
});
