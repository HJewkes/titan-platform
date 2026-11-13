import { latestPerName } from "./checks.js";
import { updateBranch } from "./update-branch-retry.js";
import { tail } from "./log-tail.js";
import { pushEmptyCommit } from "./push-empty-commit.js";
import { wholeForcePushes } from "./force-pushes.js";
import { memoizedLogin, upsertComment } from "./upsert-comment.js";
import { pause } from "./write-read-back.js";
import { merge, rerunFailed, rerunJob } from "./merge-writes.js";
import { deleteRef, ensureBranch } from "./ref-writes.js";
import { closePr, setPrBase } from "./close-pr.js";
import { listPrFiles } from "./pr-files.js";
import { findPr, openPr } from "./pr-open.js";
import { checkConclusion, checkMarker, checkMaxBytes, checkMergeMethod, checkNonEmpty, checkPath, checkPositiveInt, checkRef, checkRepo, checkSha, checkShaPrefix, checkTimestamp } from "./validate.js";
import { checkPutFile, putFile } from "./put-file.js";
import type { GitHubPort, GitHubPortOptions, GitHubWire } from "./port-types.js";

/** Every argument is validated before any wire call, because each one becomes part of a `gh api` path. */
export function githubPort(wire: GitHubWire, options: GitHubPortOptions = {}): GitHubPort {
  const repoOf = checkRepo;
  const pr = (number: number) => checkPositiveInt("pr", number);
  const login = options.login === undefined ? memoizedLogin(wire) : async () => options.login!;
  const sleep = options.sleep ?? pause;
  return {
    getHeadSha: async (repo, branch) => wire.getRef(repoOf(repo), checkRef("branch", branch)),
    ensureBranch: async (repo, branch, baseSha) => ensureBranch(wire, repoOf(repo), checkRef("branch", branch), checkSha("baseSha", baseSha)),
    deleteRef: async (repo, head) => deleteRef(wire, repoOf(repo), { branch: checkRef("branch", head.branch), repo: head.repo }),
    getFile: async (repo, path, ref) => wire.getContent(repoOf(repo), checkPath(path), checkRef("ref", ref)),
    fileBytes: async (repo, path, ref, opts = {}) => wire.getContentBytes(repoOf(repo), checkPath(path), checkRef("ref", ref), checkMaxBytes(opts.maxBytes)),
    listFiles: async (repo, path, ref) => wire.listDirectory(repoOf(repo), checkPath(path), checkRef("ref", ref)),
    putFile: async (repo, request) => putFile(wire, repoOf(repo), checkPutFile(request)),
    findPr: async (repo, headBranch) => findPr(wire, repoOf(repo), checkRef("head", headBranch)),
    listOpenPrs: async (repo, headPrefix = "") => (await wire.listOpenPrs(repoOf(repo))).filter((open) => open.headRef.startsWith(headPrefix)),
    revalidateOpenPrs: async (repo, etag) => wire.revalidateOpenPrs(repoOf(repo), etag),
    revalidateRef: async (repo, branch, etag) => wire.revalidateRef(repoOf(repo), checkRef("branch", branch), etag),
    revalidateRulesets: async (repo, etag) => wire.revalidateRulesets(repoOf(repo), etag),
    openPr: async (repo, request) => openPr(wire, repoOf(repo), { ...request, head: checkRef("head", request.head), base: checkRef("base", request.base) }),
    getPr: async (repo, number) => wire.getPr(repoOf(repo), pr(number)),
    defaultBranch: async (repo) => wire.getDefaultBranch(repoOf(repo)),
    requiredChecks: async (repo, branch) => wire.getBranchRules(repoOf(repo), checkRef("branch", branch)),
    classicRequiredChecks: async (repo, branch) => wire.getClassicRequiredChecks(repoOf(repo), checkRef("branch", branch)),
    reviewRulesBypassable: async (repo, branch) => wire.reviewRulesBypassable(repoOf(repo), checkRef("branch", branch)),
    branchProtected: async (repo, branch) => wire.getBranchProtected(repoOf(repo), checkRef("branch", branch)),
    checkRuns: async (repo, sha) => wire.listCheckRuns(repoOf(repo), checkSha("sha", sha)),
    checkRunAttempts: async (repo, sha) => wire.listCheckRuns(repoOf(repo), checkSha("sha", sha), "all"),
    latestCheckRuns: async (repo, sha) => latestPerName(await wire.listCheckRuns(repoOf(repo), checkSha("sha", sha))),
    createCheckRun: async (repo, request) => wire.createCheckRun(repoOf(repo), { ...request, headSha: checkSha("headSha", request.headSha), conclusion: checkConclusion(request.conclusion) }),
    getCommit: async (repo, sha) => wire.getCommit(repoOf(repo), checkSha("sha", sha)),
    commitLogins: async (repo, sha) => wire.getCommitLogins(repoOf(repo), checkSha("sha", sha)),
    resolveCommit: async (repo, sha) => wire.resolveCommit(repoOf(repo), checkShaPrefix("sha", sha)),
    commitStatuses: async (repo, sha) => wire.listCommitStatuses(repoOf(repo), checkSha("sha", sha)),
    jobLogTail: async (repo, jobId, lines) => tail(await wire.getJobLog(repoOf(repo), checkPositiveInt("jobId", jobId)), checkPositiveInt("lines", lines)),
    jobSteps: async (repo, jobId) => wire.getJobSteps(repoOf(repo), checkPositiveInt("jobId", jobId)),
    updateBranch: async (repo, number, expectedHeadSha) => updateBranch(wire, repoOf(repo), pr(number), checkSha("expectedHeadSha", expectedHeadSha)),
    setPrBase: async (repo, number, base) => setPrBase(wire, repoOf(repo), pr(number), checkRef("base", base)),
    closePr: async (repo, number) => closePr(wire, repoOf(repo), pr(number)),
    pushEmptyCommit: async (repo, branch, expectedHeadSha, message) => pushEmptyCommit(wire, repoOf(repo), checkRef("branch", branch), checkSha("expectedHeadSha", expectedHeadSha), message),
    merge: async (repo, number, sha, method, message, expectedBase) => merge(wire, repoOf(repo), pr(number), checkSha("sha", sha), checkMergeMethod(method), sleep, message, expectedBase),
    mergeIntoBranch: async (repo, request) => wire.mergeIntoBranch(repoOf(repo), { ...request, branch: checkRef("branch", request.branch), head: checkSha("head", request.head) }),
    getSquashSource: async (repo, number) => wire.getSquashSource(repoOf(repo), pr(number)),
    rerunFailed: async (repo, runId) => rerunFailed(wire, repoOf(repo), checkPositiveInt("runId", runId), sleep),
    workflowRunStatus: async (repo, runId) => wire.getWorkflowRunStatus(repoOf(repo), checkPositiveInt("runId", runId)),
    rerunJob: async (repo, runId, jobId) => rerunJob(wire, repoOf(repo), checkPositiveInt("runId", runId), checkPositiveInt("jobId", jobId), sleep),
    listPrFiles: async (repo, number) => listPrFiles(wire, repoOf(repo), pr(number)),
    listPrCommits: async (repo, number) => wire.listPrCommits(repoOf(repo), pr(number)),
    listDefaultBranchCommits: async (repo, since) => wire.listCommits(repoOf(repo), checkTimestamp("since", since)),
    compareFiles: async (repo, base, head) => wire.compareFiles(repoOf(repo), checkRef("base", base), checkRef("head", head)),
    listBranchCommits: async (repo, base, head) => wire.compareCommits(repoOf(repo), checkRef("base", base), checkRef("head", head)),
    actorLogin: async () => login(),
    compareAncestry: async (repo, base, head) => wire.compareAncestry(repoOf(repo), checkRef("base", base), checkRef("head", head)),
    upsertComment: async (repo, number, marker, body) => upsertComment(wire, login, repoOf(repo), pr(number), checkMarker(marker), body, sleep),
    listReviewComments: async (repo, number) => wire.listReviewComments(repoOf(repo), pr(number)),
    listReviews: async (repo, number) => wire.listReviews(repoOf(repo), pr(number)),
    createReview: async (repo, number, request) => wire.createReview(repoOf(repo), pr(number), { ...request, commitId: checkSha("commitId", request.commitId) }),
    dismissReview: async (repo, number, reviewId, message) => wire.dismissReview(repoOf(repo), pr(number), checkPositiveInt("reviewId", reviewId), checkNonEmpty("message", message)),
    listForcePushes: async (repo, number) => wholeForcePushes(await wire.listForcePushes(repoOf(repo), pr(number))),
  };
}

