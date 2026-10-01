/** A session may inject `core.hooksPath` through `GIT_CONFIG_*`; fixture git commands run without it. */
export function fixtureEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG_")));
}
