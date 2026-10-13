# explainer

**Product.** Private, never published. No titan dependencies yet; it depends on `zod`.

```sh
pnpm build
```

## The problem it solves

An explainer video is built in steps: gather what happened, plan a storyboard of beats,
build each beat with a model, check the render, repair the failing beats. Each step hands
the next a file, and each repair has to reach the worker that built the failing beat.

This first slice adds the file contracts and the two pure helpers every later step shares:

- `StoryboardSchema` for `beats.json`, `DigestSchema` for `digest.json` and `LexiconSchema`
  for `lexicon.json`.
- `buildPacket`, which builds one beat builder's packet: the beat, its component API, its
  resolved sources and the lexicon entries its text mentions.
- `attributeFindings`, which maps gate findings to the beat each one names.

## When to reach for it

Use it inside the explainer pipeline. Reach for `@titan-design/react-ui` for motion
primitives and beat components, and for [`evidence`](/reference/evidence) to verify a code
citation before its excerpt reaches a packet.

## Example

```ts
import { StoryboardSchema, attributeFindings, buildPacket } from "@titan-design/explainer";

const board = StoryboardSchema.parse(JSON.parse(beatsJson));
const packets = board.beats.map((beat) =>
  buildPacket({
    beat,
    videoType: board.video_type,
    catalog: new Map([["stat", "Stat({ value, label })"]]),
    sources: new Map([["src-1", { id: "src-1", kind: "text", text: "Twelve PRs merged." }]]),
  }),
);

const { byBeat, unattributed } = attributeFindings(findings, board.beats.map((b) => b.id));
```

Verified against 0.0.0.

## What it deliberately does not do

- It does not know which video types or beat types exist. `video_type` and a beat's `type`
  are open kebab-case strings; a doctrine registry (type profiles such as `repo-tour` and
  `repo-argument`, beat specs) will validate them in a later slice.
- It reads and writes no files and makes no model or network calls.
- It does not verify citations. The route step does that before it resolves a source.

## Gotchas

- `buildPacket` throws rather than returning an error: on a code beat (type `code` or
  `code-*`) with no non-blank code excerpt, on a source id it was not given, on a beat type
  missing from the catalog, and on a packet over `maxBytes` (default 48,000).
- `attributeFindings` matches whole ids by number: `beat-03` and `beat-3` name the same beat,
  and `beat-3` never matches `beat-30`. Only `error` findings are attributed; ones naming no
  known beat come back in `unattributed`.
- `beats.json` has no version field. A format change adds an optional field or a migration.
- A beat's `stops` are seconds from the beat start, ascending, and no later than its
  `duration_s`.

## Where it came from

New. The packet byte cap and the code-excerpt rule follow a HyperFrames skill's packet
builder; `attributeFindings` ports a demo-video script's helper of the same name, minus its
substring match, which sent `beat-3` findings to `beat-30`. Tracked by TP-2611.
