# @titan-design/speech-tts

A swappable text-to-speech layer: one `TtsProvider` contract, a registry that picks a provider
from a deployment's profile and environment, and adapters for any external engine. Nothing
about the host is assumed. A deployment says which engines it has; callers say which
capabilities they need.

Tier 1 of the titan-platform DAG. One runtime dependency, `@titan-design/app-paths`, for the
default model cache. The Kokoro adapter needs two optional peers and a model download, and
only when you use it.

```sh
npm install @titan-design/speech-tts
```

## The contract

```ts
interface TtsProvider {
  id: string;
  capabilities: TtsCapabilities;
  synthesize(input: TtsInput, voice: string, options?: SynthesizeOptions): Promise<Synthesis>;
}

type TtsInput = { text: string } | { tokens: TtsToken[]; alphabet: "ipa" | "misaki" };

interface TtsCapabilities {
  phonemeInput: ("ipa" | "misaki")[]; // empty: text input only
  wordTimestamps: boolean;
  speedControl: boolean;
  voices: { id: string; languages: string[] }[];
  languages: string[];               // BCP 47
  sampleRate: number;
}

interface Synthesis {
  audio: { samples: Float32Array; sampleRate: number }; // mono, [-1, 1]
  durationS: number;
  words?: { word: string; start: number; end: number }[]; // only if wordTimestamps
  phonemes?: string[];
}
```

Every provider checks a call against its capabilities before any engine work. A call that
needs something undeclared, such as an unlisted voice, token input in an undeclared alphabet,
or a speed other than 1 without `speedControl`, rejects with `TtsUnsupportedError`.

Errors are typed, and `code` is the field to branch on:

| Class | `code` | Means |
|---|---|---|
| `TtsUnavailableError` | `unavailable` | The engine cannot be reached: missing binary, refused connection, HTTP 502-504, exit 69. |
| `TtsUnsupportedError` | `unsupported` | The call or the selection needs a capability that is not declared. `missing` lists each gap. |
| `TtsTimeoutError` | `timeout` | No audio before the deadline. A command's process group is killed. |
| `TtsFailedError` | `failed` | The engine answered with an error or with output that breaks the contract, including a refused redirect or output past `maxOutputBytes`. |
| `TtsUnknownWordsError` | `unknown-words` | A Kokoro provider with `unknownWords: "fail"` was given words with no phonemes. `words` lists each one with its token `index`. The engine never ran. |
| `TtsConfigError` | `misconfigured` | Selection reached a provider whose config is wrong, and the profile does not set `tts.fallback`. `skipped` lists every provider passed over. |
| `TtsConfigError` | `unknown-kind` | Selection reached a provider whose `kind` has no registered factory. The message names the kind and the registered kinds. `tts.fallback` does not apply. |

## Selecting a provider

```ts
import { selectTts } from "@titan-design/speech-tts";

const { provider, skipped } = await selectTts({
  profilePath, // or TITAN_SPEECH_PROFILE
  requirements: { wordTimestamps: true, voice: "narrator" },
});
const { audio, words } = await provider.synthesize({ text: "Hello there." }, "narrator");
```

Selection walks the providers in order and returns the first that meets every requirement.
`skipped` says why each earlier one was passed over. A provider that lacks a capability is
passed over. A provider whose *config* is wrong is not: selection stops with
`TtsConfigError`, so a broken preferred engine is never silently replaced by a weaker one.
Set `"tts": { "fallback": true }` to move past it instead; the reason stays in `skipped`.
"Config is wrong" covers a factory validation error, a secret that resolves to nothing, and a
`TITAN_SPEECH_TTS` id the profile does not define.

A `kind` with no registered factory always stops selection, with code `unknown-kind`, even
with `fallback` set. A typo such as `"comand"` must not hand the text to the next provider,
which may be a remote one.

When no provider qualifies, the error names each provider and what it lacks:

```
tts: no provider meets the requirements: laptop lacks word timestamps; hosted lacks voice "narrator"
```

**Precedence: environment over profile over nothing.** With neither, there are no
providers, and selection says how to add one.

| Source | Effect |
|---|---|
| `profile.json`, `tts.providers` | Declares each provider: its `kind`, its settings and its capabilities. |
| `profile.json`, `tts.prefer` | Moves the named providers to the front; the rest follow in declaration order. |
| `TITAN_SPEECH_PROFILE` | Path to the profile when the caller passes none. A missing file is no profile, not an error. |
| `TITAN_SPEECH_TTS=a,b` | An explicit choice: only these providers are tried, in this order. |
| `TITAN_SPEECH_TTS_<ID>_URL` | Overrides an `http` provider's `url`. |
| `TITAN_SPEECH_TTS_<ID>_ARGV` | Overrides a `command` provider's `argv`, as a JSON array. |
| `TITAN_SPEECH_TTS_<ID>_TIMEOUT_MS` | Overrides a provider's `timeoutMs`. |
| `profile.json`, `tts.fallback` | `true` lets selection move past a misconfigured provider. Default `false`. |
| `TITAN_SPEECH_DEVICE_<TTS\|STT\|PHONES>` | One model's device (`TITAN_SPEECH_DEVICE_STT=cpu`). Beats `TITAN_SPEECH_DEVICE`. See "Choosing a device and cache". |
| `TITAN_SPEECH_DEVICE` | The device for every model that has no `TITAN_SPEECH_DEVICE_<C>`. |
| `TITAN_SPEECH_CACHE` | Absolute path of the model cache. Beats `profile.json` `runtime.cacheDir`. |
| `profile.json`, `runtime` | `{ "device": { "tts"?, "stt"?, "phones"? }, "cacheDir"? }`: the device and cache when no variable sets them. |
| `${env:NAME}` in a `headers` or command `env` value | Expanded from the environment, so a profile can be shared without its secrets. An unset or empty `NAME` makes the provider misconfigured, naming `NAME`; an empty header is never sent. Expanded values are redacted from error text. |

`<ID>` is the provider id upper-cased, with every other character as `_`.

The package never chooses the profile's path. A product that wants a default location can
pass `appDirs("titan-speech").config` from `@titan-design/app-paths`, joined with
`profile.json`. It does choose a default model cache and device (next section).

## Choosing a device and cache

Speech models run on a device and keep their weights in a cache directory.
`resolveSpeechRuntime()` picks both for the three in-process models, and the result feeds
Kokoro (here), Whisper and wav2vec2 (`@titan-design/speech-stt`) alike:

```ts
import { resolveSpeechRuntime, runtimeOptions } from "@titan-design/speech-tts";

const runtime = await resolveSpeechRuntime();
runtime.available;                           // ["cpu"], or ["cpu", "cuda"]
const tts = kokoroProvider({ g2p, ...runtimeOptions(runtime, "tts") });
const stt = whisperStt({ ...runtimeOptions(runtime, "stt") });
const phones = wav2vec2Recognizer({ ...runtimeOptions(runtime, "phones") });
```

`detectSpeechRuntime({ platform, arch, env, home, exists, ortDir?, profile?, allowUnverifiedCuda? })`
is the same decision as a pure function. `resolveSpeechRuntime` supplies the real host and
loads the profile through `TITAN_SPEECH_PROFILE`, like `selectTts`.

**Device.** Each model takes the first of `TITAN_SPEECH_DEVICE_<TTS|STT|PHONES>`,
`TITAN_SPEECH_DEVICE`, the profile's `runtime.device.<tts|stt|phones>`, then `cpu`. An empty
variable counts as unset. `runtime.source` says which one won.

**Cache.** `TITAN_SPEECH_CACHE`, then the profile's `runtime.cacheDir`, then
`appDirs("titan-speech").cache` (`~/Library/Caches/titan-speech` on macOS, `$XDG_CACHE_HOME`
or `~/.cache` on Linux). The path must be absolute; a `~` the shell did not expand is refused
with `bad-cache-dir`. It reaches the providers byte for byte, so a path with a space, such as
one under `Application Support`, works.

**Kokoro profile entries.** When you give `kokoroFactory` the `runtime`
(`kokoroFactory({ g2p, runtime })`), an entry's own `device` or `cacheDir` loses to a value
set by a `TITAN_SPEECH_*` variable, and beats the profile's `runtime` section and the
defaults.

**What is refused**, each as a `SpeechRuntimeError` with a `code`:

| `code` | When |
|---|---|
| `unknown-device` | The name is not `cpu`, `cuda`, `coreml` or `webgpu`. |
| `unsupported-device` | `coreml` or `webgpu` (they need `@huggingface/transformers` 4.x; the speech packages support 3.x), or `cuda` off linux-x64. |
| `unavailable-device` | `cuda` on linux-x64 without the ONNX Runtime CUDA library or the NVIDIA driver. The message names the missing path. |
| `unverified-device` | `cuda` is available but not yet verified. See below. |
| `unsupported-platform` | macOS with an x64 Node (Rosetta or an Intel Mac). Run an arm64 Node. This is checked before any override. |
| `bad-cache-dir` | The cache path is not absolute. |

**CUDA is listed, not used.** On linux-x64, `runtime.available` includes `cuda` when
`onnxruntime-node` has its CUDA provider library and `/proc/driver/nvidia/version` exists.
That does not prove a CUDA session works, so an explicit `cuda` choice throws
`unverified-device` until spike E9 has run one. A caller running E9 itself passes
`allowUnverifiedCuda: true`. Without a choice, every model stays on `cpu`.

Install the peers (`@huggingface/transformers`, which brings `onnxruntime-node`) for `cuda`
to be detected; without them `available` is `["cpu"]`, and nothing throws.

## Swapping providers for your deployment

Each machine gets its own profile. Code that calls `selectTts` stays the same everywhere.

**A laptop, CPU only.** The in-process Kokoro adapter is the first choice (see "Kokoro, in
process"). The fallback is a local CPU engine wrapped in the command contract.
Until the host registers the `kokoro` kind, selection stops at that entry with
`unknown-kind`. Set `TITAN_SPEECH_TTS=local-cli` on such a host so the entry is never tried.

```json
{
  "version": 1,
  "tts": {
    "prefer": ["kokoro"],
    "providers": {
      "kokoro": { "kind": "kokoro", "dtype": "fp32" },
      "local-cli": {
        "kind": "command",
        "argv": ["tts-cli", "--device", "cpu"],
        "output": "stdout-wav",
        "timeoutMs": 60000,
        "capabilities": { "voices": ["narrator"], "languages": ["en-US"], "sampleRate": 22050, "speedControl": true }
      }
    }
  }
}
```

**A GPU server.** Large models such as XTTS or Qwen3-TTS run out of process. The same entry
serves a laptop that reaches the server over ssh: it sets
`TITAN_SPEECH_TTS_GPU_ARGV='["ssh","gpu-box","tts-cli","--device","cuda"]'`, and
`stdout-wav` carries the audio back with no shared paths. ssh with an agent needs
`"env": { "SSH_AUTH_SOCK": "${env:SSH_AUTH_SOCK}" }` on the entry, because a command sees only
a minimal environment (see the command contract).

```json
{
  "version": 1,
  "tts": {
    "providers": {
      "gpu": {
        "kind": "command",
        "argv": ["tts-cli", "--device", "cuda"],
        "output": "stdout-wav",
        "timeoutMs": 300000,
        "capabilities": { "voices": ["narrator", "cloned"], "languages": ["en"], "sampleRate": 24000, "speedControl": true }
      },
      "self-hosted": {
        "kind": "http",
        "url": "http://127.0.0.1:8020/synthesize",
        "request": { "body": { "text": "{{text}}", "speaker": "{{voice}}", "speed": "{{speed}}" } },
        "response": { "type": "json", "audioBase64": "audio", "words": "alignment.words" },
        "capabilities": { "voices": ["narrator"], "sampleRate": 24000, "wordTimestamps": true, "speedControl": true }
      }
    }
  }
}
```

**Hosted only.** No local engine. This maps an OpenAI-compatible `/audio/speech` endpoint.
The same mapping is a test fixture in `src/fixtures/openai-compatible.profile.json`.

```json
{
  "version": 1,
  "tts": {
    "providers": {
      "hosted": {
        "kind": "http",
        "url": "https://tts.example.com/v1/audio/speech",
        "headers": { "authorization": "Bearer ${env:EXAMPLE_TTS_API_KEY}" },
        "request": { "body": { "model": "tts-1", "input": "{{text}}", "voice": "{{voice}}", "speed": "{{speed}}", "response_format": "wav" } },
        "response": { "type": "wav" },
        "capabilities": { "voices": ["alloy", "nova"], "languages": ["en"], "sampleRate": 24000, "speedControl": true }
      }
    }
  }
}
```

In `capabilities`, only `voices` and `sampleRate` are required. A voice is a string id or
`{ "id", "languages" }`. Everything else defaults to absent. Declare only what the engine
really does: selection trusts the declaration.

## The `command` contract (stdio)

`commandTts` runs `argv` without a shell, writes one JSON request to stdin, and closes stdin.

```json
{ "version": 1, "voice": "narrator", "text": "Hello there.", "speed": 1.1, "language": "en-US",
  "outDir": "/tmp/speech-tts-x", "out": "/tmp/speech-tts-x/out.wav" }
```

Token input sends `"tokens": [{ "text", "phonemes", "whitespace" }]` and `"alphabet"` in place
of `"text"`. `speed` and `language` are present only when the caller set them. `outDir`, a
fresh directory for this call, and `out`, a suggested file in it, are present only in `json`
mode.

The answer depends on `output`:

- **`stdout-wav`**: stdout is RIFF/WAVE bytes, PCM16 or float32, at any sample rate (the
  header is read). A streamed WAV with unpatched sizes is accepted.
- **`json`** (the default): stdout is one JSON object with the audio as `"wav": "<path>"` or
  as `"audioBase64"`. A `wav` must be a **bare filename in `outDir`**, such as `"out.wav"`. A
  path with a separator is refused, so is an absolute path, and so is a symlink that resolves
  outside `outDir`. The answer may add
  `"durationS"`, `"words": [{ "word", "start", "end" }]` in seconds, and `"phonemes": ["..."]`.

Exit 0 means success. Exit 69 (EX_UNAVAILABLE), 127 or 255 (ssh could not connect) means
unavailable; `unavailableExitCodes` changes that list. Any other exit fails, with about the
last 2 KB of stderr in the message, after secrets are redacted. At the deadline, the whole
process group is sent SIGKILL. The per-call scratch directory is removed afterwards.

The child's environment is `PATH`, `HOME`, `LANG` and `TMPDIR` from the parent (`INHERITED_ENV`),
plus the entry's `env` map. Nothing else is passed, so an API key in the parent's environment
never reaches an engine unless the profile names it.

## The `http` mapping

`httpTts` sends one JSON request built from `request.body`, a template:

- A string that is exactly `"{{name}}"` becomes the value with its type, so `speed` stays a
  number. If the value is unset, the key is dropped.
- Inside a longer string, `{{name}}` is interpolated.
- Names: `text`, `voice`, `speed`, `language`, `alphabet`, `tokens`, and `phonemes`. `phonemes`
  is each token's phonemes, or its text when it has none, joined by its whitespace.

`response` is `{ "type": "wav" }` when the body is a WAV file, or
`{ "type": "json", "audioBase64": "<path>", "words"?, "durationS"?, "phonemes"? }`, with dot
paths such as `result.audio`. Statuses 502, 503 and 504 are unavailable; a 3xx is refused;
any other non-2xx fails with about the first 2 KB of the body, with header values and
secrets redacted. No vendor SDK is involved.

`url` must be `https:`, or `http:` to a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`).
Plain http to any other host is refused when the provider is built, unless the entry sets
`"allowInsecureHttp": true`.

## Security notes

These defaults assume the profile is trusted, but the engine and the network are not.

- **Redirects are refused.** `httpTts` never follows a 3xx, so headers and text go only to
  the configured origin. Point `url` at the final endpoint.
- **No plain http off the machine.** Headers, keys and the text itself go in the clear over
  http, so it is allowed only to loopback hosts unless `allowInsecureHttp` is set.
- **Output is capped.** `maxOutputBytes` (default 64 MB, `DEFAULT_MAX_OUTPUT_BYTES`) bounds a
  command's stdout, a named WAV file and an HTTP body. It is counted while streaming, so an
  endless stream is cut off, the command is killed, and the call fails with `TtsFailedError`.
- **Commands get a minimal environment.** Only `INHERITED_ENV` and the entry's `env` reach
  the child.
- **Files stay in the call's directory.** A `wav` named by a command is read only from inside
  its `outDir`, after symlinks are resolved. The read uses one descriptor: it is opened without
  following a final symlink, its type and size come from fstat on that descriptor, and the
  read is bounded by that size. A file swapped for a link after the checks, a FIFO, or a file
  that grows mid-read is refused, and so is a hard-linked file (more than one link). If
  removing the scratch directory fails, the failure is logged as a `SpeechTtsWarning` and does
  not replace the result or the error.
- **Secrets stay out of errors.** stderr and HTTP error bodies are redacted first, then
  trimmed to about 2 KB. The redaction covers `${env:...}` values, `secrets` and header values.
- **Misconfiguration fails closed.** A secret that resolves to nothing or a malformed entry
  stops selection with `TtsConfigError`, unless `tts.fallback` is set. An unknown `kind` stops
  it in every case.
- **Declared secrets add up.** An entry's own `secrets` list is kept, and the expanded
  `${env:...}` values are added to it. Every value in it is redacted.

## Adding a provider kind

The registry maps a profile's `kind` to a factory. `defaultTtsRegistry()` has `command`,
`http` and `fake`. An in-process engine registers its own kind. Kokoro does it like this:

```ts
const registry = defaultTtsRegistry().register("kokoro", kokoroFactory({ g2p }));
await selectTts({ registry, requirements });
```

A profile entry of an unregistered kind stops selection with `TtsConfigError` (`unknown-kind`).
To share one profile between hosts with and without the optional engine, pick the provider
on each host with `TITAN_SPEECH_TTS`, so the unavailable entry is never tried.

Every adapter must pass the conformance kit in `src/conformance.ts`: `runTtsConformance(name,
{ working, unavailable, hung })`. It checks that capabilities are honoured, that errors are
typed and carry the provider id, and that a hung engine times out at the deadline. Run it
once for each capability shape the adapter supports.

## Kokoro, in process

`kokoroProvider` runs Kokoro-82M in the host process and returns word timings taken from the
model's own durations. They match Python's `KPipeline.join_timestamps`.

Install the two optional peers where you use it:

```sh
npm install @huggingface/transformers kokoro-js
```

```ts
import { kokoroProvider } from "@titan-design/speech-tts";

const tts = kokoroProvider({ g2p, cacheDir });
const { audio, words } = await tts.synthesize({ text: "Hello there." }, "af_heart", { speed: 0.9 });
```

- **G2P is injected.** `g2p` is any object with `tokens(text)` that returns
  `{ text, phonemes, whitespace }` items. `misakiEnglish()` from `@titan-design/speech-g2p`
  fits. This package does not depend on it.
- **Input.** Text goes through `g2p`. Token input in the `misaki` alphabet is spoken as given.
  A token with no `phonemes` is sent to `g2p` alone.
- **Voices.** The US `af_*` and `am_*` voices, all `en-US`. Voice packs come from the
  `kokoro-js` peer.
- **fp32 only.** A profile `dtype` other than `fp32` is refused. Lower precisions shift the
  durations, and so every word time.
- **Cache.** Pass `cacheDir`, or `runtimeOptions(runtime, "tts")` (see "Choosing a device and
  cache"); the transformers.js default sits inside `node_modules`. The model is about
  325 MB at `<cacheDir>/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/`. A cold first call
  downloads it, so the default `timeoutMs` is 300000. Warm the provider at startup.
- **Offline.** With `TITAN_SPEECH_OFFLINE` set, a model not fully in `cacheDir` is refused
  before any network call, with `TtsUnavailableError`. A missing peer is also
  `TtsUnavailableError`, and a failed load is retried on the next call.
- **Long text** is cut into chunks of at most 510 phonemes, and word times are offset by the
  chunks before them.
- **Unknown words.** A word Kokoro cannot phonemize is not spoken. It still gets a
  `WordTiming` of zero width at the end of the last spoken word, and a `KokoroWarning` is
  emitted (or `onWarning` is called) naming it. Kokoro also skips an extra id after such a
  word, as Python does, so the words after it are timed late. Where that matters, such as
  narration for video, set `unknownWords: "fail"` (option or profile field; the default is
  `"warn"`): the call then rejects with `TtsUnknownWordsError`, listing every word with no
  phonemes and its token index, before the model loads. Give those words phonemes, or
  respell them, and call again.
- **Failures.** If the model's output breaks the contract, the call rejects with
  `TtsFailedError`. That covers phonemes the tokenizer drops and frames that do not add up to
  the audio length.
- **Word times are Python's heuristic.** The offset of the start is Python's choice, not
  measured from the audio. Parity with Python is the bar.

### Smoke check

`src/kokoro.smoke.test.ts` runs the real model against the golden beats. It is skipped unless
`SPEECH_TTS_SMOKE_CACHE` names a cache that already holds the model, because vitest sets
`TITAN_SPEECH_OFFLINE`. Fill the cache once with a short `node` script that calls
`StyleTextToSpeech2Model.from_pretrained` and `AutoTokenizer.from_pretrained` with
`{ dtype: "fp32", cache_dir }` for `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`. Then:

```sh
SPEECH_TTS_SMOKE_CACHE=<cache dir> pnpm vitest run kokoro.smoke
```

It asserts exact rounded durations, word boundaries within 1 ms of Python, and frames times
600 equal to the waveform length. It logs load time, inference time and the real-time factor.

`speakingSeconds` and `calibrateSpeed` help tune `speed` to a target words-per-minute.

## Testing without an engine

`fakeTts()` renders 0.3 s of 220 Hz tone per word, plus a 0.1 s gap, divided by `speed`. It
records its calls and honours its declared capabilities. `latencyMs` drives the deadline,
and `unavailable: true` simulates a missing engine. A profile entry of `"kind": "fake"` gives
a dry run.
