# speech-vet

**Tier 2.** No titan dependencies yet; its only dependency is `zod`.

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

## When to reach for it

You write or vet narration text and want to catch undeclared or misread heteronyms, apply a
pronunciation lexicon, or spell out initialisms before synthesis. Producing audio belongs to
[`speech-tts`](/reference/speech-tts). The tokens `checkReadings` reads come from a G2P that
this package does not run.

## Example

Verified against the 0.0.0 workspace build.

```ts
import { checkReadings, g2pText, plainText, spellInitialisms } from "@titan-design/speech-vet";

const spoken = "The show is [live](=verb) tonight.";
g2pText(spoken);   // "The show is live tonight.", the text the G2P is given
plainText(spoken); // the same here; it also strips [w](/phonemes/) overrides, for captions

// Tokens are the G2P's output for g2pText(spoken); misaki reads this "live" as the adjective.
const tokens = [{ text: "live", phonemes: "lˈIv", whitespace: " " }];
checkReadings(spoken, tokens);
// [{ word: "live", occurrence: 1, phonemes: "lˈIv", reading: "adj", declared: "verb", status: "fail" }]

spellInitialisms("Send it ASAP."); // "Send it A. S. A. P."
```

## What it deliberately does not do

It runs no G2P, TTS, STT or phoneme recognizer. A product's lexicon data stays in the
product; only the schema lives here. Its initialism list holds general English, and a
product passes its own domain's initialisms through `spelled`.

## Gotchas

- Heteronym patterns are in misaki notation (`I` is `aɪ`, `O` is `oʊ`), matched at the start
  of the stress-stripped phonemes. Tokens from another G2P need a notation map first.
- `checkReadings` takes the markup line, not `g2pText` of it. It needs the declarations, and
  it pairs each with its occurrence by counting that spelling in the plain text.
- `loadLexicon` throws a `ZodError` on a document it cannot read. A respelling with a space
  is refused, because the voice would read it as two words.

## Where it came from

Ported from two Python originals: a narration spike's phoneme dump and heteronym check, and
an audiobook pipeline's pronunciation lexicon and initialism rules. The ported tests keep
their names and assertion counts.
