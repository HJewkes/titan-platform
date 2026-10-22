import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitOrNull } from "./git.js";
import type { ReleaseCheck } from "./release-safety.js";

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 3_000;
interface GhPr { state: string; headRefOid: string; commits: readonly string[] }

function commitOids(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries: unknown[] = value;
  const oids: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || !("oid" in entry) || typeof entry.oid !== "string") return null;
    oids.push(entry.oid);
  }
  return oids;
}
function parsePr(value: unknown): GhPr | null {
  if (typeof value !== "object" || value === null || !("state" in value) || !("headRefOid" in value) || !("commits" in value)) return null;
  const commits = commitOids(value.commits);
  return typeof value.state === "string" && typeof value.headRefOid === "string" && commits !== null
    ? { state: value.state, headRefOid: value.headRefOid, commits } : null;
}
async function readPr(gitRoot: string, branch: string): Promise<GhPr | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", branch, "--json", "state,headRefOid,commits"], {
      cwd: gitRoot, encoding: "utf8", timeout: GH_TIMEOUT_MS,
    });
    const value: unknown = JSON.parse(stdout);
    return parsePr(value);
  } catch { return null; }
}
function proofFromPr(pr: GhPr, tip: string | null): { merged: boolean; check: ReleaseCheck } {
  if (pr.state === "MERGED" && tip !== null) {
    const sha7 = tip.slice(0, 7);
    if (pr.headRefOid === tip) return { merged: true, check: { name: "gh", ok: true, detail: `gh reports PR merged at ${sha7}` } };
    if (pr.commits.includes(tip)) return { merged: true, check: { name: "gh", ok: true, detail: `gh reports PR merged; local tip ${sha7} is in it` } };
  }
  return { merged: false, check: { name: "gh", ok: true, detail: `gh reports the PR as ${pr.state}` } };
}
/** CC-792/CC-624: only a merged head or merged commit containing this local tip supplies landing evidence. */
export async function readMergedTipProof(gitRoot: string, branch: string): Promise<{ merged: boolean; check: ReleaseCheck } | null> {
  const pr = await readPr(gitRoot, branch);
  return pr === null ? null : proofFromPr(pr, await gitOrNull(["rev-parse", branch], gitRoot));
}
