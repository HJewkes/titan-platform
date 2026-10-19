import type { ConfigRow, ConfigSurfaces, SurfaceReader } from "./catalog.js";
import { CONSOLE_ENV_SURFACE, FACTORY_CONFIG_SURFACE } from "./specs.js";
import { readTarget } from "./files.js";

/** titan-factory's `config.json`; its path follows the factory's own `configPath` rule. */
export function factorySurfaces(factoryConfigPath: string): SurfaceReader {
  return () => readTarget({ spec: FACTORY_CONFIG_SURFACE, surface: "factory-config", file: factoryConfigPath });
}

export const CONSOLE_ENV_FILE = "process environment";

function envRow(name: string, value: string | undefined, declared: ReadonlySet<string>): ConfigRow {
  const base = { surface: "console-env", file: CONSOLE_ENV_FILE, field: name, line: 0, decisions: [] };
  if (!declared.has(name)) return { ...base, hidden: true };
  return value === undefined ? { ...base, hidden: false, value: null, comment: "unset; the default applies" } : { ...base, hidden: false, value };
}

/**
 * The `TITAN_CONSOLE_*` variables the daemon started with. Every declared one is a row, unset ones
 * included, so the page can say owner writes are off; an undeclared one is listed hidden.
 */
export function consoleEnvSurfaces(env: Readonly<Record<string, string>>, readAt: string): SurfaceReader {
  const declared = new Set(CONSOLE_ENV_SURFACE.safeFields);
  const names = [...new Set([...CONSOLE_ENV_SURFACE.safeFields, ...Object.keys(env).filter((name) => name.startsWith("TITAN_CONSOLE_"))])].sort();
  const { kind, group, inventory } = CONSOLE_ENV_SURFACE;
  const answer: ConfigSurfaces = {
    files: [{ surface: "console-env", kind, group, inventory, file: CONSOLE_ENV_FILE, mtime: readAt, newestBackup: null }],
    rows: names.map((name) => envRow(name, env[name], declared)),
    gaps: [],
  };
  return () => Promise.resolve(answer);
}
