import { versionOnlyManifestChange } from "./deploy-closure.js";
import type { CommandResult } from "./service-control.js";

/** Runs git in the service checkout. */
type CheckoutGit = (args: readonly string[]) => Promise<CommandResult>;

/** The file at `sha`, or undefined when git cannot show it. */
export async function showAt(git: CheckoutGit, sha: string, path: string): Promise<string | undefined> {
  const shown = await git(["show", `${sha}:${path}`]);
  return shown.code === 0 ? shown.stdout : undefined;
}

export async function changedPaths(git: CheckoutGit, from: string, target: string): Promise<string[] | undefined> {
  const diff = await git(["diff", "--name-only", "--no-renames", from, target]);
  return diff.code === 0 ? diff.stdout.split("\n").filter((line) => line !== "") : undefined;
}

/** A Version Packages merge bumps only package versions, which the build never reads, so those manifests are not build inputs. */
export async function runtimeTouched(git: CheckoutGit, touched: string[], from: string | undefined, target: string): Promise<string[]> {
  if (from === undefined) return touched;
  const kept = await Promise.all(touched.map(async (path) => !path.endsWith("/package.json") || !versionOnlyManifestChange(await showAt(git, from, path), await showAt(git, target, path))));
  return touched.filter((_, index) => kept[index]);
}
