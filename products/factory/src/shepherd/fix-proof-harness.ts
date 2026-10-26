import { PR_FILES_CAP, type GitHubPort, type PrFile, type RepoSlug } from "@titan-design/github";
import { failureOf } from "./error-class.js";

export const FIX_PROOF_CHECK = "fix-proof";
/**
 * On `pull_request` the PR merge ref supplies the workflow file and the run script, so a PR touching any of these
 * chose the code that printed its own result line.
 */
const FIX_PROOF_HARNESS: readonly string[] = [".github/workflows/", ".github/actions/", ".github/fix-proof.json", "scripts/fix-proof-run.sh"];

const inHarness = (path: string): boolean => FIX_PROOF_HARNESS.some((prefix) => path.startsWith(prefix));
const harnessPathOf = (files: readonly PrFile[]): string | undefined => files.flatMap((file) => [file.path, file.previousPath ?? file.path]).find(inHarness);

/** Why the PR may have chosen its own harness, or undefined when its changed files are read in full and leave the harness alone. */
export async function harnessTouch(port: GitHubPort, repo: RepoSlug, pr: number | null): Promise<string | undefined> {
  if (pr === null) return "the registration names no PR, so its changed files are unknown";
  let files: PrFile[];
  try {
    files = await port.listPrFiles(repo, pr);
  } catch (error) {
    return `the PR's changed files could not be read: ${failureOf(error)}`;
  }
  if (files.length >= PR_FILES_CAP) return `the PR changes ${files.length} files, at GitHub's ${PR_FILES_CAP}-file list cap`;
  const touched = harnessPathOf(files);
  return touched && `the PR changes the ${FIX_PROOF_CHECK} harness: ${touched}`;
}
