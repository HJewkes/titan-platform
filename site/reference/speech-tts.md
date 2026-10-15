# speech-tts

**Tier 1 · engines.** No dependencies. The Kokoro provider needs two optional peers and a
model download, and only when you use it.

```sh
npm install @titan-design/speech-tts
```

## The problem it solves

Speech code tends to assume the machine it was written on: a GPU, a Python venv, a vendor
key. When it moves to a laptop, a GPU server or a hosted-only deployment, the call sites
must change.

This package puts every engine behind one `TtsProvider` contract. Each provider declares its
capabilities, and a registry chooses one from the deployment's profile file and environment.
The calling code does not change between deployments.

## When to reach for it

You synthesize speech, and you cannot know in advance which engine a deployment has. Use
`commandTts` for any local or ssh-reached program, `httpTts` for any HTTP endpoint, and
`fakeTts` in tests. Use `kokoroProvider` for local, in-process speech with word timings.
Speech recognition and alignment belong to `speech-stt`, not this one.

## Example

Verified against the 0.0.0 workspace build.

```ts
import { selectTts } from "@titan-design/speech-tts";

// profile.json declares the providers; TITAN_SPEECH_TTS=gpu would force one.
const { provider, skipped } = await selectTts({
  profilePath: "./profile.json",
  requirements: { wordTimestamps: true, voice: "narrator" },
});

const { audio, durationS, words } = await provider.synthesize({ text: "Hello there." }, "narrator", { speed: 1.1 });
audio.sampleRate;   // from the engine's WAV header
skipped;            // [{ id: "laptop", reason: "lacks word timestamps", missing: ["word timestamps"] }]
```

The package README has three example profiles (laptop CPU, GPU server, hosted only), the
stdio contract for commands, and the HTTP mapping.

## Kokoro, in process

`kokoroProvider` runs Kokoro-82M in your process. It returns word timings taken from the
model's own durations, matching Python's `KPipeline.join_timestamps`.

```sh
npm install @huggingface/transformers kokoro-js
```

```ts
import { defaultTtsRegistry, kokoroFactory, selectTts } from "@titan-design/speech-tts";

// g2p is any { tokens(text) } that returns { text, phonemes, whitespace } items.
const registry = defaultTtsRegistry().register("kokoro", kokoroFactory({ g2p }));
const { provider } = await selectTts({ registry, profilePath, requirements: { wordTimestamps: true } });
```

- **fp32 only.** Other precisions shift the durations, so a profile `dtype` other than
  `fp32` is refused.
- **Cache.** Give the profile entry a `cacheDir`. The model is about 325 MB and downloads on
  the first call, so warm the provider at startup. The default `timeoutMs` is 300000.
- **Offline.** With `TITAN_SPEECH_OFFLINE` set, a model missing from `cacheDir` is refused
  with `TtsUnavailableError` before any network call.
- **Unknown words.** A word Kokoro cannot phonemize is not spoken. It gets a zero-width
  timing and a warning.
- **Timings.** They follow Python's heuristic, which offsets the start by a fixed guess.
  Parity with Python is the bar, not acoustic truth.
- **Licence.** The weights are Apache-2.0, and so are `kokoro-js` and transformers.js.
- **Voices.** The US `af_*` and `am_*` voices, from the `kokoro-js` peer.
- **Smoke test.** An opt-in test runs the real model. See the package README.

## What it deliberately does not do

- No vendor SDK. The in-process Kokoro adapter is the only engine it ships, and it plugs in
  through `registry.register("kokoro", kokoroFactory({ g2p }))`.
- It does not decide where the profile lives. The caller passes a path, or sets
  `TITAN_SPEECH_PROFILE`.
- It does not resample. `audio.sampleRate` is whatever the engine produced.

## Gotchas

- `TITAN_SPEECH_TTS` restricts selection to the providers it names. The profile's `prefer`
  only reorders them.
- Word timings an engine returns are dropped unless the provider declares `wordTimestamps`.
  Selection is what promises timings to the caller.
- A speed of exactly 1 needs no `speedControl`. Any other speed does.
- A command times out by killing its whole process group, so wrap engines in a program that
  exits when killed, not a daemon that detaches.
- A command sees only `PATH`, `HOME`, `LANG`, `TMPDIR` and its configured `env`. An ssh argv
  that needs an agent must list `SSH_AUTH_SOCK` there.
- A misconfigured provider stops selection with `TtsConfigError`; it does not fall through to
  the next one unless the profile sets `tts.fallback: true`. An unregistered `kind` stops it
  even then (`unknown-kind`), so a typo never hands the text to the next engine.
- `httpTts` refuses redirects and refuses plain http to non-loopback hosts unless
  `allowInsecureHttp` is set. Output past `maxOutputBytes` (64 MB) fails the call.

## Where it came from

New. It is the first slice of the speech packages (TP-2956). It follows the owner's
requirement that the TTS layer be swappable per deployment rather than assume one machine's
setup.
