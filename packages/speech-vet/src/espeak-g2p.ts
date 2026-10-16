import { execFileSync } from "node:child_process";
import { DEFAULT_PHONE_VOICE, type PhoneG2p } from "./phones.js";

/** Runs `argv[0]` with the rest as arguments and returns its stdout. Throws on a failed or timed-out run. */
export type EspeakRunner = (argv: readonly string[], options: { timeoutMs: number }) => string;

export interface EspeakCliOptions {
  /** Defaults to `DEFAULT_PHONE_VOICE`. */
  voice?: string;
  /** The espeak-ng executable; defaults to `espeak-ng` on the PATH. */
  bin?: string;
  /** Replaces the process spawn, so tests never need the binary. */
  run?: EspeakRunner;
  /** Called once per failed run; the G2P itself returns "" so one bad chunk never aborts a scan. */
  onError?: (error: unknown) => void;
}

export const ESPEAK_TIMEOUT_MS = 10_000;

const DEFAULT_BIN = "espeak-ng";

const spawnRunner: EspeakRunner = (argv, { timeoutMs }) => {
  const [bin = DEFAULT_BIN, ...args] = argv;
  return execFileSync(bin, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
};

/**
 * A `PhoneG2p` backed by the espeak-ng CLI, run exactly as the audiobook backend runs it:
 * `espeak-ng -q --ipa=3 -v <voice> <text>`. espeak-ng is a GPL binary the caller installs
 * (apt or brew); it is called as a process and never bundled or linked.
 */
export function espeakCliG2p(options: EspeakCliOptions = {}): PhoneG2p {
  const { voice: defaultVoice = DEFAULT_PHONE_VOICE, bin = DEFAULT_BIN, run = spawnRunner, onError } = options;
  return (text, voice = defaultVoice) => {
    try {
      return run([bin, "-q", "--ipa=3", "-v", voice, text], { timeoutMs: ESPEAK_TIMEOUT_MS });
    } catch (error) {
      onError?.(error);
      return "";
    }
  };
}

/** The espeak-ng version (`1.52.0`), or `null` when the binary is missing or prints no version. */
export function espeakVersion(options: Pick<EspeakCliOptions, "bin" | "run"> = {}): string | null {
  const { bin = DEFAULT_BIN, run = spawnRunner } = options;
  try {
    const out = run([bin, "--version"], { timeoutMs: ESPEAK_TIMEOUT_MS });
    return /text-to-speech:\s*(\d+(?:\.\d+)*)/i.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}
