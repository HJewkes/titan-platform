export const LAUNCH_USAGE = "usage: titan-agent-launch [--launcher-pid-env NAME] <plan.json>";

export interface LaunchArgs {
  planFile: string;
  launcherPidEnv?: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The bin's whole command line: one plan file, and optionally the variable that carries the launcher pid. */
export function parseLaunchArgs(argv: readonly string[]): LaunchArgs | { error: string } {
  const rest = [...argv];
  let launcherPidEnv: string | undefined;
  if (rest[0] === "--launcher-pid-env") {
    launcherPidEnv = rest[1];
    if (launcherPidEnv === undefined || !ENV_NAME.test(launcherPidEnv))
      return { error: `--launcher-pid-env needs a variable name\n${LAUNCH_USAGE}` };
    rest.splice(0, 2);
  }
  const [planFile, ...extra] = rest;
  if (planFile === undefined || planFile.startsWith("-") || extra.length > 0) return { error: LAUNCH_USAGE };
  return launcherPidEnv === undefined ? { planFile } : { planFile, launcherPidEnv };
}
