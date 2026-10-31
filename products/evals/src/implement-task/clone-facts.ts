import type { BundleGit } from "../review-pr/bundle.js";
import type { CandidateFacts, CorpusV3Row, TestChange } from "./select.js";
import { planHiddenTests } from "./write-case.js";

const SUPPORTED_LOCKFILES = ["pnpm-lock.yaml", "package-lock.json"] as const;

async function existsAt(port: BundleGit, sha: string, path: string): Promise<boolean> {
  try {
    await port.git(["cat-file", "-e", `${sha}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** Answers the selector's clone questions with git; `gitFor` maps a row to a port on its repo's clone. */
export function cloneFacts(gitFor: (row: CorpusV3Row) => BundleGit): CandidateFacts {
  return {
    hasSupportedLock: async (row) => {
      const port = gitFor(row);
      const found = await Promise.all(SUPPORTED_LOCKFILES.map((name) => existsAt(port, row.base_commit, name)));
      return found.some(Boolean);
    },
    mergeParents: async (row) => {
      const line = (await gitFor(row).git(["rev-list", "--parents", "-n", "1", row.merge_commit])).toString("utf8").trim();
      return line.split(/\s+/).length - 1;
    },
    testChange: async (row): Promise<TestChange> => {
      const plan = await planHiddenTests(gitFor(row), row.base_commit, row.merge_commit);
      if (plan.tests.length === 0) return "no-test-change";
      return plan.source.length === 0 ? "test-only" : "tests-and-source";
    },
  };
}
