import { z } from "zod";

export interface ReviewFile {
  name: string;
  mtimeMs: number;
}

/** `running` until the roster shows the planner gone; `unknown` when the roster could not be read, so only the deadline ends the watch. */
export interface PlannerPresence {
  state: "running" | "gone" | "unknown";
  transcriptPath?: string;
}

/** The last line the API itself wrote into the planner's transcript: the reason a planner dies seconds after its spawn. */
export interface ApiError {
  text: string;
  apiError?: string;
  resetsAt?: number;
}

export interface WatchPorts {
  listReviews: () => ReviewFile[];
  presence: () => Promise<PlannerPresence>;
  readTranscript: (path: string) => string | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface WatchPolicy {
  noFileAfterMinutes: number;
  pollSeconds: number;
}

export type WatchOutcome =
  | { kind: "wrote"; name: string }
  | { kind: "exited" | "timeout"; transcriptPath?: string; apiError?: ApiError };

/** Polls until the planner writes a review newer than its spawn, exits without one, or the deadline passes. */
export async function watchForReview(policy: WatchPolicy, ports: WatchPorts, spawnedAt: number): Promise<WatchOutcome> {
  const deadline = spawnedAt + policy.noFileAfterMinutes * 60_000;
  let transcriptPath: string | undefined;
  for (;;) {
    const written = newReview(ports.listReviews(), spawnedAt);
    if (written) return { kind: "wrote", name: written };
    const presence = await ports.presence();
    transcriptPath = presence.transcriptPath ?? transcriptPath;
    const late = newReview(ports.listReviews(), spawnedAt);
    if (late) return { kind: "wrote", name: late };
    if (presence.state === "gone") return failed("exited", ports, transcriptPath);
    if (ports.now() >= deadline) return failed("timeout", ports, transcriptPath);
    await ports.sleep(Math.min(policy.pollSeconds * 1000, Math.max(deadline - ports.now(), 0)));
  }
}

function newReview(files: readonly ReviewFile[], spawnedAt: number): string | undefined {
  return files.filter((file) => file.name.endsWith(".md") && file.mtimeMs > spawnedAt).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name;
}

function failed(kind: "exited" | "timeout", ports: WatchPorts, transcriptPath: string | undefined): WatchOutcome {
  if (transcriptPath === undefined) return { kind };
  const apiError = lastApiError(ports.readTranscript(transcriptPath) ?? "");
  return { kind, transcriptPath, ...(apiError && { apiError }) };
}

const ApiErrorLine = z.object({
  isApiErrorMessage: z.literal(true),
  apiError: z.string().optional(),
  apiErrorParams: z.object({ rate_limit_info: z.object({ resetsAt: z.number().optional() }).optional() }).optional(),
  message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).optional(),
});

/** The newest transcript line flagged `isApiErrorMessage`, read as its text, error code and reset time. */
export function lastApiError(transcript: string): ApiError | undefined {
  const lines = transcript.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = ApiErrorLine.safeParse(parseJson(lines[index]!));
    if (!parsed.success) continue;
    const { apiError, apiErrorParams, message } = parsed.data;
    const text = message?.content.find((part) => part.type === "text")?.text ?? apiError ?? "API error";
    const resetsAt = apiErrorParams?.rate_limit_info?.resetsAt;
    return { text, ...(apiError !== undefined && { apiError }), ...(resetsAt !== undefined && { resetsAt }) };
  }
  return undefined;
}

function parseJson(line: string): unknown {
  if (!line.includes("isApiErrorMessage")) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
