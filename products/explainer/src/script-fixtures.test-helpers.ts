// A synthetic tour of an invented repo, shaped like the motion spike's tour-v0.json and its probe.
export const tourV0 = {
  title: "parcel-desk, a repo tour",
  chapters: [
    { id: "ch1", n: 1, title: "Cold open", question: "Why refuse a label?", plannedS: 20, station: null },
    { id: "ch2", n: 2, title: "Architecture map", question: "Which part matters?", plannedS: 40, station: "S3" },
  ],
  beats: [
    { id: "c1-1-hook", chapter: "ch1", kind: "hook", band: "hook", plannedS: 8, spoken: "A courier prints a label for a parcel that does not exist." },
    { id: "c2-1-stations", chapter: "ch2", kind: "station-map", band: "diagram", plannedS: 14, spoken: "Every scan passes one desk server before it reaches the ledger." },
    { id: "c2-2-cli", chapter: "ch2", kind: "terminal", band: "diagram", plannedS: 10, spoken: "Run the scan command and watch it answer." },
    { id: "c2-3-outro", chapter: "ch2", kind: "outro", band: "takeaways", plannedS: 6, heldS: 2, spoken: "That is the desk." },
  ],
};

const text = (cls: string, value: string) => ({ text: value, px: 36, tag: "span", cls });

export const tourProbe = {
  page: "parcel-desk-passA",
  beats: [
    {
      id: "c1-1-hook",
      startS: 0,
      shots: [
        { t: 2, texts: [text("ex-headline", "The desk refused a label")] },
        {
          t: 6,
          texts: [
            text("beat-eyebrow", "illustrative parcel"),
            text("ex-headline", "The desk refused its own label"),
            text("ex-hook-label", "print_label"),
          ],
        },
      ],
    },
    {
      id: "c2-1-stations",
      startS: 8,
      shots: [
        {
          t: 20,
          texts: [
            text("ex-headline", "The parts, in scan order"),
            text("beat-eyebrow", "seen in the scan log"),
            ...["Scanner", "Desk server", "Ledger"].flatMap((label, i) => [text("ex-map-step", String(i + 1)), text("ex-map-label", label)]),
          ],
        },
      ],
    },
    { id: "c2-2-cli", startS: 22, shots: [{ t: 30, texts: [text("beat-terminal-out","scanned 1 parcel")] }] },
  ],
  cues: [],
};

const todoVideo = {
  audience: "TODO: audience",
  stake: "TODO: stake",
  promise: "TODO: promise",
  thesis_mechanism: "TODO: thesis",
  running_example: "TODO: example",
  simplifications: [],
  close_type: "TODO: close",
};

/** A minimal valid script/v1 with one map beat; override any beat field through `beat`. */
export function scriptWith(beat: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    schema: "script/v1",
    id: "parcel-desk-v1",
    profile: "repo-tour",
    facts_pack: "facts.tsv",
    video: { ...todoVideo, map: { id: "pd-l1", layout_sha: "abc123", layout_source: "code-graph" } },
    chapters: [{ id: "ch2", label: "S3 · Which part matters?", question: "Which part matters?" }],
    beats: [
      {
        id: "c2-1-stations",
        chapter: "ch2",
        function: "WHAT",
        mode: "explain",
        plannedS: 14,
        spoken: "Every scan passes one desk server before it reaches the ledger.",
        fact_ids: ["F1"],
        visual: { assertion: "One server sits between every scanner and the ledger", job: "map" },
        ...beat,
      },
    ],
    ...extra,
  };
}
