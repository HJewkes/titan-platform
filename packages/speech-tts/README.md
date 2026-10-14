# @titan-design/speech-tts

A swappable text-to-speech layer: one `TtsProvider` contract, a registry that picks a provider
from a deployment's profile and environment, and adapters for any external engine. Nothing
about the host is assumed. A deployment says which engines it has; callers say which
capabilities they need.

Tier 1 of the titan-platform DAG. No runtime dependencies and no model downloads.

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
| `TtsFailedError` | `failed` | The engine answered with an error or with output that breaks the contract. |

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
`skipped` says why each earlier one was passed over. When none qualifies, the error names
each provider and what it lacks:

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
| `${env:NAME}` in a header value | Expanded from the environment, so a profile can be shared without its secrets. If the variable is unset, the provider is skipped with that reason. |

`<ID>` is the provider id upper-cased, with every other character as `_`.

The package never chooses a path on its own. A product that wants a default location can
pass `appDirs("titan-speech").config` from `@titan-design/app-paths`, joined with
`profile.json`.

## Swapping providers for your deployment

Each machine gets its own profile. Code that calls `selectTts` stays the same everywhere.

**A laptop, CPU only.** The in-process Kokoro adapter is the default once it ships (see
"Adding a provider kind"). The fallback is a local CPU engine wrapped in the command contract.

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
`stdout-wav` carries the audio back with no shared paths.

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
{ "version": 1, "voice": "narrator", "text": "Hello there.", "speed": 1.1, "language": "en-US", "out": "/tmp/speech-tts-x/out.wav" }
```

Token input sends `"tokens": [{ "text", "phonemes", "whitespace" }]` and `"alphabet"` in place
of `"text"`. `speed` and `language` are present only when the caller set them. `out` is
present only in `json` mode.

The answer depends on `output`:

- **`stdout-wav`**: stdout is RIFF/WAVE bytes, PCM16 or float32, at any sample rate (the
  header is read). A streamed WAV with unpatched sizes is accepted.
- **`json`** (the default): stdout is one JSON object with the audio as `"wav": "<path>"`
  (usually the request's `out`) or as `"audioBase64"`. It may add `"durationS"`,
  `"words": [{ "word", "start", "end" }]` in seconds, and `"phonemes": ["..."]`.

Exit 0 means success. Exit 69 (EX_UNAVAILABLE), 127 or 255 (ssh could not connect) means
unavailable; `unavailableExitCodes` changes that list. Any other exit fails, with the tail of
stderr in the message. At the deadline, the whole process group is sent SIGKILL. The per-call
scratch directory is removed afterwards.

## The `http` mapping

`httpTts` sends one JSON request built from `request.body`, a template:

- A string that is exactly `"{{name}}"` becomes the value with its type, so `speed` stays a
  number. If the value is unset, the key is dropped.
- Inside a longer string, `{{name}}` is interpolated.
- Names: `text`, `voice`, `speed`, `language`, `alphabet`, `tokens`, and `phonemes`. `phonemes`
  is each token's phonemes, or its text when it has none, joined by its whitespace.

`response` is `{ "type": "wav" }` when the body is a WAV file, or
`{ "type": "json", "audioBase64": "<path>", "words"?, "durationS"?, "phonemes"? }`, with dot
paths such as `result.audio`. Statuses 502, 503 and 504 are unavailable; any other non-2xx
fails with the start of the body. No vendor SDK is involved.

## Adding a provider kind

The registry maps a profile's `kind` to a factory. `defaultTtsRegistry()` has `command`,
`http` and `fake`. An in-process engine, such as the Kokoro ONNX adapter planned as the next
slice, registers its own kind:

```ts
const registry = defaultTtsRegistry().register("kokoro", (id, config) => kokoroProvider({ id, ...config }));
await selectTts({ registry, requirements });
```

A profile entry of an unregistered kind is skipped, with that reason, so one profile can
serve hosts with and without the optional engine installed.

Every adapter must pass the conformance kit in `src/conformance.ts`: `runTtsConformance(name,
{ working, unavailable, hung })`. It checks that capabilities are honoured, that errors are
typed and carry the provider id, and that a hung engine times out at the deadline. Run it
once for each capability shape the adapter supports.

## Testing without an engine

`fakeTts()` renders 0.3 s of 220 Hz tone per word, plus a 0.1 s gap, divided by `speed`. It
records its calls and honours its declared capabilities. `latencyMs` drives the deadline,
and `unavailable: true` simulates a missing engine. A profile entry of `"kind": "fake"` gives
a dry run.
