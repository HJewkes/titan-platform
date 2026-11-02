import { describe, expect, it } from "vitest";
import { usePreCalibrationStatuses } from "./writing-statuses-fixtures.test-helpers.js";
import { L0_CHECKS } from "./eval-l0.js";
import {
  REGISTER_CHECK_IDS,
  REGISTER_MEASURES,
  REGISTER_METRICS,
  endsOnShortest,
  numberSpans,
  phraseSpans,
  registerCheck,
  spokenText,
  triadSpans,
  deviceSpans,
  type DeviceMetric,
  type RegisterMetric,
} from "./lint-register.js";
import { lint, tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

// These tests pin the mechanics on fixtures; the shipped status table is data a recalibration changes (TP-4662).
usePreCalibrationStatuses();

const measure = (metric: RegisterMetric, ...spoken: string[]): number | undefined => REGISTER_MEASURES[metric](spokenText(spoken));

// The tour's thesis_refs name h1, w4 and c1, so the first three beats carry those ids.
const THESIS_IDS = ["h1", "w4", "c1"];
const beats = (...spoken: string[]): BeatSpec[] => spoken.map((line, i) => [THESIS_IDS[i] ?? `b${i}`, "ch1", "WHAT", line]);
const rows = (...spoken: string[]) => lint(tour(beats(...spoken)), [registerCheck]);

// Ten words with no number, pronoun, contraction or device in them: a neutral base for the band tests.
const FILLER = "The queue moves each job to the next free worker.";
const filler = (n: number): string[] => Array.from({ length: n }, () => FILLER);

describe("spokenText", () => {
  it("reduces TTS markup to its word and joins the non-empty beats", () => {
    const parsed = spokenText(["We [read](/riːd/) it.", "  ", "Then [lead](=led) on."]);

    expect(parsed).toMatchObject({ text: "We read it. Then lead on.", sentences: ["We read it.", "Then lead on."], punctuated: true });
    expect(parsed.words).toHaveLength(6);
  });

  it("splits a sentence after a closing quote, dropping the quote as the harness does, and keeps a contraction one word", () => {
    const parsed = spokenText(['He said "stop." Then they\'re gone.']);

    expect(parsed.sentences).toEqual(['He said "stop.', "Then they're gone."]);
    expect(parsed.words).toEqual(["He", "said", "stop", "Then", "they're", "gone"]);
  });
});

describe("register metrics on hand-counted text", () => {
  it("counts a run of number words as one mention, and digits with a unit as one", () => {
    // "two hundred and five", "3" and "12 ms" over 16 words.
    expect(measure("numbers", "It took two hundred and five runs.", "We saw 3 failures and 12 ms of lag.")).toBe(187.5);
  });

  it("does not join number words across a semicolon", () => {
    expect(measure("numbers", "One; two; three.")).toBe(1000);
  });

  it("counts every second-person form, contracted or not", () => {
    expect(measure("second-person", "You know your tools. You'll see yourself in them.")).toBeCloseTo(444.444, 3);
  });

  it("counts we, our and us but not a word that starts with we", () => {
    expect(measure("we", "We said our piece to us. Wear it.")).toBe(375);
  });

  it("counts contractions", () => {
    expect(measure("contractions", "It's fine, don't worry, they're here.")).toBe(500);
  });

  it("counts an A, B, and C list, with or without the last comma", () => {
    expect(measure("triads", "We need speed, cost, and care. It stops.")).toBe(125);
    expect(measure("triads", "Pick red, green or blue.")).toBe(200);
  });

  it("counts a colon reveal but not a clock time or a numbered label", () => {
    expect(measure("colon-reveals", "The catch is simple: it waits. 10:30 is the time.")).toBeCloseTo(90.909, 3);
    expect(measure("colon-reveals", "Rule 2: keep it short.")).toBe(0);
  });

  it('counts "Y, not X" tails per script, not per 1k words', () => {
    expect(measure("not-x-tails", "It ships fast, not by luck. It holds: not the cache. It rests, not by the old north gate today.")).toBe(3);
  });

  it('counts "Y, never X" and "Y, no X" tails as the same device', () => {
    const tails = "Bake the loaf whole, never sliced. The oven warms once, no second pass needed.";

    const counted = measure("not-x-tails", tails);

    expect(counted).toBe(2);
  });

  it('does not count "never" or "no" inside a clause, or words that start with them', () => {
    const clauses = "The baker never rushes the dough. There is no second oven, nobody waits. It rests, nonetheless.";

    const counted = measure("not-x-tails", clauses);

    expect(counted).toBe(0);
  });

  it("counts semicolons", () => {
    expect(measure("semicolons", "One; two; three.")).toBeCloseTo(666.667, 3);
  });

  it('counts let\'s, "let us" and the unapostrophed "lets"', () => {
    expect(measure("lets", "Let's go. Let us see. Lets run.")).toBeCloseTo(428.571, 3);
  });

  it('counts a verbless "no X" and neither or nor, but not "no longer", "no one" or a word that starts with no', () => {
    // "no file", "no model", "neither" and "nor" over 22 words.
    const spoken = "It runs with no file and no model call, neither slow nor loud. No longer late, no one waits, and nobody knows.";

    expect(measure("neg-synthetic", spoken)).toBeCloseTo(181.818, 3);
  });

  it("counts downtoners as whole words only", () => {
    expect(measure("downtoners", "It only nearly works, almost. Merely onlyness.")).toBeCloseTo(571.429, 3);
  });

  it("measures sentence length mean and population CV", () => {
    const spoken = "One two three. One two three four five six seven eight nine. Go.";

    expect(measure("sentence-mean", spoken)).toBeCloseTo(4.3333, 4);
    expect(measure("sentence-cv", spoken)).toBeCloseTo(0.78446, 5);
    expect(measure("sentence-mean", "Go. ... Stop now.")).toBe(1.5);
  });

  it("leaves the CV unmeasured under 3 sentences, and every punctuation metric unmeasured on unpunctuated text", () => {
    const unpunctuated = Array.from({ length: 60 }, () => "word").join(" ");

    expect(measure("sentence-cv", "One two. Three four.")).toBeUndefined();
    const punctuationMetrics: RegisterMetric[] = ["sentence-mean", "sentence-cv", "triads", "colon-reveals", "not-x-tails"];

    expect(punctuationMetrics.map((metric) => measure(metric, unpunctuated))).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ]);
  });
});

// Synthetic paragraphs scored by the research harness's own definitions (measure.py, derived.py, phrases/measure.py) when this port
// was written; the numbers are pinned here so the port cannot drift from them unseen.
const PARITY: { spoken: string[]; expected: Record<RegisterMetric, number> }[] = [
  {
    spoken: [
      "The kettle server boils water for two hundred and forty cups a day.",
      "You'd think it waits for the tap; it doesn't.",
      "It reads the gauge, warms the coil, and opens the valve.",
      "The trick is simple: it [reads](=present) ahead.",
      "Let's follow one cup through the queue, not the whole batch.",
    ],
    expected: {
      numbers: 39.21568627450981, "second-person": 19.607843137254903, we: 0, "sentence-mean": 10.2,
      "sentence-cv": 0.19996154955265827, contractions: 58.8235294117647, triads: 19.607843137254903,
      "colon-reveals": 19.607843137254903, "not-x-tails": 1, semicolons: 19.607843137254903, lets: 19.607843137254903,
      phrases: 0, "neg-synthetic": 0, downtoners: 0,
    },
  },
  {
    spoken: [
      "We start where your order lands.",
      "The till hands it to the oven, the oven hands it to the shelf, and the shelf calls your name.",
      "Each step takes about 3 seconds, and a full loop takes 12 ms of planning.",
      "That's why we'll watch the shelf: it's the slow part.",
      "Nothing else matters as much, not even the oven.",
      "Let us see what happens when the shelf is full.",
      "It holds the order; you wait; the oven idles.",
    ],
    expected: {
      numbers: 25.31645569620253, "second-person": 37.9746835443038, we: 37.9746835443038, "sentence-mean": 11.285714285714286,
      "sentence-cv": 0.38394306045830634, contractions: 37.9746835443038, triads: 0, "colon-reveals": 12.658227848101266,
      "not-x-tails": 1, semicolons: 25.31645569620253, lets: 12.658227848101266,
      phrases: 12.658227848101266, "neg-synthetic": 0, downtoners: 0,
    },
  },
  {
    spoken: [
      "Picture a [lead](/lɛd/) pipe running under a quiet street.",
      "Water moves slowly here, so the meter counts one thousand and six drops before it reports.",
      "If you're the engineer, you'll want three numbers: pressure, flow, and age.",
      "Our tool shows them in one panel.",
      "It isn't fast, but it's honest about what it doesn't know.",
      "We've seen it catch a leak at 10:30 at night, not by luck.",
      "Lets be clear.",
      "The pipe was fine, the valve was not, and the street flooded anyway.",
    ],
    expected: {
      numbers: 58.8235294117647, "second-person": 23.529411764705884, we: 23.529411764705884, "sentence-mean": 10.625,
      "sentence-cv": 0.36735282343519987, contractions: 70.58823529411765, triads: 11.764705882352942,
      "colon-reveals": 11.764705882352942, "not-x-tails": 1, semicolons: 0, lets: 11.764705882352942,
      phrases: 0, "neg-synthetic": 0, downtoners: 0,
    },
  },
];

describe("parity with the research harness", () => {
  it.each(PARITY.map((p, i) => [i + 1, p] as const))("matches every metric on synthetic paragraph %i", (_, { spoken, expected }) => {
    const parsed = spokenText(spoken);

    for (const metric of REGISTER_METRICS) {
      expect(REGISTER_MEASURES[metric](parsed), metric).toBeCloseTo(expected[metric], 9);
    }
  });
});

describe("Q-V11 register rows", () => {
  it("is registered in L0 and emits one warning row per metric", () => {
    const emitted = [...rows(...filler(16)).values()];

    expect(L0_CHECKS).toContain(registerCheck);
    expect(emitted.map((row) => row.check_id)).toEqual(REGISTER_CHECK_IDS);
    expect(emitted.every((row) => row.severity === "warning")).toBe(true);
  });

  const CROWDED = "It took 3 runs and 12 ms.";
  const perBeat = (crowded: number, total: number, line = CROWDED) =>
    rows(...Array.from({ length: total }, (_, i) => (i < crowded ? line : FILLER))).get("register:numbers-per-beat");

  it("passes one crowded beat in twenty, a 5% share under the cap", () => {
    expect(perBeat(1, 20)).toMatchObject({ severity: "warning", pass: true, value: 0.05, threshold: 0.24, detail_beats: ["h1"] });
  });

  it("warns on five crowded beats in twenty, a 25% share, naming the beats", () => {
    expect(perBeat(5, 20)).toMatchObject({ pass: false, value: 0.25, threshold: 0.24, detail_beats: ["h1", "w4", "c1", "b3", "b4"] });
  });

  it("passes a script with no crowded beat", () => {
    expect(perBeat(0, 20)).toMatchObject({ pass: true, value: 0, detail_beats: [] });
  });

  it("reports but never warns on a 100-word script whose every beat is crowded", () => {
    const hundred = "It took 3 runs and 12 ms on the free worker.";
    const short = rows(...Array.from({ length: 10 }, () => hundred)).get("register:numbers-per-beat");

    expect(short).toMatchObject({ pass: true, value: 1 });
    expect(short?.detail_beats).toHaveLength(10);
  });

  it("counts a run of number words in a beat as one mention", () => {
    expect(perBeat(5, 20, "It took two hundred and five runs.")).toMatchObject({ pass: true, value: 0 });
  });

  it("counts a beat whose number words are split by other words as crowded", () => {
    expect(perBeat(5, 20, "It took two runs and five retries.")).toMatchObject({ pass: false, value: 0.25 });
  });

  it("warns on a rate over the band's cap and passes one inside it", () => {
    const capped = rows(...filler(16), "It stops; it starts.").get("register:semicolons");
    const clean = rows(...filler(16)).get("register:semicolons");

    expect(capped).toMatchObject({ pass: false, threshold: 0.6 });
    expect(capped?.value).toBeCloseTo(6.098, 3);
    expect(clean).toMatchObject({ value: 0, pass: true });
  });

  it("warns on one over-represented phrase in a 157-word script and passes the same script without it", () => {
    const stock = rows(...filler(15), "The ledger matters most to the desk.").get("register:phrases");
    const plain = rows(...filler(15), "The ledger counts most to the desk.").get("register:phrases");

    expect(stock).toMatchObject({ severity: "warning", pass: false, threshold: 0.58 });
    expect(stock?.value).toBeCloseTo(6.369, 3);
    expect(plain).toMatchObject({ value: 0, pass: true });
  });

  it('warns on one "no X" negation in a 157-word script and passes the same script without it', () => {
    const negated = rows(...filler(15), "The desk prints with no ledger row.").get("register:neg-synthetic");
    const plain = rows(...filler(15), "The desk prints without a ledger row.").get("register:neg-synthetic");

    expect(negated).toMatchObject({ severity: "warning", pass: false, threshold: 2.5 });
    expect(negated?.value).toBeCloseTo(6.369, 3);
    expect(plain).toMatchObject({ value: 0, pass: true });
  });

  it("reports a downtoner rate over its band but never warns on it", () => {
    const row = rows(...filler(16), "It only waits here.").get("register:downtoners");

    expect(row).toMatchObject({ severity: "warning", pass: true, threshold: 3.6 });
    expect(row?.value).toBeCloseTo(6.098, 3);
  });

  it("reports the share of beats that end on their shortest sentence against chance, and never warns", () => {
    const button = "The desk reads each scan before it prints a label. It never guesses.";
    const steady = "It waits. The desk reads each scan before it prints a label.";

    const row = rows(button, button, steady, steady, "One sentence only.").get("register:shortest-last");

    expect(row).toMatchObject({ severity: "warning", pass: true, value: 0.5, threshold: 0.5, detail_beats: ["h1", "w4"] });
  });

  it("warns below a floor, passes inside the band, and warns over the cap", () => {
    const secondPerson = (n: number) => rows(...filler(16), ...Array.from({ length: n }, () => "You see it.")).get("register:second-person");

    expect(secondPerson(0)).toMatchObject({ value: 0, pass: false, threshold: 9.78 });
    expect(secondPerson(3)).toMatchObject({ pass: true, threshold: 29.44 });
    expect(secondPerson(3)?.value).toBeCloseTo(17.751, 3);
    expect(secondPerson(10)).toMatchObject({ pass: false, threshold: 29.44 });
  });

  it("reports but never warns on a script under 150 words", () => {
    const short = rows(...filler(14), "It stops; it starts.");

    expect(short.get("register:semicolons")?.value).toBeCloseTo(6.944, 3);
    expect([...short.values()].every((row) => row.pass)).toBe(true);
  });

  it("reads an unmeasurable metric as 0 and never warns on it", () => {
    const unpunctuated = Array.from({ length: 54 }, () => "word").join(" ");

    expect(rows(unpunctuated, unpunctuated, unpunctuated).get("register:sentence-cv")).toMatchObject({ value: 0, pass: true });
  });
});

describe("numberSpans and triadSpans", () => {
  const LINES = [
    "It took two hundred and five runs and 3 retries.",
    "We saw 12 ms of lag, then one more stall.",
    "The desk, the ledger and the scanner all agree.",
    "Pick red, green or blue, then the queue, the worker and the log.",
    "Nothing here counts.",
  ];

  it("finds as many spans as the rows count, on every line", () => {
    for (const line of LINES) {
      const words = spokenText([line]).words.length;

      expect(numberSpans(line).length).toBeCloseTo(((measure("numbers", line) ?? 0) * words) / 1000);
      expect(triadSpans(line).length).toBeCloseTo(((measure("triads", line) ?? 0) * words) / 1000);
    }
  });

  it("returns each span's text at its index", () => {
    const line = LINES[3]!;
    const spans = triadSpans(line);

    expect(spans.map((s) => s.text)).toEqual(["Pick red, green or blue,", "then the queue, the worker and the log."]);
    expect(spans.map((s) => line.slice(s.index, s.index + s.text.length))).toEqual(spans.map((s) => s.text));
  });
});

describe("endsOnShortest", () => {
  it("is true only when the last of two or more sentences is shorter than every other", () => {
    expect(endsOnShortest("The desk reads each scan first. It prints.")).toBe(true);
    expect(endsOnShortest("It prints. The desk reads each scan first.")).toBe(false);
    expect(endsOnShortest("The desk prints. It waits now.")).toBe(false);
    expect(endsOnShortest("It prints.")).toBe(false);
  });
});

describe("phraseSpans", () => {
  it("finds a phrase across case and punctuation, as the harness's word stream does", () => {
    const text = "The catch. The result, is plain. Now how does it end?";

    expect(phraseSpans(text).map((span) => span.text)).toEqual(["The catch", "The result, is", "Now how"]);
  });

  it("skips a phrase word inside a longer word or a contraction", () => {
    expect(phraseSpans("It mattered once. The catcher sat in aloneness. The desk's quietly's?")).toEqual([]);
  });

  it("finds as many spans as the row counts", () => {
    const text = spokenText(["The desk stays on its own. That matters."]);

    expect(phraseSpans(text.text)).toHaveLength(((measure("phrases", text.text) ?? 0) * text.words.length) / 1000);
  });
});

describe("deviceSpans", () => {
  const LINES: readonly (readonly [DeviceMetric, string])[] = [
    ["colon-reveals", "The desk keeps one thing: the rows. Nothing else stays."],
    ["not-x-tails", "The ledger keeps the rows, not by hand. It never asks twice."],
    ["semicolons", "The desk checks a scan; the ledger keeps it. Then it waits."],
    ["lets", "Let's follow one scan. We let us see the ledger."],
  ];

  it.each(LINES)("finds as many %s spans as the row counts", (metric, line) => {
    const text = spokenText([line]);
    const counted = REGISTER_MEASURES[metric](text) ?? 0;
    const perScript = metric === "not-x-tails" ? counted : (counted * text.words.length) / 1000;
    expect(deviceSpans(metric, text.text).length).toBeGreaterThan(0);
    expect(deviceSpans(metric, text.text)).toHaveLength(Math.round(perScript));
  });
});
