/** Root files every workspace build reads; a lockfile bump for an unrelated package over-triggers, which costs one rebuild. */
const ROOT_BUILD_INPUTS: readonly string[] = ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", ".npmrc"];
const ROOT_TSCONFIG = /^tsconfig[^/]*\.json$/;
/** Files inside a closure package that never reach its dist. */
const NON_RUNTIME = /(\.(test|spec)\.[cm]?tsx?|\.md)$/;

function isRootInput(file: string): boolean {
  return ROOT_BUILD_INPUTS.includes(file) || ROOT_TSCONFIG.test(file);
}

/** The changed paths a build of the closure dirs reads: root inputs, plus runtime files inside a closure dir. */
export function touchedPaths(changed: readonly string[], closure: readonly string[]): string[] {
  return changed.filter((file) => isRootInput(file) || (!NON_RUNTIME.test(file) && closure.some((dir) => file.startsWith(`${dir}/`))));
}
