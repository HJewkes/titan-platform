import type { SttProvider } from "@titan-design/speech-stt";
import { fakeTts, type FakeTtsProvider } from "@titan-design/speech-tts";
import { describe, expect, it } from "vitest";
import * as speechVet from "./index.js";
import { guardRewrite } from "./rewrite-guard.js";
import { RewritePins } from "./rewrite-pins.js";
import {
  SYMBOL_WORDS,
  rewriteLine,
  symbolRules,
  type CandidateSource,
  type RewriteDeps,
  type RewritePolicy,
  type RewriteResult,
} from "./rewrite.js";
import { transcriptOf } from "./vet.test-helpers.js";

// Constructed sentences, invented words, a fake text voice, and an STT that hears what the voice was given.
const READING = "reading";
const ONE_TAKE: RewritePolicy = { vet: { maxRetakes: 0 } };

/** Hears the text the voice was last given, through `mishear`, so a test decides which candidates vet clean. */
function hearsVoice(tts: FakeTtsProvider, mishear: (text: string) => string = (text) => text): SttProvider {
  return {
    capabilities: { tokenLogprobs: false },
    transcribe: () => {
      const input = tts.calls.at(-1)?.input;
      const said = input && "text" in input ? input.text : "";
      return Promise.resolve(transcriptOf(mishear(said)));
    },
  };
}

function offers(id: string, candidates: readonly string[]): CandidateSource & { calls: number } {
  const source = {
    id,
    calls: 0,
    candidates: (): Promise<string[]> => {
      source.calls += 1;
      return Promise.resolve([...candidates]);
    },
  };
  return source;
}

function setup(sources: readonly CandidateSource[], mishear?: (text: string) => string) {
  const tts = fakeTts({ capabilities: { phonemeInput: [] } });
  const pins = new RewritePins(undefined, { now: () => new Date("2026-01-02T03:04:05.000Z") });
  const deps: RewriteDeps = { vet: { tts, voice: "fake-a", stt: hearsVoice(tts, mishear) }, pins, sources };
  return { tts, pins, deps };
}

const statusOf = (result: RewriteResult) => result.status;

describe("rewriteLine and pins", () => {
  // Catches: rewriteLine ignoring the pin, so the source is called and its different text replaces the pinned span.
  it("resolves a pinned sentence from its pin without asking any source or the voice", async () => {
    const llm = offers("llm:fake", ["the show is streaming tonight."]);
    const { tts, pins, deps } = setup([llm]);
    pins.put("the show is [live](=adj) tonight.", "the show is on air tonight.", "llm:earlier");

    const result = await rewriteLine("the show is [live](=adj) tonight.", { span: "live", reason: READING }, deps, ONE_TAKE);

    expect(result).toEqual({ status: "pinned", line: "the show is on air tonight." });
    expect(llm.calls).toBe(0);
    expect(tts.calls).toHaveLength(0);
  });

  // Catches: skipping isPinnedRewrite, so a reviewed rewrite is sent to a rewriter again.
  it("refuses to rewrite a sentence that is itself a pinned rewrite", async () => {
    const llm = offers("llm:fake", ["the show is broadcasting tonight."]);
    const { tts, pins, deps } = setup([llm]);
    pins.put("the show is [live](=adj) tonight.", "the show is on air tonight.", "llm:earlier");
    const line = "the show is on air tonight. it runs late.";

    const result = await rewriteLine(line, { span: "air", reason: READING }, deps, ONE_TAKE);

    expect(result).toEqual({ status: "refused", reason: "pinned-span", line });
    expect(llm.calls).toBe(0);
    expect(tts.calls).toHaveLength(0);
  });
});

describe("rewriteLine candidates", () => {
  // Catches: pinning before, or regardless of, the vet result (S8 (b)).
  it("pins only a candidate whose vet is accepted, skipping one the voice gets wrong", async () => {
    const misheard = "the flomber sync is on air.";
    const clean = "the flomber sync is airing.";
    const llm = offers("llm:fake", [misheard, clean]);
    const { pins, deps } = setup([llm], (text) => text.replace(" air.", "."));
    const sentence = "the flomber sync is [live](=adj).";

    const result = await rewriteLine(sentence, { span: "live", reason: READING }, deps, ONE_TAKE);

    expect(result).toMatchObject({ status: "rewritten", line: clean, sentence, rewrite: clean, source: "llm:fake" });
    expect(result.status === "rewritten" && result.result.status).toBe("accepted");
    expect(pins.get(sentence)).toBe(clean);
    expect(pins.isPinnedRewrite(misheard)).toBe(false);
  });

  // Catches: vetting before guarding, which spends a take on a candidate that dropped a number.
  it("never vets a candidate the guard rejects", async () => {
    const llm = offers("llm:fake", ["the flomber sync is on air.", "the flomber sync is on air at 13."]);
    const { tts, deps } = setup([llm]);

    const result = await rewriteLine("the flomber sync is [live](=adj) at 13.", { span: "live", reason: READING }, deps, ONE_TAKE);

    expect(result).toMatchObject({ status: "rewritten", rewrite: "the flomber sync is on air at 13." });
    expect(tts.calls).toHaveLength(1);
  });

  // Catches: dropping the guard's reasons, so a reviewer cannot see why nothing was pinned.
  it("lists every guard rejection when no candidate survives", async () => {
    const llm = offers("llm:fake", ["the flomber sync is on air.", ""]);
    const { tts, pins, deps } = setup([llm]);
    const sentence = "the flomber sync is [live](=adj) at 13.";

    const result = await rewriteLine(sentence, { span: "live", reason: READING }, deps, ONE_TAKE);

    expect(result.status === "no-candidate" && result.tried.map((t) => [t.candidate, t.rejections.map((r) => r.rule)])).toEqual([
      ["the flomber sync is on air.", ["number"]],
      ["", ["empty"]],
    ]);
    expect(tts.calls).toHaveLength(0);
    expect(pins.get(sentence)).toBeUndefined();
  });

  // Catches: a vet failure recorded without its status, or a failed candidate pinned anyway.
  it("records the vet status of a guarded candidate that does not vet clean", async () => {
    const llm = offers("llm:fake", ["the flomber sync is on air."]);
    const { deps } = setup([llm], (text) => text.replace(" air.", "."));

    const result = await rewriteLine("the flomber sync is [live](=adj).", { span: "live", reason: READING }, deps, ONE_TAKE);

    expect(statusOf(result)).toBe("no-candidate");
    expect(result.status === "no-candidate" && result.tried[0]?.vetStatus).not.toBe("accepted");
    expect(result.status === "no-candidate" && result.tried[0]?.vetStatus).toBeTypeOf("string");
  });

  // Catches: splicing the candidate over the whole line, so the other sentences change.
  it("changes only the flagged sentence of a longer line", async () => {
    const llm = offers("llm:fake", ["the flomber sync is on air."]);
    const { deps } = setup([llm]);
    const rest = "it runs 13 hops.  then it [rests](/ɹˈɛsts/).";

    const result = await rewriteLine(`the flomber sync is [live](=adj). ${rest}`, { span: "live", reason: READING }, deps, ONE_TAKE);

    expect(result).toMatchObject({ status: "rewritten", line: `the flomber sync is on air. ${rest}` });
  });

  // Catches: a span that is not in the line being rewritten somewhere arbitrary.
  it("throws when the span is not in the line", async () => {
    const { deps } = setup([offers("llm:fake", ["anything at all."])]);

    await expect(rewriteLine("the flomber sync is live.", { span: "zorptrix", reason: READING }, deps)).rejects.toThrow(/zorptrix/);
  });
});

describe("symbolRules", () => {
  const path = "then Quellan syncs src/flomber_util.ts.";

  // Catches: the rule tier bypassing the guard (S8 (e)).
  it("is guarded like any source: a rule that drops a name yields no candidate", async () => {
    const { tts, pins, deps } = setup([symbolRules([["Quellan", "it"]])]);

    const result = await rewriteLine(path, { span: "syncs", reason: READING }, deps, ONE_TAKE);

    expect(result.status === "no-candidate" && result.tried.map((t) => t.rejections.map((r) => r.rule))).toEqual([["entity"]]);
    expect(tts.calls).toHaveLength(0);
    expect(pins.get(path)).toBeUndefined();
  });

  // Catches: "." replaced at the sentence end too, which glues the next sentence on.
  it("spells a path's symbols and leaves the sentence-final period", async () => {
    const [candidate] = await symbolRules().candidates(path, READING, 3);

    expect(candidate).toBe("then Quellan syncs src slash flomber underscore util dot ts.");
    expect(guardRewrite(path, candidate ?? "", "syncs")).toEqual([]);
  });

  // Catches: a rule tier that offers an unchanged sentence as a candidate.
  it("offers nothing for a sentence with no symbols, and leaves markup alone", async () => {
    const rules = symbolRules();

    expect(await rules.candidates("the show is live 3.5 times.", READING, 3)).toEqual([]);
    expect(await rules.candidates("the [show](/ʃˈO/) is [live](=adj).", READING, 3)).toEqual([]);
  });

  // Catches: asking every source before choosing, so the LLM is billed when a rule already fixed the line.
  it("is asked first, and a rule that vets clean leaves the LLM source unasked", async () => {
    const llm = offers("llm:fake", ["then Quellan syncs the flomber file."]);
    const { deps } = setup([symbolRules(SYMBOL_WORDS), llm]);

    const result = await rewriteLine(path, { span: "syncs", reason: READING }, deps, ONE_TAKE);

    expect(result).toMatchObject({ status: "rewritten", source: "rules:symbols" });
    expect(llm.calls).toBe(0);
  });
});

describe("speech-vet index", () => {
  // Catches: an export dropped from the rewriter block.
  it("exports the rewriter, guard and pin API", () => {
    const names = ["rewriteLine", "symbolRules", "SYMBOL_WORDS", "RewritePins", "RewritePinsSchema", "pinKey", "applyPins", "UnpinnedRewriteError", "guardRewrite", "contentTerms"];

    expect(names.filter((name) => !(name in speechVet))).toEqual([]);
  });
});
