import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STRUCTURE_COLUMNS, appendTsv, benchLayout, canonicalJson, freezeScript, rulesSha, scriptSha, type StructureRow } from "./eval-store.js";
import { scriptWith, tourV0 } from "./script-fixtures.test-helpers.js";

/** Rebuilds every object with its keys in reverse insertion order. */
function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, shuffleKeys(item)]));
}

const bench = () => benchLayout(mkdtempSync(join(tmpdir(), "explainer-bench-")));

describe("script_sha", () => {
  it("matches the sha Python's sorted, compact json.dumps gives the synthetic tour narration", () => {
    expect(scriptSha(tourV0)).toBe("8533593f9ea4");
    expect(scriptSha(scriptWith())).toBe("dd133e7dff24");
  });

  it("does not move when every object's keys are shuffled", () => {
    expect(scriptSha(shuffleKeys(tourV0))).toBe(scriptSha(tourV0));
    expect(scriptSha(shuffleKeys(scriptWith()))).toBe(scriptSha(scriptWith()));
  });

  it("moves when one spoken word changes", () => {
    const edited = { ...tourV0, beats: tourV0.beats.map((b, i) => (i === 0 ? { ...b, spoken: `${b.spoken}!` } : b)) };
    expect(scriptSha(edited)).not.toBe(scriptSha(tourV0));
  });

  it("writes non-ASCII text raw and sorts keys by code point, as UTF-8 json.dumps does", () => {
    const value = { "é": 0.5, b: [1, { z: "é", a: null, gone: undefined }], a: true };
    expect(canonicalJson(value)).toBe('{"a":true,"b":[1,{"a":null,"z":"é"}],"é":0.5}');
  });

  it("refuses a value JSON cannot carry", () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
  });
});

describe("freezeScript", () => {
  it("stores the script under its sha with its parent, and never rewrites a frozen copy", () => {
    const layout = bench();
    const sha = freezeScript(layout, tourV0, "aaaaaaaaaaaa");
    freezeScript(layout, shuffleKeys(tourV0), "bbbbbbbbbbbb");
    const frozen = JSON.parse(readFileSync(join(layout.scripts, `${sha}.json`), "utf8"));
    expect(frozen).toEqual({ script_sha: sha, parent_sha: "aaaaaaaaaaaa", script: tourV0 });
  });
});

describe("structure.tsv", () => {
  const row: StructureRow = {
    config_id: "tour-short/script-v1-01",
    script_sha: "dd133e7dff24",
    rules_sha: rulesSha("rules: []\n"),
    check_id: "map:new-boxes",
    mode: "tagged",
    severity: "error",
    value: 2,
    threshold: 0,
    pass: false,
    detail_beats: ["c2-1", "c2-2"],
  };

  it("writes a header once and a rule registry sha on every row", () => {
    const { structure } = bench();
    appendTsv(structure, STRUCTURE_COLUMNS, [row]);
    appendTsv(structure, STRUCTURE_COLUMNS, [{ ...row, check_id: "map:full-weight\tx", pass: true }]);
    const [header, ...lines] = readFileSync(structure, "utf8").trimEnd().split("\n");
    expect(header).toBe(STRUCTURE_COLUMNS.join("\t"));
    expect(lines).toEqual([
      `tour-short/script-v1-01\tdd133e7dff24\t${row.rules_sha}\tmap:new-boxes\ttagged\terror\t2\t0\tfalse\tc2-1,c2-2`,
      `tour-short/script-v1-01\tdd133e7dff24\t${row.rules_sha}\tmap:full-weight x\ttagged\terror\t2\t0\ttrue\tc2-1,c2-2`,
    ]);
  });

  it("refuses to append to a file laid out with other columns", () => {
    const { structure } = bench();
    appendTsv(structure, STRUCTURE_COLUMNS, []);
    writeFileSync(structure, "config_id\tscript_sha\tcheck_id\n");
    expect(() => appendTsv(structure, STRUCTURE_COLUMNS, [row])).toThrow(/columns/);
  });
});
