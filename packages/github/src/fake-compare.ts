import { COMPARE_COMMIT_CAP, COMPARE_FILE_CAP, type BranchCommits, type CompareResult } from "./port.js";
import type { FakeGitHub } from "./fake-types.js";

export function compareFiles(fake: FakeGitHub, base: string, head: string): CompareResult {
  const input = fake.compares.get(`${base}...${head}`) ?? { mergeBaseSha: fake.refs.get(base) ?? base, files: [] };
  const truncated = input.files.length >= COMPARE_FILE_CAP || (input.totalCommits ?? 0) > COMPARE_COMMIT_CAP;
  return { mergeBaseSha: input.mergeBaseSha, files: input.files.slice(0, COMPARE_FILE_CAP), truncated };
}

export function compareCommits(fake: FakeGitHub, base: string, head: string): BranchCommits {
  const input = fake.compares.get(`${base}...${head}`) ?? { mergeBaseSha: fake.refs.get(base) ?? base, files: [] };
  const commits = input.commits ?? [];
  const truncated = input.files.length >= COMPARE_FILE_CAP || (input.totalCommits ?? commits.length) > COMPARE_COMMIT_CAP;
  return { mergeBaseSha: input.mergeBaseSha, commits: commits.slice(0, COMPARE_COMMIT_CAP).map((commit) => ({ ...commit })), files: input.files.slice(0, COMPARE_FILE_CAP), truncated };
}
