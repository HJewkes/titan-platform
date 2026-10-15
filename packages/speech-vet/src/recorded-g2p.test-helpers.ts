import espeak from "./fixtures/espeak-ipa.golden.json" with { type: "json" };
import type { PhoneG2p } from "./phones.js";

const recordings = new Map(espeak.entries.map((e) => [`${e.voice}\0${e.text}`, e.ipa]));
const caseKeys: Readonly<Record<string, string[][]>> = espeak.cases;

/** Replays recorded espeak-ng output; any call outside `allowed` throws, so a missing recording cannot pass. */
function replayG2p(allowed: ReadonlySet<string>, lookup: (key: string) => string | undefined): PhoneG2p {
  return (text, voice) => {
    const key = `${voice}\0${text}`;
    const ipa = allowed.has(key) ? lookup(key) : undefined;
    if (ipa === undefined) throw new Error(`no espeak recording for ${voice} ${JSON.stringify(text)}`);
    return ipa;
  };
}

/** The G2P an AB test case saw, keyed by the case's pytest name in `espeak-ipa.golden.json`. */
export function recordedG2p(caseName: string): PhoneG2p {
  const keys = caseKeys[caseName];
  if (!keys) throw new Error(`no espeak case named ${caseName}`);
  return replayG2p(new Set(keys.map(([voice, text]) => `${voice}\0${text}`)), (key) => recordings.get(key));
}

/** A G2P over one replay case's `espeak` map, which was recorded in `voice`. */
export function replayCaseG2p(recorded: Readonly<Record<string, string>>, voice: string): PhoneG2p {
  const byKey = new Map(Object.entries(recorded).map(([text, ipa]) => [`${voice}\0${text}`, ipa]));
  return replayG2p(new Set(byKey.keys()), (key) => byKey.get(key));
}
