import { mergeNamesFor } from "../families/merge.js";
import { releaseNamesFor } from "../families/release.js";
import type { Unwrapped } from "./unwrap.js";

/**
 * A dynamic command word (`"$G" push origin HEAD:main`) may name any guarded command, so the run is also read
 * as each one whose family would recognise the words after it as a guarded verb, and as nothing otherwise
 * (`"$EDITOR" file`). Words after it that cannot be read (dynamic, or xargs input that is unknown with no verb yet named) could be
 * any verb, so the run is read as `git <that word> ...`, which fails closed as `git "$X"` does.
 */
export function dynamicReadings(run: Unwrapped, unknownInput: boolean): Unwrapped[] {
  const [word, ...rest] = run.args;
  if (run.name !== null || !word?.dynamic) return [run];
  const names = new Set([...mergeNamesFor(rest), ...releaseNamesFor(rest)]);
  if (rest[0]?.dynamic || (unknownInput && names.size === 0)) return [run, { ...run, name: "git", path: "git" }];
  const guarded = [...names].map((name) => (name === "git" ? { ...run, name, path: name } : { ...run, name, path: name, args: rest }));
  return [run, ...guarded];
}
