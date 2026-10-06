import type { Unwrapped } from "./unwrap.js";

/**
 * A dynamic command word may name any guarded command, which `classify` reads per family (see
 * `dynamicReadings`). Words after it that cannot be read (a dynamic word, or xargs input that is unknown)
 * could be any verb, so the run is also read as `git <that word> ...`, which fails closed as `git "$X"` does.
 */
export function withDynamicName(run: Unwrapped, unknownInput: boolean): Unwrapped[] {
  const [word, next] = run.args;
  if (run.name !== null || !word?.dynamic || !(unknownInput || next?.dynamic)) return [run];
  return [run, { ...run, name: "git", path: "git" }];
}
