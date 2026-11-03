import type { PutFileRequest } from "./port-types.js";
import type { GitHubWire, RepoSlug, WriteResult } from "./port.js";
import { checkPath, checkRef, checkSha } from "./validate.js";

/** A write whose precondition no longer holds, such as a blob that changed under an edit. */
export class GitHubConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubConflictError";
  }
}

export function checkPutFile(request: PutFileRequest): PutFileRequest {
  checkPath(request.path);
  checkRef("branch", request.branch);
  if (request.expectedBlobSha !== null) checkSha("expectedBlobSha", request.expectedBlobSha);
  return request;
}

export async function putFile(wire: GitHubWire, repo: RepoSlug, request: PutFileRequest): Promise<WriteResult<{ blobSha: string }>> {
  const current = await wire.getContent(repo, request.path, request.branch);
  if (current && current.content === request.content) return { blobSha: current.blobSha, done: false, skipped: "unchanged" };
  const currentSha = current?.blobSha ?? null;
  if (currentSha !== request.expectedBlobSha) {
    throw new GitHubConflictError(`${request.path} on ${request.branch} is blob ${currentSha ?? "absent"}, expected ${request.expectedBlobSha ?? "absent"}`);
  }
  const written = await wire.putContent(repo, request);
  return { blobSha: written.blobSha, done: true };
}
