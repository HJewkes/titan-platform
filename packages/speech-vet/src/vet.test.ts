import { ttsTokens, type G2p, type G2pToken } from "@titan-design/speech-g2p";
import type { Transcript } from "@titan-design/speech-stt";
import { fakeTts, type FakeTtsProvider } from "@titan-design/speech-tts";
import { describe, expect, it } from "vitest";
import type { Lexicon } from "./lexicon.js";
import type { PhoneG2p } from "./phones.js";
import { synthesizeVerified } from "./retake.js";
import { vet, type VetDeps, type VetPolicy, type VetReport, type VetResult, type VetTake } from "./vet.js";
import { scriptedRecognizer, scriptedStt, transcriptOf } from "./vet.test-helpers.js";

// Constructed lines, a one-letter-per-phone IPA dictionary, a hand misaki dictionary, and scripted transcripts and phones.
const IPA: Readonly<Record<string, string>> = {
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
const MISAKI: Readonly<Record<string, string>> = {
  we: "wˈi",
  need: "nˈid",
  to: "tə",
  get: "ɡˈɛt",
  him: "hˌɪm",
  here: "hˈɪɹ",
  the: "ðə",
  show: "ʃˈO",
  is: "ɪz",
  live: "lˈIv",
};
const phoneG2p: PhoneG2p = (text) =>
  text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => IPA[w] ?? w)
    .join(" ");
const phonesOf = (text: string) => text.split(" ").map((w) => IPA[w]).join("");

const OVERRIDE = /^\[([^\]]+)\]\(\/([^)]*)\/\)$/;

/** Splits on spaces and reads each word from MISAKI; a `[w](/phonemes/)` override is honoured, as misaki does. */
const handG2p: Pick<G2p, "tokens" | "version"> = {
  version: "hand-g2p",
  tokens: (text) =>
    text.split(" ").map((word, i, words): G2pToken => {
      const [, linked, forced] = OVERRIDE.exec(word) ?? [];
      const phonemes = forced ?? MISAKI[word.toLowerCase()] ?? null;
      return { text: linked ?? word, tag: "", phonemes, whitespace: i < words.length - 1 ? " " : "", rating: null };
    }),
};

const LINE = "we need to get him here";
const CLEAN = phonesOf(LINE);
const babbled = (babble: string) => `${CLEAN.slice(0, 4)}${babble}${CLEAN.slice(4)}`;
const garbled = (need: string) => CLEAN.replace("nid", need);
const HEARD = transcriptOf(LINE);
const FEED = transcriptOf("we feed to get him here");

const misakiVoice = () => fakeTts();
const textVoice = () => fakeTts({ capabilities: { phonemeInput: [] } });

function deps<O extends Partial<VetDeps>>(over: O) {
  const base: VetDeps & { tts: FakeTtsProvider; stt: ReturnType<typeof scriptedStt> } = {
    tts: misakiVoice(),
    voice: "fake-a",
    stt: scriptedStt([HEARD]),
    g2p: handG2p,
    phoneG2p,
  };
  return { ...base, ...over };
}

function scripted(transcripts: Transcript[], phones: string[], over: Partial<VetDeps> = {}) {
  const stt = scriptedStt(transcripts);
  const recognizer = scriptedRecognizer(phones);
  return { d: deps({ stt, recognizer, ...over }), stt, recognizer };
}

function kept(result: VetResult): VetTake | undefined {
  return result.status === "stopped" ? undefined : result.take;
}

const faultsOf = (report: VetReport, attempt: number) => report.takes[attempt - 1]?.faults.map((f) => [f.kind, f.word]);

describe("vet: the precheck", () => {
  // Mutation: the precheck run after synthesis makes a call before stopping.
  it("(a) a declared reading the G2P contradicts stops with no synthesis and no transcription", async () => {
    const d = deps({});
    const result = await vet("the show is [live](=verb)", d);
    expect(result.status).toBe("stopped");
    expect(result.status === "stopped" && result.findings.map((f) => [f.word, f.reading, f.status])).toEqual([["live", "adj", "fail"]]);
    expect(d.tts.calls.length).toBe(0);
    expect(d.stt.calls).toBe(0);
    expect(result.report.stopReason).toBe("precheck");
    expect(result.report.takes).toEqual([]);
  });

  // Mutation: reporting `verified` for a voice that never speaks the checked tokens.
  it("(d) a text-only voice reports the precheck unverifiable and gets text, not tokens", async () => {
    const d = deps({ tts: textVoice(), g2p: undefined });
    const result = await vet(LINE, d);
    expect(result.report.precheck.status).toBe("unverifiable");
    expect(d.tts.calls[0]?.input).toEqual({ text: LINE });
    expect(result.status).toBe("accepted");
  });

  it("an undeclared heteronym stops only under undeclaredHeteronym: fail", async () => {
    const strict = deps({});
    const stopped = await vet("the show is live", strict, { undeclaredHeteronym: "fail" });
    expect(stopped.status).toBe("stopped");
    expect(strict.tts.calls.length).toBe(0);
    const lenient = await vet("the show is live", deps({ stt: scriptedStt([transcriptOf("the show is live")]) }));
    expect(lenient.report.precheck).toEqual(expect.objectContaining({ status: "verified" }));
    expect(lenient.status).toBe("accepted");
  });

  it("a misaki voice with no g2p throws a TypeError before any synthesis", async () => {
    const d = deps({ g2p: undefined });
    await expect(vet(LINE, d)).rejects.toBeInstanceOf(TypeError);
    expect(d.tts.calls.length).toBe(0);
  });

  it("a recognizer with no phoneG2p throws a TypeError before any synthesis", async () => {
    const d = deps({ recognizer: scriptedRecognizer([CLEAN]), phoneG2p: undefined });
    await expect(vet(LINE, d)).rejects.toBeInstanceOf(TypeError);
    expect(d.tts.calls.length).toBe(0);
  });

  it("a negative retake budget is a RangeError", async () => {
    await expect(vet(LINE, deps({}), { maxRetakes: -1 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("vet: what the voice is given", () => {
  // Mutation: sending { text } lets the provider re-run G2P and read the line its own way.
  it("(g) a misaki voice gets exactly the checked tokens", async () => {
    const d = deps({});
    await vet(LINE, d);
    expect(d.tts.calls[0]?.input).toEqual({ tokens: ttsTokens(handG2p.tokens(LINE)), alphabet: "misaki" });
  });

  const zorptrix: Lexicon = { schema: "lexicon.v1", entries: [{ term: "zorptrix", respell: "zorptricks", phonemes: { misaki: "zˈɔɹptɹɪks" } }] };
  const LONG = "we need zorptrix here";
  // Five of the word's nine phones garbled: over the ordinary threshold (0.45), under the override one (0.7).
  const HALF = phonesOf(LONG).replace("zɔɹptɹɪks", "zɔɹpʌʌʌʌʌ");

  it("a lexicon override reaches a misaki voice's tokens and its word is judged leniently", async () => {
    const { d } = scripted([transcriptOf("we need zorpfix here")], [HALF], { lexicon: zorptrix });
    const result = await vet(LONG, d);
    expect(d.tts.calls[0]?.input).toEqual(expect.objectContaining({ tokens: expect.arrayContaining([{ text: "zorptrix", phonemes: "zˈɔɹptɹɪks", whitespace: " " }]) }));
    expect(result.status).toBe("accepted");
    const bare = await vet(LONG, scripted([transcriptOf("we need zorpfix here")], [HALF]).d);
    expect(bare.status).toBe("needs-override");
  });

  it("a text voice gets the respelled plain text", async () => {
    const d = deps({ tts: textVoice(), g2p: undefined, lexicon: zorptrix });
    await vet("we need [zorptrix](=noun) here", d);
    expect(d.tts.calls[0]?.input).toEqual({ text: "we need zorptricks here" });
  });
});

describe("vet: the retake loop", () => {
  // Mutation: the first take always kept.
  it("(b) a babbling take 1 is replaced by a clean take 2", async () => {
    const { d } = scripted([HEARD], [babbled("ʌbʌbʌb"), CLEAN]);
    const result = await vet(LINE, d);
    expect(result.status).toBe("accepted");
    expect(result.report.keptAttempt).toBe(2);
    expect(result.report.takes.length).toBe(2);
    expect(result.report.takes.map((t) => t.kept)).toEqual([false, true]);
  });

  // Mutation: `attempt < maxRetakes` (3 calls) or no bound.
  it("(c) every take garbling a word spends exactly the budget and keeps the least severe take", async () => {
    const { d, stt, recognizer } = scripted([FEED], [garbled("zʌk"), garbled("nʌʌʌk"), garbled("zʌʃ"), garbled("vʌk")]);
    const result = await vet(LINE, d, { maxRetakes: 3 });
    expect([d.tts.calls.length, stt.calls, recognizer.calls]).toEqual([4, 4, 4]);
    expect(result.report.keptAttempt).toBe(2);
    expect(result.report.stopReason).toBe("budget");
    expect(result.status === "needs-override" && result.word).toBe("need");
  });

  // The task's mutation: a cycle that accepts a retake without re-vetting it keeps take 2.
  it("(e) every retake is checked in full: a babble-free take 2 that garbles a word loses to a clean take 3", async () => {
    const { d, stt, recognizer } = scripted([HEARD, FEED, HEARD], [babbled("ʌbʌbʌb"), garbled("zʌk"), CLEAN]);
    const result = await vet(LINE, d);
    expect(result.status).toBe("accepted");
    expect(result.report.keptAttempt).toBe(3);
    expect([d.tts.calls.length, stt.calls, recognizer.calls]).toEqual([3, 3, 3]);
    expect(faultsOf(result.report, 2)).toEqual([["word", "need"]]);
    expect(kept(result)?.transcript).toBe(HEARD);
  });

  // Mutation: the futility check removed spends the whole default budget, 6 calls.
  it("(f) a take heard the same as the one before stops the loop as futile", async () => {
    const { d } = scripted([FEED], [garbled("zʌk")]);
    const result = await vet(LINE, d);
    expect(d.tts.calls.length).toBe(2);
    expect(result.report.stopReason).toBe("futile");
    expect(result.report.keptAttempt).toBe(1);
    expect(result.status === "needs-override" && result.word).toBe("need");
  });

  it("a substitution the phones clear is dismissed and the take accepted", async () => {
    const { d, recognizer } = scripted([FEED], [CLEAN]);
    const result = await vet(LINE, d);
    expect(result.status).toBe("accepted");
    expect(recognizer.calls).toBe(1);
    expect(result.report.takes[0]?.dismissed.map((v) => [v.word, v.source])).toEqual([["need", "whisper"]]);
  });

  it("only stochastic faults left at the end of the budget is retakes-exhausted with the least severe take (D-T11-4)", async () => {
    const { d } = scripted([HEARD], [babbled("ʌbʌbʌbʌbʌb"), babbled("ʌkʌkʌkʌ")]);
    const result = await vet(LINE, d, { maxRetakes: 1 });
    expect(result.status).toBe("retakes-exhausted");
    expect(result.report.keptAttempt).toBe(2);
    expect(result.status === "retakes-exhausted" && result.faults.map((f) => f.kind)).toEqual(["hallucination"]);
  });
});

describe("vet: readings heard in the audio", () => {
  const SHOW = "the show is live";
  const VERB = "ðəʃoʊɪzlɪv";
  const heardAsVerb = (over: Partial<VetDeps>) => scripted([transcriptOf(SHOW)], [VERB], over).d;

  it("(h) a declared reading heard wrong needs an override on a misaki voice", async () => {
    const result = await vet("the show is [live](=adj)", heardAsVerb({}));
    expect(result.status).toBe("needs-override");
    expect(result.status === "needs-override" && result.word).toBe("live");
  });

  it("(h) the same on a text voice needs a rewrite of the span", async () => {
    const result = await vet("the show is [live](=adj)", heardAsVerb({ tts: textVoice() }));
    expect(result.status).toBe("needs-rewrite");
    expect(result.status === "needs-rewrite" && [result.span, result.reason]).toEqual(["live", "reading"]);
  });

  it("an undeclared heteronym the audio contradicts is a warning in the report, not a fault", async () => {
    const result = await vet(SHOW, heardAsVerb({}));
    expect(result.status).toBe("accepted");
    expect(result.report.takes[0]?.warnings.map((r) => [r.word, r.declared, r.heard])).toEqual([["live", "adj", "verb"]]);
  });
});

describe("vet: signal A follows each STT's declared capability", () => {
  const doubtful = transcriptOf(LINE, -1.6);

  it("a doubtful segment from an STT without token log-probs is no fault", async () => {
    const result = await vet(LINE, deps({ stt: scriptedStt([doubtful], { tokenLogprobs: false }) }));
    expect(result.status).toBe("accepted");
    expect(result.report.defectOptions).toEqual({ stt: { confidence: false } });
  });

  it("the same segment from an STT with token log-probs is a low-confidence fault on every take", async () => {
    const result = await vet(LINE, deps({ stt: scriptedStt([doubtful], { tokenLogprobs: true }) }));
    expect(result.status).toBe("retakes-exhausted");
    expect(result.report.takes.map((t) => t.faults.map((f) => f.kind))).toEqual([["low-confidence"], ["low-confidence"]]);
    expect(result.report.stopReason).toBe("futile");
  });

  it("the confirming STT is recorded and judged by its own capability", async () => {
    const d = deps({ stt: scriptedStt([doubtful], { tokenLogprobs: true }), confirmStt: scriptedStt([doubtful], { tokenLogprobs: false }) });
    const result = await vet(LINE, d);
    expect(result.status).toBe("accepted");
    expect(result.report.defectOptions).toEqual({ stt: { confidence: true }, confirmStt: { confidence: false } });
  });
});

describe("vet: agrees with synthesizeVerified when hallucination is the only fault", () => {
  async function both(phones: string[]): Promise<[number | undefined, number]> {
    const policy: VetPolicy = { maxRetakes: 3 };
    const result = await vet(LINE, scripted([HEARD], phones).d, policy);
    const audio = { samples: new Float32Array(0), sampleRate: 16_000 };
    const verified = await synthesizeVerified(LINE, {
      synthesize: (attempt) => Promise.resolve({ value: attempt + 1, audio }),
      recognizer: scriptedRecognizer(phones),
      retries: 3,
      g2p: phoneG2p,
    });
    return [result.report.keptAttempt, verified.value];
  }

  it("(i) both keep the clean fourth take", async () => {
    expect(await both([babbled("ʌbʌbʌbʌbʌb"), babbled("ʌbʌbʌbʌ"), babbled("ʌkʌkʌkʌ"), CLEAN])).toEqual([4, 4]);
  });

  // Mutation: a `<=` comparator picks the later of two tied takes.
  it("(i) with no clean take both keep the earliest of the tied least severe takes", async () => {
    expect(await both([babbled("ʌbʌbʌbʌbʌb"), babbled("ʌbʌbʌbʌ"), babbled("ʌkʌkʌkʌ"), babbled("ʌkʌkʌkʌkʌk")])).toEqual([2, 2]);
  });
});

describe("vet: the report", () => {
  it("is JSON-safe and names the providers, the table and the kept take", async () => {
    const { d } = scripted([HEARD], [babbled("ʌbʌbʌb"), CLEAN]);
    const { report } = await vet(LINE, d);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report).toEqual(expect.objectContaining({ tts: "fake", voice: "fake-a", g2pVersion: "hand-g2p", tableVersion: expect.any(Number) }));
    expect(report.takes.map((t) => t.attempt)).toEqual([1, 2]);
  });
});
