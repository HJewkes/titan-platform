import { describe, expect, it } from "vitest";
import { captionCues, toVtt, type CaptionWord } from "./captions.js";

/** Words half a second apart, each spoken for 0.4 s. */
function spoken(texts: readonly string[], fromS = 0): CaptionWord[] {
  return texts.map((text, i) => ({ text, startS: fromS + i * 0.5, endS: fromS + i * 0.5 + 0.4 }));
}

interface ParsedCue {
  startS: number;
  endS: number;
  text: string;
}

const seconds = (stamp: string): number => {
  const [h, m, s] = stamp.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

function parseVtt(vtt: string): ParsedCue[] {
  const [header, ...blocks] = vtt.split("\n\n");
  expect(header).toBe("WEBVTT");
  return blocks.filter((block) => block.trim() !== "").map((block) => {
    const [, timing = "", text = ""] = block.split("\n");
    const [start = "", end = ""] = timing.split(" --> ");
    return { startS: seconds(start), endS: seconds(end), text };
  });
}

describe("captions", () => {
  it("breaks nine short words into a cue of eight and a cue of one", () => {
    const words = spoken(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);

    const cues = captionCues(words);

    expect(cues.map((cue) => cue.length)).toEqual([8, 1]);
  });

  it("starts a new cue before a word that would take the line past 42 characters", () => {
    const words = spoken(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd"]);

    const cues = captionCues(words);

    expect(cues.map((cue) => cue.map((w) => w.text).join(" "))).toEqual(["aaaaaaaaaa bbbbbbbbbb cccccccccc", "dddddddddd"]);
  });

  it("keeps a line of exactly 42 characters together", () => {
    const words = spoken(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "ddddddddd"]);

    const cues = captionCues(words);

    expect(cues).toHaveLength(1);
  });

  it("ends a cue at a sentence end", () => {
    const words = spoken(["One", "line.", "Two", "lines."]);

    const cues = captionCues(words);

    expect(cues.map((cue) => cue.map((w) => w.text).join(" "))).toEqual(["One line.", "Two lines."]);
  });

  it("holds a cue 0.3 s past its last word unless the next cue starts sooner", () => {
    const words = [...spoken(["Early", "stop."]), ...spoken(["Next", "one."], 1.0), ...spoken(["Late."], 5)];

    const cues = parseVtt(toVtt(words));

    expect(cues.map((cue) => cue.endS)).toEqual([1.0, 2.2, 5.7]);
  });

  it("round-trips words through the VTT text: every word once, in order, at its start", () => {
    const words = spoken("The quick brown fox jumps over the lazy dog. It was not amused at all, said the narrator.".split(" "));

    const cues = parseVtt(toVtt(words));

    expect(cues.flatMap((cue) => cue.text.split(" "))).toEqual(words.map((w) => w.text));
    expect(cues.map((cue) => cue.startS)).toEqual(captionCues(words).map((cue) => cue[0]!.startS));
  });

  it("writes a header-only file when there are no words", () => {
    const vtt = toVtt([]);

    expect(vtt).toBe("WEBVTT\n\n");
  });
});
