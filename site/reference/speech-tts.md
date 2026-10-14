# speech-tts

**Tier 1 · engines.** No dependencies and no model downloads.

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
`fakeTts` in tests. Speech recognition and alignment belong to the planned `speech-stt`
package, not this one.

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

## What it deliberately does not do

- No engine of its own and no vendor SDK. The in-process Kokoro adapter is the next slice, and
  it plugs in through `registry.register("kokoro", factory)`.
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
  the next one unless the profile sets `tts.fallback: true`.
- `httpTts` refuses redirects and refuses plain http to non-loopback hosts unless
  `allowInsecureHttp` is set. Output past `maxOutputBytes` (64 MB) fails the call.

## Where it came from

New. It is the first slice of the speech packages (TP-2956). It follows the owner's
requirement that the TTS layer be swappable per deployment rather than assume one machine's
setup.
