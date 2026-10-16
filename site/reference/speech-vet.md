# speech-vet

**Tier 2.** Depends on [`speech-stt`](/reference/speech-stt) (for `SequenceMatcher`,
`roundHalfEven`, `Transcript` and `SttCapabilities`), [`speech-tts`](/reference/speech-tts)
(for `vet()`'s provider types) and `zod`.

```sh
npm install @titan-design/speech-vet
```

## The problem it solves

A narration script names how its hard words are said, but a voice cannot be asked whether
it read a heteronym right until the audio exists. Before this package, the checks lived as
Python scripts beside each product, and each product had its own lexicon shape.

This package holds the text-side checks in TypeScript. A line can force phonemes with
`[word](/phonemes/)` or declare a reading with `[word](=reading)`. `checkReadings` compares
each heteronym's G2P phonemes against the declaration. `lexicon.v1` is one schema for
rewrites, respellings and phoneme overrides.

After synthesis, a word the transcriber gets wrong may still be read correctly: Whisper is
biased toward known words. The phone check compares pronunciation directly. Expected phones
come from espeak-ng's G2P; actual phones come from a wav2vec2 phone recognizer. A small
distance blames the transcriber, a large one blames the voice. `espeakCliG2p` runs
`espeak-ng -q --ipa=3` for you through an injectable runner; install espeak-ng (apt or brew),
which is a GPL binary called as a process and not bundled.
`misakiIpaG2p` is the binary-free alternative, built on speech-g2p's misaki G2P.

## When to reach for it

You write or vet narration text and want to catch undeclared or misread heteronyms, apply a
pronunciation lexicon, or spell out initialisms before synthesis. Producing audio belongs to
[`speech-tts`](/reference/speech-tts). The tokens `checkReadings` reads come from a G2P that
this package does not run. Reach for the phone check when you hold narrated audio and must
say whether a flagged word was mispronounced, or find babble and stray tail phones the voice
added. Reach for `detectDefects` when you hold a chunk's source text and its transcript and
want each mangled, dropped or muddy word, with an audio window to listen at and a likely
cause.

## Example

Verified against the 0.0.0 workspace build.

```ts
import {
  checkReadings, DEFAULT_NORMALIZE_STEPS, g2pText, normalize, plainText, RATE_UNITS, rateStep, spellInitialisms,
} from "@titan-design/speech-vet";

const spoken = "The show is [live](=verb) tonight.";
g2pText(spoken);   // "The show is live tonight.", the text the G2P is given
plainText(spoken); // the same here; it also strips [w](/phonemes/) overrides, for captions

// Tokens are the G2P's output for g2pText(spoken); misaki reads this "live" as the adjective.
const tokens = [{ text: "live", phonemes: "lˈIv", whitespace: " " }];
checkReadings(spoken, tokens);
// [{ word: "live", occurrence: 1, phonemes: "lˈIv", reading: "adj", declared: "verb", status: "fail" }]

spellInitialisms("Send it ASAP."); // "Send it A. S. A. P."

normalize("The CEO earned £1.4m, about £9,800/week, by 7 pm on the 3rd.");
// "The C. E. O. earned one point four million pounds, about nine thousand eight hundred
//  pounds per week, by seven P M on the third."

// Steps compose: swap the rates step for one that knows a domain's units.
const steps = DEFAULT_NORMALIZE_STEPS.map((s) => (s.name === "rates" ? rateStep([...RATE_UNITS, "match"]) : s));
normalize("£40/match", steps); // "forty pounds per match"
```

The phone check, with a fixed table standing in for espeak-ng and phones as a recognizer decodes them:

```ts
import { chunkWordVerdicts, detectTailArtifact, type PhoneG2p } from "@titan-design/speech-vet";

const ipa: Record<string, string> = { "the match in Salford ended": "ðə mˈætʃ ɪn sˈælfɚd ˈɛndᵻd\n", Salford: "sˈælfɚd\n" };
const g2p: PhoneG2p = (text) => ipa[text] ?? "";
const text = "the match in Salford ended";

chunkWordVerdicts(text, "ð ə m æ t ʃ ɪ n s ɑ l v ɚ t ɛ n d ᵻ d", { g2p, targets: ["Salford"] });
// [{ word: "Salford", expectedPhones: "sælfɚd", actualPhones: "sɑlvɚt", distance: 0.5, source: "xtts" }]

detectTailArtifact(text, "ð ə m æ t ʃ ɪ n s æ l f ɚ d ɛ n d ᵻ d k u", { g2p });
// { phones: "ku", length: 2, displaced: "", severity: 0.6 }
```

The reading check after synthesis, espeak-free, with misaki tokens and speech-g2p's `misakiToIpa`:

```ts
import { misakiToIpa } from "@titan-design/speech-g2p";
import { checkHeardReadings } from "@titan-design/speech-vet";

const tokens = [["the", "ðə"], ["show", "ʃˈO"], ["is", "ɪz"], ["live", "lˈIv"]].map(([text, phonemes]) => ({ text, phonemes, whitespace: " " }));
checkHeardReadings("The show is [live](=verb)", tokens, "ðəʃoʊɪzlaɪv", { toIpa: misakiToIpa });
// [{ word: "live", occurrence: 1, declared: "verb", heard: "adj", heardPhones: "laɪv", distance: 0, status: "fail" }]
```

The defect check on a transcript, with the options read from the provider that made it:

```ts
import { whisperStt } from "@titan-design/speech-stt";
import { defectOptionsFor, detectDefects } from "@titan-design/speech-vet";

const words = [["chapter", 0], ["fifteen", 0.5], ["begins", 1]] as const;
const transcript = {
  text: "chapter fifteen begins",
  words: words.map(([text, start]) => ({ text, start, end: start + 0.4 })),
  segments: [],
};
detectDefects("chapter 50 begins", transcript, defectOptionsFor(whisperStt()));
// [{ kind: "substitution", expected: "50", heard: "fifteen", severity: 0.23333333333333334,
//    causes: ["number"], audioStart: 0.5, audioEnd: 0.9, context: "chapter 50 begins" }]
```

The whole cycle, over a scripted voice and recognizer (a real run passes `kokoroTts`, `whisperStt` and the rest):

```ts
import { vet } from "@titan-design/speech-vet";

const result = await vet("The show is [live](=verb) tonight.", { tts, voice: "af_heart", stt, g2p });
// { status: "accepted", take: { attempt: 1, ... }, report: { precheck: { status: "verified", ... }, stopReason: "clean", ... } }
// Other statuses: "needs-override" ({ word, evidence }), "needs-rewrite" ({ span }),
// "retakes-exhausted" ({ faults }) and "stopped" ({ findings }, with zero synth calls).
```

A `needs-rewrite` result on a text voice goes to the rewriter. The rule tier is asked first, then
an injected LLM `CandidateSource`; every candidate passes `guardRewrite` before it is vetted:

```ts
import { RewritePins, rewriteLine, symbolRules } from "@titan-design/speech-vet";

const pins = await RewritePins.load("rewrites.json");
const result = await rewriteLine(
  "then Quellan syncs src/flomber_util.ts.",
  { span: "syncs", reason: "reading" },
  { vet: { tts, voice: "af_heart", stt }, pins, sources: [symbolRules(), llmSource] },
);
// { status: "rewritten", line: "then Quellan syncs src slash flomber underscore util dot ts.",
//   source: "rules:symbols", ... }; the next run returns { status: "pinned" } with no source asked.
await pins.save("rewrites.json");
```

## What it deliberately does not do

`vet()` does not normalize: the caller passes normalized text (owner decision D-T11-1, working
default). It has no override search: a persistent word fault returns `needs-override` with
evidence (D-T11-2). `vet()` itself does not rewrite; `rewriteLine` does, and only through
pins (a reviewed rewrite is never rewritten again). The package makes no model call: an LLM
rewriter is an injected `CandidateSource`. `vet()` computes no word timings, so a caller
that wants them calls speech-stt's `alignWords` on the kept take's audio. When the audio
contradicts the G2P reading of an undeclared heteronym it only warns (D-T11-3, behind the
internal constant `ESCALATE_UNDECLARED_HETERONYMS`). When every take keeps a stochastic fault
it returns `retakes-exhausted` with the kept take (D-T11-4). A fault-free take always wins
over a faulty one, whatever the comparator would say.

Take selection is pure too: `synthesizeVerified` re-rolls a babbled take through a `synthesize`
callback you supply, and `keepTake`, `regressions` and `bestTailTake` decide whether a
regenerated take replaces the shipped one (a tie keeps the shipped take; a take that damages a
word never wins).

It loads no model and runs no G2P, TTS, STT or phone recognizer itself: the phone check takes
a `PhoneG2p` and a recognizer from the caller. A product's lexicon data stays in the
product; only the schema lives here. Its initialism list holds general English, and a
product passes its own domain's initialisms through `spelled`. `normalize` holds only
general expansions; house style (dashes, ellipses, markdown, slashes read as spaces) and a
source's preambles or boilerplate are steps the product writes.

## Gotchas

- Heteronym patterns are in misaki notation (`I` is `aɪ`, `O` is `oʊ`), matched at the start
  of the stress-stripped phonemes. Tokens from another G2P need a notation map first.
- `checkReadings` takes the markup line, not `g2pText` of it. It needs the declarations, and
  it pairs each with its occurrence by counting that spelling in the plain text.
- `loadLexicon` throws a `ZodError` on a document it cannot read. A respelling with a space
  is refused, because the voice would read it as two words.
- `NUMBER_STEPS` are order-dependent: currency before decimals, decimals before cardinals.
  Plain numbers under 100 stay digits, and `%` is left for the voice.
- `conformance/normalize.json` ships in the package so a Python port can check itself
  against the same cases; a case that changes there is a behaviour change for that port.
- The phone thresholds were tuned on espeak-ng 1.52.0 with voice `en-us` and the fp32
  recognizer. Another G2P, accent or a `q8` recognizer moves verdicts. Predicting against a
  non-rhotic accent such as `en-gb` turns r-coloured words into false `xtts` faults.
- The phone functions index by code point and round half to even, as the Python original
  does, so their output deep-equals the original's on the same phones.
- `detectDefects` ignores word probabilities and segment confidence unless
  `options.confidence` is true, and it defaults to false. Pass `defectOptionsFor(stt)`
  rather than leaving the options out, or transcripts that carry token log-probs silently
  lose that signal. `whisperStt` fills both unless built with `tokenLogprobs: false`, which
  turns its flag off.
- `detectDefects` keeps the original's number grammar, which stops at "and": "five hundred
  and twenty" reads as 500 then 20.
- `vet()` takes a `recognizer` only with a `phoneG2p`, which has no default: whether misaki
  may drive phone verdicts is the caller's call. A voice that takes misaki phonemes also needs
  a `g2p`; both cases throw a `TypeError` before any synth call.
- A deterministic voice such as Kokoro returns the same audio on a retake, so `vet()` stops
  as `futile` after the second identical take instead of spending the budget.
- Words with an override or a lexicon phoneme entry are judged at the looser "unusual word"
  threshold, because the expected phones come from the dictionary reading, which knows
  nothing of the override. An override's phones are not checked exactly.
- A text voice (no misaki input) reports the precheck `unverifiable`, since the reading
  checked is not the one it speaks, and gets respellings from the lexicon instead of phonemes.
- `inconclusive` means the aligned span is under half the word's expected phones. The
  alignment collapsed, often after a near-duplicate word; neither verdict is safe.

## Where it came from

Ported from two Python originals: a narration spike's phoneme dump and heteronym check, and
an audiobook pipeline's pronunciation lexicon, initialism rules and text normalizer. The ported tests keep
their names and assertion counts. The phone check is a port of the same pipeline's phoneme
validation. Its 34 test cases run on recorded espeak-ng output, and a replay of 30
owner-authored beats plus 10 perturbed or constructed cases checks every output against the
original's. The defect check is a port of that pipeline's defect detector; its tests keep
the original's names, and 60 constructed cases replay the original's output with the flag on
and off. `metaphone` matches jellyfish 1.2.1 (MIT).
