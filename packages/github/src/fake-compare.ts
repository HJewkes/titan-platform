import { COMPARE_COMMIT_CAP, COMPARE_FILE_CAP, type BranchCommits, type CompareResult } from "./port-types.js";
import type { FakeGitHub } from "./fake-types.js";

type CompareInput = NonNullable<ReturnType<FakeGitHub["compares"]["get"]>>;

/** Entries are capped, then each renamed entry also names its previous path, as the real compare does. */
const listedFiles = (input: CompareInput): string[] =>
  input.files.slice(0, COMPARE_FILE_CAP).flatMap((file) => (input.renames?.[file] === undefined ? [file] : [file, input.renames[file]]));

export function compareFiles(fake: FakeGitHub, base: string, head: string): CompareResult {
  const input = fake.compares.get(`${base}...${head}`) ?? { mergeBaseSha: fake.refs.get(base) ?? base, files: [] };
  const truncated = input.files.length >= COMPARE_FILE_CAP || (input.totalCommits ?? 0) > COMPARE_COMMIT_CAP;
  return { mergeBaseSha: input.mergeBaseSha, files: listedFiles(input), truncated };
}

export function compareCommits(fake: FakeGitHub, base: string, head: string): BranchCommits {
  const input = fake.compares.get(`${base}...${head}`) ?? { mergeBaseSha: fake.refs.get(base) ?? base, files: [] };
  const commits = input.commits ?? [];
  const truncated = input.files.length >= COMPARE_FILE_CAP || (input.totalCommits ?? commits.length) > COMPARE_COMMIT_CAP;
  return { mergeBaseSha: input.mergeBaseSha, commits: commits.slice(0, COMPARE_COMMIT_CAP).map((commit) => ({ ...commit })), files: listedFiles(input), truncated };
}
