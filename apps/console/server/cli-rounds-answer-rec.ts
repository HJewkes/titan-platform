/**
 * `titan-console rounds answer-rec <id> [--json]` (TP-4054): tp-operator relays the owner's text "rec" reply to a
 * nudge. It runs `rounds.answer-rec`'s own path in-process, bound to the sha256 of the round.json on disk now, and
 * through the daemon's own submit pipeline, so the decision log and the seat notice hear it as they hear the tap. It
 * is a local verb like `rounds withdraw`: the RPC command answers only a LAN session cookie, which a same-host process
 * never holds.
 */
import path from "node:path";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { runVerb } from "./cli-rounds.js";
import type { ConsoleConfig } from "./config.js";
import { answerWithRecommendations } from "./round-rec-answer.js";
import { readManifest, roundDirExists } from "./rounds.js";
import { submitPipeline, type SubmitPipeline } from "./rounds-submit.js";
import { createSources } from "./upstreams.js";

interface AnswerRecArgs {
  id: string;
  json: boolean;
}

interface AnswerRecReport {
  id: string;
  answered: number;
  path: string;
  sha256: string;
}

/** `rounds answer-rec <id> [--json]`, the flag on either side; null for anything else. */
export function roundsAnswerRecArgs(argv: readonly string[]): AnswerRecArgs | null {
  if (argv[0] !== "rounds" || argv[1] !== "answer-rec") return null;
  const rest = argv.slice(2);
  const ids = rest.filter((arg) => arg !== "--json");
  const [id] = ids;
  if (id === undefined || ids.length !== 1 || rest.length > 2 || id.startsWith("--")) return null;
  return { id, json: rest.length === 2 };
}

/** The sha comes from the reader `rounds.list` uses, so it is the one the inbox nudge carried for this round.json. */
async function answerRecRound(roundsDir: string, id: string, submit: SubmitPipeline): Promise<AnswerRecReport> {
  if (!(await roundDirExists(roundsDir, id))) throw failure(`No round named "${id}"`, EXIT.NOINPUT);
  const { parsed } = await readManifest(path.join(roundsDir, id));
  if (!parsed.ok) throw failure(`round.json is not a valid round: ${parsed.reason}`, EXIT.DATAERR);
  const { answered, result } = await answerWithRecommendations(roundsDir, submit, { id, manifestSha256: parsed.sha256 });
  if (result.status !== "submitted") throw failure("refused: sent; this round already has its feedback.json", EXIT.DATAERR);
  return { id, answered, path: result.path, sha256: result.sha256 };
}

function daemonPipeline(config: ConsoleConfig): SubmitPipeline {
  const { rounds, decisionLog, listeners, inbox } = createSources(config);
  return submitPipeline(rounds, decisionLog, listeners, inbox.dir);
}

const reportLine = ({ id, answered }: AnswerRecReport): string => `${id}: answered ${answered} question${answered === 1 ? "" : "s"}; feedback written`;

export async function answerRecCli(config: ConsoleConfig, { id, json }: AnswerRecArgs, submit: SubmitPipeline = daemonPipeline(config)): Promise<void> {
  await runVerb(
    () => answerRecRound(config.roundsDir, id, submit),
    (report) => (json ? JSON.stringify(report) : reportLine(report)),
  );
}
