import { describe, expect, it } from "vitest";
import { runL0 } from "./eval-l0.js";
import { repairHint } from "./l0-repair-hints.js";
import { spokenTokenCheck, spokenTokenCheckWith, unaliasedTokens } from "./lint-spoken-tokens.js";
import { spokenDigitsCheck } from "./spoken-numbers.js";
import { GOOD_BEATS, tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

const kinds = (spoken: string) => unaliasedTokens(spoken).map(({ kind, text }) => `${kind}:${text}`);

const rowFor = (spoken: string, check = spokenTokenCheck) => runL0(tour(withBeat("w2", { spoken })), undefined, [check])[0]!;

describe("Q-V14 spoken print devices", () => {
  it("names each print device a voice would read aloud as written", () => {
    const found = kinds("The desk (and the ledger) keeps scans, e.g. refusals & retries, at a ninety % rate in/out.");

    expect(found).toEqual(["abbreviation:e.g.", "path:in/out", "symbol:(", "symbol:)", "symbol:&", "symbol:%"]);
  });

  it("names file paths, code tokens, unit symbols and acronyms", () => {
    const found = kinds("The desk reads ledger.json through scanParcel and print_label, run with --dry, in five ms over the API.");

    expect(found).toEqual(["path:ledger.json", "code:scanParcel", "code:print_label", "code:--dry", "unit:ms", "acronym:API"]);
  });

  it("passes plain words, hyphens, apostrophes and shouted two-letter words", () => {
    expect(kinds("The courier's re-run is OK, and it is NOT an error.")).toEqual(["acronym:NOT"]);
    expect(kinds("The courier's re-run is fine, and it is OK to wait.")).toEqual([]);
  });
});

describe("Q-V14 spoken aliases", () => {
  it("lets a phoneme override voice a token, but not a reading declaration", () => {
    expect(kinds("The [API](/ˌeɪpiˈaɪ/) answers.")).toEqual([]);
    expect(kinds("The [API](=noun) answers.")).toEqual(["acronym:API"]);
  });

  it("lets a lexicon entry voice every mention of its term, whatever the case", () => {
    const lexicon = { schema: "lexicon.v1" as const, entries: [{ term: "ledger.json", spoken: "the ledger file" }] };

    expect(unaliasedTokens("Then Ledger.JSON and ledger.json both load.", lexicon)).toEqual([]);
  });
});

describe("Q-V14 row", () => {
  it("fails as an error naming the beat whose spoken line holds an unaliased token", () => {
    expect(rowFor("The desk server asks the API before it prints.")).toMatchObject({ check_id: "Q-V14", severity: "error", pass: false, detail_beats: ["w2"] });
  });

  it("passes the clean tour and a token the given lexicon voices", () => {
    const lexicon = { schema: "lexicon.v1" as const, entries: [{ term: "API", spoken: "A P I" }] };

    expect(runL0(tour(GOOD_BEATS), undefined, [spokenTokenCheck])[0]).toMatchObject({ pass: true, detail_beats: [] });
    expect(rowFor("The desk server asks the API before it prints.", spokenTokenCheckWith(lexicon))).toMatchObject({ pass: true });
  });

  it("hints each token with its kind and the ways to voice it", () => {
    const script = tour(withBeat("w2", { spoken: "The desk server asks the API, i.e. the ledger." }));
    const row = runL0(script, undefined, [spokenTokenCheck])[0]!;

    expect(repairHint(row, script)).toMatch(/w2 "i\.e\." \(abbreviation\), "API" \(acronym\).*lexicon entry/);
  });
});

describe("Q-V12 repair hint", () => {
  it("shows the failing line with its digits spelled as words", () => {
    const script = tour(withBeat("w2", { spoken: "The desk server holds 3 scans until the ledger confirms." }));
    const row = runL0(script, undefined, [spokenDigitsCheck])[0]!;

    expect(row).toMatchObject({ severity: "error", pass: false });
    expect(repairHint(row, script)).toContain('w2 "The desk server holds three scans');
  });
});
