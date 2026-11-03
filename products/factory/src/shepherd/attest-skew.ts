import { execGh, type GhExec } from "@titan-design/github";
import { BEHIND_MAIN_TIMEOUT_MS, compareWithMain } from "../behind-main.js";
import { DIRTY_SUFFIX, FACTORY_REPO, UNKNOWN_BUILD_SHA, buildSha } from "../build-info.js";

/** The attestation reader, the judge and the closure lock all live here, so a main commit under it may change what the running build reads. */
const REGISTRY_DIR = "products/factory/src/registry/";
const CLOSURE_LOCK = "closure.lock.json";

/** Why the attest read waits for a deploy, or undefined once the running build holds every registry commit on main (TP-4752). */
export type DeploySkew = (repo: string) => Promise<string | undefined>;

interface DeploySkewOptions {
  /** The running build's sha; defaults to `buildSha()`. */
  sha?: string;
  /** The repo the build is from; defaults to `FACTORY_REPO`. Only its PRs are judged by this build's registry. */
  repo?: string | undefined;
  exec?: GhExec;
  timeoutMs?: number;
}

const touchesRegistry = (path: string): boolean => path.startsWith(REGISTRY_DIR) || path === CLOSURE_LOCK || path.endsWith(`/${CLOSURE_LOCK}`);

/**
 * Main's commits the running build lacks, read through the same compare `/health` reports as behind-main. A failed read, a
 * build with no sha, or a file list too long to clear waits: the attest step never judges on a read it could not make.
 */
export function deploySkew(options: DeploySkewOptions = {}): DeploySkew {
  const { sha = buildSha(), exec = execGh, timeoutMs = BEHIND_MAIN_TIMEOUT_MS } = options;
  const factoryRepo = "repo" in options ? options.repo : FACTORY_REPO;
  return async (repo) => {
    if (factoryRepo === undefined || repo.toLowerCase() !== factoryRepo.toLowerCase()) return undefined;
    if (sha === UNKNOWN_BUILD_SHA) return "deploy skew: the running build has no sha, so it may lack main's registry commits";
    const build = sha.replace(DIRTY_SUFFIX, "");
    const compared = await compareWithMain(exec, factoryRepo, build, timeoutMs);
    if (typeof compared === "string") return `deploy skew unread against build ${build}: ${compared}`;
    if (compared.ahead === 0) return undefined;
    if (!compared.complete) return `deploy skew: main is ${compared.ahead} commit(s) ahead of build ${build} and the compare does not list every changed file`;
    const touched = compared.files.filter(touchesRegistry);
    if (touched.length === 0) return undefined;
    return `deploy skew: main is ${compared.ahead} commit(s) ahead of build ${build}, changing ${touched.length} registry path(s) such as ${touched[0]}; the attest read waits for the deploy`;
  };
}
