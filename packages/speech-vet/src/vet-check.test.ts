import type { Audio, SttProvider, Transcript } from "@titan-design/speech-stt";
import { misakiToIpa } from "@titan-design/speech-g2p";
import { describe, expect, it } from "vitest";
import type { PhonemeToken } from "./heteronyms.js";
import type { PhoneRecognizer } from "./phone-verdicts.js";
import type { PhoneG2p } from "./phones.js";
import { checkTake, ESCALATE_UNDECLARED_HETERONYMS, type CheckContext } from "./vet-check.js";

// Constructed sentences, a one-letter-per-phone dictionary, and scripted transcripts and phone strings.
const LEXICON: Readonly<Record<string, string>> = {
  we: "wi",
  need: "nid",
  to: "tu",
  get: "gɛt",
  him: "hɪm",
  here: "hɪɹ",
  zorptrix: "zɔɹptɹɪks",
  the: "ðə",
  show: "ʃoʊ",
  is: "ɪz",
  live: "laɪv",
};
const g2p: PhoneG2p = (text) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => LEXICON[w] ?? w)
    .join(" ");
const phonesOf = (text: string) => text.split(" ").map((w) => LEXICON[w]).join("");
const AUDIO: Audio = { samples: new Float32Array(0), sampleRate: 16_000 };

const LINE = "we need to get him here";
const CLEAN = phonesOf(LINE);
const GARBLED_NEED = CLEAN.replace("nid", "zʌk");

function transcript(text: string, avgLogprob?: number): Transcript {
  const words = text.split(" ").map((w, i) => ({ text: w, start: i * 0.3, end: i * 0.3 + 0.25 }));
  const segment = { text, start: 0, end: words.length * 0.3, ...(avgLogprob === undefined ? {} : { avgLogprob }) };
  return { text, words, segments: [segment] };
}

function stt(transcripts: Transcript[], tokenLogprobs = false): SttProvider & { calls: number } {
  const provider = {
    calls: 0,
    capabilities: { tokenLogprobs },
    async transcribe(): Promise<Transcript> {
      return transcripts[Math.min(provider.calls++, transcripts.length - 1)]!;
    },
  };
  return provider;
}

function recognizer(phones: string): PhoneRecognizer & { calls: number } {
  const r = {
    calls: 0,
    async recognize(): Promise<string> {
      r.calls++;
      return phones;
    },
  };
  return r;
}

function context(over: Partial<CheckContext> & Pick<CheckContext, "stt">): CheckContext {
  return { plain: LINE, voiceSpoken: LINE, phoneG2p: g2p, toIpa: misakiToIpa, ...over };
}

const take = { audio: AUDIO };
const FEED = transcript("we feed to get him here");

describe("checkTake: substitutions and their phone verdicts", () => {
  it("a substitution whose phones are clean is dismissed, not a fault", async () => {
    const check = await checkTake(take, context({ stt: stt([FEED]), recognizer: recognizer(CLEAN) }));
    expect(check.defects.map((d) => d.expected)).toEqual(["need"]);
    expect(check.faults).toEqual([]);
    expect(check.dismissed.map((v) => [v.word, v.source])).toEqual([["need", "whisper"]]);
  });

  it("the same substitution with garbled phones is one word fault naming the word", async () => {
    const check = await checkTake(take, context({ stt: stt([FEED]), recognizer: recognizer(GARBLED_NEED) }));
    expect(check.faults).toEqual([expect.objectContaining({ kind: "word", word: "need" })]);
    expect(check.distances.get("need")).toEqual(expect.objectContaining({ faulty: true }));
  });

  it("without a recognizer the substitution stays an unadjudicated word fault and no phone data exists", async () => {
    const check = await checkTake(take, context({ stt: stt([FEED]) }));
    expect(check.faults).toEqual([expect.objectContaining({ kind: "word", word: "need", detail: expect.stringContaining("unadjudicated") })]);
    expect(check.phones).toBeUndefined();
    expect(check.distances.size).toBe(0);
    expect(check.hallucinations).toEqual([]);
  });

  it("a recognizer without a phoneG2p throws a TypeError before any transcription", async () => {
    const provider = stt([FEED]);
    const ctx = context({ stt: provider, recognizer: recognizer(CLEAN) });
    delete ctx.phoneG2p;
    await expect(checkTake(take, ctx)).rejects.toBeInstanceOf(TypeError);
    expect(provider.calls).toBe(0);
  });

  it("babble in the phones is a hallucination fault and the clean phones are not", async () => {
    const babbled = `${CLEAN.slice(0, 4)}ʌbʌbʌbʌ${CLEAN.slice(4)}`;
    const check = await checkTake(take, context({ stt: stt([transcript(LINE)]), recognizer: recognizer(babbled) }));
    expect(check.faults.map((f) => f.kind)).toEqual(["hallucination"]);
    const clean = await checkTake(take, context({ stt: stt([transcript(LINE)]), recognizer: recognizer(CLEAN) }));
    expect(clean.faults).toEqual([]);
  });
});

describe("checkTake: the confirming STT", () => {
  it("drops a base defect the confirming transcript does not repeat", async () => {
    const confirm = stt([transcript(LINE)]);
    const check = await checkTake(take, context({ stt: stt([FEED]), confirmStt: confirm }));
    expect(confirm.calls).toBe(1);
    expect(check.defects).toEqual([]);
    expect(check.faults).toEqual([]);
  });

  it("keeps a base defect the confirming transcript repeats", async () => {
    const check = await checkTake(take, context({ stt: stt([FEED]), confirmStt: stt([FEED]) }));
    expect(check.defects.map((d) => d.expected)).toEqual(["need"]);
  });
});

describe("checkTake: signal A follows the STT's declared capability (R2)", () => {
  const doubtful = transcript(LINE, -1.6);

  // Catches: { confidence: true } hard-coded, which reads signal A from an STT that does not fill it.
  it("a −1.6 avgLogprob segment from an STT declaring tokenLogprobs: false is no fault", async () => {
    const check = await checkTake(take, context({ stt: stt([doubtful], false) }));
    expect(check.faults).toEqual([]);
  });

  // Catches: {} passed instead, which ignores signal A from an STT that fills it.
  it("the same transcript from an STT declaring tokenLogprobs: true is one low-confidence fault", async () => {
    const check = await checkTake(take, context({ stt: stt([doubtful], true) }));
    expect(check.faults.map((f) => f.kind)).toEqual(["low-confidence"]);
  });

  it("the confirming STT is judged by its own capability, not the base STT's", async () => {
    const check = await checkTake(take, context({ stt: stt([doubtful], true), confirmStt: stt([doubtful], false) }));
    expect(check.defects).toEqual([]);
  });
});

describe("checkTake: override words are judged as unusual", () => {
  const LONG_LINE = "we need zorptrix here";
  const HEARD = transcript("we need zorpfix here");
  // Five of the word's nine phones garbled: over the ordinary threshold (0.45), under the unusual one (0.7).
  const HALF = phonesOf(LONG_LINE).replace("zɔɹptɹɪks", "zɔɹpʌʌʌʌʌ");
  const long = (over: Partial<CheckContext>) => context({ plain: LONG_LINE, voiceSpoken: LONG_LINE, stt: stt([HEARD]), recognizer: recognizer(HALF), ...over });

  it("is a word fault without the override", async () => {
    const check = await checkTake(take, long({}));
    expect(check.faults.map((f) => [f.kind, f.word])).toEqual([["word", "zorptrix"]]);
  });

  it("is no fault when the word carries an override", async () => {
    const check = await checkTake(take, long({ overrideWords: ["zorptrix"] }));
    expect(check.faults).toEqual([]);
  });
});

describe("checkTake: heard readings and D-T11-3", () => {
  const SHOW = "the show is live";
  // misaki tokens as the G2P emitted them: the line read with the adjective, live = laɪv.
  const tokens: PhonemeToken[] = [
    { text: "the", phonemes: "ðə", whitespace: " " },
    { text: "show", phonemes: "ʃˈO", whitespace: " " },
    { text: "is", phonemes: "ɪz", whitespace: " " },
    { text: "live", phonemes: "lˈIv", whitespace: "" },
  ];
  const ADJ = "ðəʃoʊɪzlaɪv";
  const VERB = "ðəʃoʊɪzlɪv";
  const show = (phones: string, over: Partial<CheckContext>) =>
    checkTake(take, context({ plain: SHOW, stt: stt([transcript(SHOW)]), recognizer: recognizer(phones), tokens, ...over }));

  it("defaults to warn-only", () => {
    expect(ESCALATE_UNDECLARED_HETERONYMS).toBe(false);
  });

  it("a declared reading the audio contradicts is a reading fault", async () => {
    const check = await show(ADJ, { voiceSpoken: "the show is [live](=verb)" });
    expect(check.faults.map((f) => [f.kind, f.word])).toEqual([["reading", "live"]]);
    expect(check.heard.map((r) => r.status)).toEqual(["fail"]);
  });

  it("warn-only: an undeclared heteronym the audio contradicts is reported apart and is no fault", async () => {
    const check = await show(VERB, { voiceSpoken: SHOW, escalateUndeclared: false });
    expect(check.undeclaredHeard.map((r) => [r.word, r.declared, r.heard, r.status])).toEqual([["live", "adj", "verb", "fail"]]);
    expect(check.heard).toEqual([]);
    expect(check.faults).toEqual([]);
  });

  it("escalated: the same contradiction joins heard and is a reading fault", async () => {
    const check = await show(VERB, { voiceSpoken: SHOW, escalateUndeclared: true });
    expect(check.heard.map((r) => r.status)).toEqual(["fail"]);
    expect(check.faults.map((f) => [f.kind, f.word])).toEqual([["reading", "live"]]);
  });

  it("an undeclared heteronym read as G2P chose it contradicts nothing", async () => {
    const check = await show(ADJ, { voiceSpoken: SHOW, escalateUndeclared: true });
    expect(check.undeclaredHeard).toEqual([]);
    expect(check.faults).toEqual([]);
  });

  it("a declared occurrence is never re-declared at the G2P reading", async () => {
    const check = await show(VERB, { voiceSpoken: "the show is [live](=verb)", escalateUndeclared: true });
    expect(check.undeclaredHeard).toEqual([]);
    expect(check.faults).toEqual([]);
  });

  it("a text voice (no tokens) skips the reading check", async () => {
    const check = await show(VERB, { voiceSpoken: SHOW, tokens: undefined });
    expect(check.heard).toEqual([]);
    expect(check.undeclaredHeard).toEqual([]);
  });
});
