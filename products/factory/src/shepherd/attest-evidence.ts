import type { AgentIdentity } from "@titan-design/authority";
import type { GitHubPort } from "@titan-design/github";
import type { ReviewerAgent } from "@titan-design/review-panel";
import { judgeAttestations } from "../registry/attest.js";
import { readClaims } from "./attest-read.js";
import { errorClass } from "./error-class.js";
import { G10_ADVERSARY_CLASS, holdClassOf } from "./g10-release.js";
import { independentOfRun, type Lineage } from "./lineage.js";
import { separateLineages } from "./reviewer-lineage.js";
import type { Registration, ShepherdStoreRef } from "./store.js";

/** The `Attests:` tokens of the accepted MERGE and, on a panel, the adversary member's own MERGE and whether the plan had one. */
export interface AttestVerdicts {
  attests: string[];
  adversary?: { reviewer: AgentIdentity; head: string; attests: string[] };
  adversaryPlanned?: true;
}

export interface AttestReaders {
  store: ShepherdStoreRef;
  /** Absent means no roster can name a meeter, so every claimed row reads unread. */
  roster?: () => Promise<readonly ReviewerAgent[]>;
  /** Absent means the roster stands for the lineage, as the hold satisfier reads it. */
  lineage?: () => Promise<Lineage>;
}

interface AttestSubject {
  runId: string;
  repo: string;
  head: string;
  resolver: AgentIdentity;
  verdict: { head: string };
  attest?: AttestVerdicts;
}

export type AttestJudgment = ReturnType<typeof judgeAttestations> | { unread: string };

interface RunFacts {
  registration: Registration;
  authors: { agentId: string; name: string }[];
  roster: readonly ReviewerAgent[];
  lineage: Lineage;
}

/** What the judge needs beyond the claims; a store, roster or lineage that cannot be read names why. */
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
    return { unread: `the meeters' facts are unreadable: ${errorClass(error)}` };
  }
}

/** Undefined when the head claims no row; the meeters are named only from the roster, never from the reviewer's text. */
export async function attestAtHead(port: GitHubPort, readers: AttestReaders, subject: AttestSubject, baseRef: string): Promise<AttestJudgment | undefined> {
  const read = await readClaims(port, { repo: subject.repo, base: baseRef, head: subject.head });
  if ("unread" in read || read.claimed.length === 0) return "unread" in read ? read : undefined;
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
    adversaryRequired: subject.attest?.adversaryPlanned === true || holdClassOf(registration.holdReason) === G10_ADVERSARY_CLASS,
    independent: (agent) => independentOfRun(agent, registration, lineage, authors),
    separate: (a, b) => separateLineages(a, b, lineage.rows),
  });
}
