import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_COLUMNS, ownerSessionDir, prepareOwnerSession, recordOwnerSession, renderOwnerStoryboard, type OwnerAnswer } from "./eval-owner.js";
import { benchLayout, scriptSha } from "./eval-store.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

const mapped = ScriptSchema.parse(
  scriptWith({
    why: { need: "one place to refuse a bad label", actor: "the desk server", consequence: "no ghost parcel reaches the ledger" },
    visual: {
      assertion: "One server sits between every scanner and the ledger",
      job: "map",
      map_state: { level: "containers", visible: ["scanner", "desk", "ledger"], reveal: [{ id: "desk", atCue: "server" }] },
      labels: ["desk | server"],
      chips: [{ kind: "verified", text: "seen in the scan log" }],
    },
  }),
);
const offMap = ScriptSchema.parse(
  scriptWith({ spoken: "A label is refused at the desk.", visual: { assertion: "The desk refuses labels", job: "code-proof" } }, { id: "parcel-desk-v2" }),
);
const versions = [
  { config_id: "tour-short/script-v1-01", script: mapped },
  { config_id: "tour-short/script-v1-02", script: offMap },
];

const bench = () => benchLayout(mkdtempSync(join(tmpdir(), "explainer-owner-")));
const firstPick = () => 0;
const answers: OwnerAnswer[] = [
  { label: "A", scope: "ch2", item: "rating", value: "4", note: "what would make it a 5: name the ledger" },
  { label: "B", scope: "ch2", item: "rating", value: "2" },
  { label: "A", scope: "script", item: "preference", value: "preferred" },
];
const options = { date: "2026-10-13", heldOut: false };

describe("owner storyboard", () => {
  it("shows the narration beside the visual track's assertion and map_state summary", () => {
    const board = renderOwnerStoryboard(mapped, "A");

    expect(board).toContain("| Narration | Visual |");
    expect(board).toContain("Every scan passes one desk server before it reaches the ledger.");
    expect(board).toContain("**One server sits between every scanner and the ledger**");
    expect(board).toContain("map: containers · here: none · shows: desk, ledger, scanner");
    expect(board).toContain('on "server": reveal desk');
    expect(board).toContain("chip (verified): seen in the scan log");
    expect(board).toContain("_why:_ one place to refuse a bad label");
  });

  it("says when the map is off screen and keeps a pipe from splitting the table", () => {
    expect(renderOwnerStoryboard(offMap, "B")).toContain("map: off screen");
    expect(renderOwnerStoryboard(mapped, "A")).toContain("labels: desk \\| server");
  });

  it("never names the version it shows", () => {
    const board = renderOwnerStoryboard(mapped, "A");

    expect(board).not.toContain(mapped.id);
    expect(board).not.toContain(scriptSha(mapped));
  });
});

describe("blind owner session", () => {
  it("writes one storyboard per label and leaves the key sealed", () => {
    const layout = bench();

    const labels = prepareOwnerSession(layout, "s1", versions, { pick: firstPick });

    const dir = ownerSessionDir(layout, "s1");
    expect(labels).toEqual(["A", "B"]);
    expect(readdirSync(dir).sort()).toEqual(["key.sealed", "storyboard-A.md", "storyboard-B.md"]);
    expect(readFileSync(join(dir, "key.sealed"), "utf8")).not.toContain("tour-short");
    expect(existsSync(join(layout.scripts, `${scriptSha(mapped)}.json`))).toBe(true);
  });

  it("records ratings against the hidden versions, then opens the key", () => {
    const layout = bench();
    prepareOwnerSession(layout, "s1", versions, { pick: firstPick });

    const key = recordOwnerSession(layout, "s1", answers, options);

    const rows = readFileSync(join(layout.evals, "owner.tsv"), "utf8").trimEnd().split("\n");
    expect(rows[0]).toBe(OWNER_COLUMNS.join("\t"));
    const preference = rows[3]!.split("\t");
    expect(preference.slice(0, 8)).toEqual(["2026-10-13", "s1", "n", key.A!.config_id, key.A!.script_sha, "script", "preference", "preferred"]);
    expect(preference[9]).toBe("owner/s1/key.json");
    expect(existsSync(join(ownerSessionDir(layout, "s1"), "key.json"))).toBe(true);
  });

  it("keeps the key sealed when the rating cannot be written", () => {
    const layout = bench();
    prepareOwnerSession(layout, "s1", versions, { pick: firstPick });
    writeFileSync(join(layout.evals, "owner.tsv"), "a stale header\n");

    expect(() => recordOwnerSession(layout, "s1", answers, options)).toThrow(/columns/);

    expect(existsSync(join(ownerSessionDir(layout, "s1"), "key.json"))).toBe(false);
  });

  it("keeps the key sealed when an answer names a label the session lacks", () => {
    const layout = bench();
    prepareOwnerSession(layout, "s1", versions, { pick: firstPick });

    expect(() => recordOwnerSession(layout, "s1", [{ label: "C", scope: "ch2", item: "rating", value: "3" }], options)).toThrow(/label C/);

    expect(existsSync(join(ownerSessionDir(layout, "s1"), "key.json"))).toBe(false);
    expect(existsSync(join(layout.evals, "owner.tsv"))).toBe(false);
  });

  it("refuses to rate a session twice or open a key with no answers", () => {
    const layout = bench();
    prepareOwnerSession(layout, "s1", versions, { pick: firstPick });

    expect(() => recordOwnerSession(layout, "s1", [], options)).toThrow(/no answers/);
    recordOwnerSession(layout, "s1", answers, options);
    expect(() => recordOwnerSession(layout, "s1", answers, options)).toThrow(/already rated/);
  });

  it("refuses a single version and a reused session id", () => {
    const layout = bench();

    expect(() => prepareOwnerSession(layout, "s1", versions.slice(0, 1))).toThrow(/2–26 versions/);
    prepareOwnerSession(layout, "s1", versions);
    expect(() => prepareOwnerSession(layout, "s1", versions)).toThrow(/already exists/);
  });
});
