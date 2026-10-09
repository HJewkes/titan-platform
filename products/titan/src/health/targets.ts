import { join } from "node:path";
import { z } from "zod";
import type { ProbeHttpTarget } from "@titan-design/health";

/** A probe target, plus the state dir whose `daemon.pid` names the process that must answer. */
export interface HealthTarget extends ProbeHttpTarget {
  pidStateDir?: string;
}

export interface HostEnv {
  env: NodeJS.ProcessEnv;
  home: string;
}

interface LoadTargetsDeps extends HostEnv {
  readFile: (path: string) => string;
  warn: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const FACTORY_PORT = 7410;

// tp#870's restart fields are read as serve reports them; a 60 s probe cannot see a 5 s restart itself.
const FACTORY_OBSERVE = ["startedAt", "uptimeSeconds", "restartCount", "uncleanStartsTotal", "restartsToday", "build.sha", "version"];

const hostTargetSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  expectPort: z.number().int().positive().optional(),
  observe: z.array(z.string().min(1)).optional(),
  pidStateDir: z.string().min(1).optional(),
});
const hostJsonSchema = z.object({ health: z.object({ targets: z.array(hostTargetSchema).default([]) }).optional() });
type HostTarget = z.infer<typeof hostTargetSchema>;

export function stateHome({ env, home }: HostEnv): string {
  return env.XDG_STATE_HOME || join(home, ".local", "state");
}

function hostJsonPath({ env, home }: HostEnv): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "titan", "host.json");
}

function defaultTargets(host: HostEnv): HealthTarget[] {
  return [
    {
      name: "factory",
      url: `http://127.0.0.1:${FACTORY_PORT}/health`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      expectPort: FACTORY_PORT,
      pidStateDir: join(stateHome(host), "titan-factory"),
      observe: FACTORY_OBSERVE,
    },
  ];
}

/**
 * The default targets with `host.json`'s `health.targets` laid over them by name. A host.json
 * that is missing leaves the defaults quietly; one that is unreadable or invalid leaves them
 * with one warning, because a sampler that stops sampling over a config typo records nothing.
 */
export function loadTargets(deps: LoadTargetsDeps): HealthTarget[] {
  const defaults = defaultTargets(deps);
  const path = hostJsonPath(deps);
  let overrides: HostTarget[];
  try {
    overrides = readHostTargets(deps.readFile, path);
  } catch (error) {
    deps.warn(`titan: ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return defaults;
  }
  const targets = overlay(defaults, overrides);
  if (targets) return targets;
  deps.warn(`titan: ignoring ${path}: a new target needs a url`);
  return defaults;
}

function readHostTargets(readFile: (path: string) => string, path: string): HostTarget[] {
  let text: string;
  try {
    text = readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return hostJsonSchema.parse(JSON.parse(text)).health?.targets ?? [];
}

function overlay(defaults: HealthTarget[], overrides: HostTarget[]): HealthTarget[] | undefined {
  const byName = new Map(defaults.map((t) => [t.name, t]));
  for (const override of overrides) {
    const base = byName.get(override.name);
    if (!base && !override.url) return undefined;
    byName.set(override.name, { timeoutMs: DEFAULT_TIMEOUT_MS, ...base, ...stripUndefined(override) } as HealthTarget);
  }
  return [...byName.values()];
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
