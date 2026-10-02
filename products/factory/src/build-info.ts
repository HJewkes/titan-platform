declare const __FACTORY_BUILD_SHA__: string | undefined;

export const UNKNOWN_BUILD_SHA = "unknown";

/** The git sha tsup baked in; `unknown` when the define is absent (vitest, unbuilt source) or empty. */
export function buildSha(): string {
  return (typeof __FACTORY_BUILD_SHA__ === "string" && __FACTORY_BUILD_SHA__) || UNKNOWN_BUILD_SHA;
}
