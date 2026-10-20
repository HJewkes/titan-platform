import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AudioSpecSchema, buildAudioSpecs, stripPronunciationMarkup, type AudioSpec } from "./audio-spec.js";

const fixture = (path: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/spike/${path}`, import.meta.url), "utf8"));

// The v2 gen spec is not in the repo; its `repo` block and v2 beat kinds are read back from the golden.
const baseFrom = (golden: AudioSpec): unknown => ({
  repo: golden.repo,
  beats: golden.beats.map((b) => ({ id: b.id, kind: b.kind })),
});

const golden = (name: string, which: "full" | "synth"): AudioSpec =>
  AudioSpecSchema.parse(fixture(`goldens/${name}/make_sample.${which}.json`));

const SCRIPTS = [
  ["review-addendum-v5", "review-addendum-v5/script.json"],
  ["redesign-explainer-v4", "redesign-explainer-v4/script-full.json"],
] as const;

describe("buildAudioSpecs against the A2 goldens", () => {
  it.each(SCRIPTS)("matches the full and synth goldens for %s", (name, scriptPath) => {
    const full = golden(name, "full");
    const synth = golden(name, "synth");
    const built = buildAudioSpecs(fixture(scriptPath), baseFrom(full), full.title);
    expect(built.full).toEqual(full);
    expect(built.synth).toEqual(synth);
  });

  it("strips pronunciation markup from the full spec and keeps it in the synth spec", () => {
    const full = golden("review-addendum-v5", "full");
    const built = buildAudioSpecs(fixture("review-addendum-v5/script.json"), baseFrom(full), full.title);
    expect(built.full.beats.some((b) => /\]\(/.test(b.spoken))).toBe(false);
    expect(built.synth.beats.some((b) => /\]\(/.test(b.spoken))).toBe(true);
  });

  it("rejects a v2 beat the base spec has no kind for", () => {
    const script = {
      chapters: [],
      beats: [
        {
          id: "b",
          chapter: "c",
          band: "x",
          plannedS: 1,
          spoken: "s",
          origin: "v2",
          visual: { render: "HookBeat" },
        },
      ],
    };
    expect(() => buildAudioSpecs(script, { beats: [] }, "t")).toThrow("no kind for beat b");
  });
});

describe("stripPronunciationMarkup", () => {
  it("keeps the word of a phoneme or reading link", () => {
    expect(stripPronunciationMarkup("a [gif](/dʒɪf/) and [SQL](=sequel) here")).toBe("a gif and SQL here");
  });
});
