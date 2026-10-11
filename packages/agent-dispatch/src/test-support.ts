import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Installs an executable script at `path` without this process ever holding it open for writing.
 * Tests run on worker threads of one process, and a sibling thread's fork inherits any fd open at
 * that moment; on Linux, exec'ing a file a child still has open for write fails ETXTBSY. Letting
 * `cp` do the write keeps the fd in a process that has exited before the first exec.
 */
export function installExecutable(path: string, contents: string): void {
  const staging = `${path}.staging`;
  writeFileSync(staging, contents);
  chmodSync(staging, 0o755);
  execFileSync("cp", ["-p", staging, path]);
  rmSync(staging);
}

/** Writes `<name>.json` into `<root>/profiles` for each profile, with the surface given, and returns that directory. */
export function installProfiles(root: string, surfaces: Record<string, string>): string {
  const profilesDir = join(root, "profiles");
  mkdirSync(profilesDir, { recursive: true });
  for (const [name, surface] of Object.entries(surfaces)) {
    writeFileSync(join(profilesDir, `${name}.json`), JSON.stringify({ surface }));
  }
  return profilesDir;
}
