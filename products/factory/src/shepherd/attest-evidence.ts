import type { AgentIdentity } from "@titan-design/authority";
import type { GitHubPort } from "@titan-design/github";
import type { AuthorityLine, ReviewerAgent } from "@titan-design/review-panel";
import { judgeAttestations } from "../registry/attest.js";
import { readClaims } from "./attest-read.js";
import type { DeploySkew } from "./attest-skew.js";
import { errorClass } from "./error-class.js";
import { G10_ADVERSARY_CLASS, holdClassOf } from "./g10-release.js";
import { independentOfRun, type Lineage } from "./lineage.js";
import { separateLineages } from "./reviewer-lineage.js";
import { clearReviewWait, noteReviewWait, transient, untilRosterRead, type BrokerDownTiming, type RosterNote } from "./review-wait.js";
import type { Registration, ShepherdStoreRef } from "./store.js";

/**
 * The `Attests:` tokens of the accepted MERGE and, on a panel, the adversary member's own MERGE and whether the plan had one.
 * `authority` is that MERGE's `Authority:` line (TP-5407); absent where the member wrote none or was recorded before it was asked.
 */
export interface AttestVerdicts {
  attests: string[];
  adversary?: { reviewer: AgentIdentity; head: string; attests: string[]; authority?: AuthorityLine };
  adversaryPlanned?: true;
}

/** Whether the run owes an adversary MERGE: the panel planned one, or the registration's hold is a g10-adversary hold. */
export function adversaryRequired(attest: AttestVerdicts | undefined, holdReason: string | null | undefined): boolean {
  return attest?.adversaryPlanned === true || holdClassOf(holdReason) === G10_ADVERSARY_CLASS;
}

export interface AttestReaders {
  store: ShepherdStoreRef;
  /** Absent means no roster can name a meeter, so every claimed row reads unread. */
  roster?: () => Promise<readonly ReviewerAgent[]>;
  /** Absent means the roster stands for the lineage, as the hold satisfier reads it. */
  lineage?: () => Promise<Lineage>;
  /** Absent reads no skew, as a build with no deploy pacer behind it; serve wires `deploySkew()`. */
  deploySkew?: DeploySkew;
}

interface AttestSubject {
  runId: string;
  repo: string;
  head: string;
  resolver: AgentIdentity;
  verdict: { head: string };
  attest?: AttestVerdicts;
}

/** `deploySkew` names why the read waits for a deploy: the running build may read the claims as main no longer lays them out. */
export type AttestJudgment = ReturnType<typeof judgeAttestations> | { unread: string } | { deploySkew: string };

interface RunFacts {
  registration: Registration;
  authors: { agentId: string; name: string }[];
  roster: readonly ReviewerAgent[];
  lineage: Lineage;
}

/** A broker failure that may clear with time, or a retry budget such a failure ran out: the run's infrastructure failed, not the head. */
const brokerFailure = (error: unknown): boolean => transient(error) || (error instanceof Error && transient(error.cause));

/**
 * What the judge needs beyond the claims; a store, roster or lineage that cannot be read names why. A broker failure is
 * thrown instead, so the evidence step fails the run rather than gating the owner on infrastructure (decision 515).
 */
async function runFacts(readers: AttestReaders, runId: string): Promise<RunFacts | { unread: string }> {
  if (!readers.roster) return { unread: "no roster reader is wired to name a meeter" };
  try {
    const store = readers.store.get();
    const registration = store.byRun(runId);
    if (!registration) return { unread: "the run's registration is unreadable" };
    const roster = await readers.roster();
    const lineage = readers.lineage ? await readers.lineage() : { rows: roster, complete: true };
    return { registration, authors: store.authorsOf(runId), roster, lineage };
  } catch (error) {
    if (brokerFailure(error)) throw error;
    return { unread: `the meeters' facts are unreadable: ${errorClass(error)}` };
  }
}

/** Each round of a roster or lineage read spends the waits the reviewer dispatch spends on its own roster read. */
interface RosterPatience {
  timing: BrokerDownTiming;
  budgetMs: number;
  signal: AbortSignal;
}

/** The step already holds a MERGE, so a roster unread for a whole round is read again rather than failing the run (TP-5086). */
const patiently = <T>(read: () => Promise<T>, { timing, budgetMs, signal }: RosterPatience, note?: RosterNote) => () => untilRosterRead(timing, signal, budgetMs, read, note);

/** The run's pull request, or undefined when the store is unbound or the run has none; a note is best effort and must not fail the step. */
function prOf(store: ShepherdStoreRef, runId: string): number | undefined {
  try {
    return store.get().byRun(runId)?.pr ?? undefined;
  } catch {
    return undefined;
  }
}

/** A run held at the evidence step shows its roster wait in status, next to the other review waits. */
function rosterNote(store: ShepherdStoreRef, subject: AttestSubject): RosterNote {
  return (text) => {
    const pr = prOf(store, subject.runId);
    if (pr === undefined) return;
    if (text === undefined) clearReviewWait(subject.repo, pr);
    else noteReviewWait(subject.repo, pr, `waiting for the reviewer roster at the merge evidence step: ${text}`);
  };
}

export interface AttestSkewWiring {
  /** Main's registry commits the running build lacks; absent reads no skew, so the attest step judges at once (TP-4752). */
  deploySkew?: DeploySkew;
}

interface JudgeWiring extends AttestSkewWiring {
  dispatch?: { roster(): Promise<readonly ReviewerAgent[]> };
  lineage?: () => Promise<Lineage>;
}

/** The evidence step's judge, naming meeters from the dispatch's roster and the wired lineage, each read with `patience`. */
export function attestJudge(port: GitHubPort, store: ShepherdStoreRef, { dispatch, lineage, deploySkew }: JudgeWiring, patience: RosterPatience) {
  return (subject: AttestSubject, baseRef: string) => {
    const note = rosterNote(store, subject);
    const reads = { ...(dispatch && { roster: patiently(() => dispatch.roster(), patience, note) }), ...(lineage && { lineage: patiently(lineage, patience, note) }) };
    return attestAtHead(port, { store, ...reads, ...(deploySkew && { deploySkew }) }, subject, baseRef);
  };
}

/**
 * Undefined when the head claims no row; the meeters are named only from the roster, never from the reviewer's text. A
 * claim or an unread file is judged only once the running build holds main's registry commits, since a build behind them
 * may read main's layout wrong and name every row unmet (TP-4752).
 */
export async function attestAtHead(port: GitHubPort, readers: AttestReaders, subject: AttestSubject, baseRef: string): Promise<AttestJudgment | undefined> {
  const read = await readClaims(port, { repo: subject.repo, base: baseRef, head: subject.head });
  if (!("unread" in read) && read.claimed.length === 0) return undefined;
  const skew = await readers.deploySkew?.(subject.repo).catch((error: unknown) => `deploy skew unread: ${errorClass(error)}`);
  if (skew !== undefined) return { deploySkew: skew };
  if ("unread" in read) return read;
  const facts = await runFacts(readers, subject.runId);
  if ("unread" in facts) return facts;
  const { registration, authors, roster, lineage } = facts;
  const rowOf = (id: AgentIdentity) => roster.find((agent) => agent.agentId === id.agentId && agent.sessionId === id.sessionId);
  const adversary = subject.attest?.adversary;
  return judgeAttestations({
    claimed: read.claimed,
    head: subject.head,
    correctness: { reviewer: rowOf(subject.resolver), attests: subject.attest?.attests ?? [], head: subject.verdict.head, carried: subject.verdict.head !== subject.head },
    ...(adversary && { adversary: { reviewer: rowOf(adversary.reviewer), attests: adversary.attests, head: adversary.head } }),
    adversaryRequired: adversaryRequired(subject.attest, registration.holdReason),
    independent: (agent) => independentOfRun(agent, registration, lineage, authors),
    separate: (a, b) => separateLineages(a, b, lineage.rows),
  });
}
