import type { ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { EvidenceFacts } from "./InboxEvidence.js";

type Prepared = ConsoleCommands["inbox.prepare"]["result"];
export type InboxReady = Extract<Prepared, { status: "ready" }>;
/** A gate, hold or op read-back, g10 included; only a gate's carries `gateId`, only a g10 hold's `confirmLabel`, only an op's `proposal`. */
type RepoReadBack = Extract<InboxReady["readBack"], { repo: string }>;
type OpReadBack = Extract<RepoReadBack, { proposal: string }>;
type AgentReadBack = Extract<InboxReady["readBack"], { agent: string }>;
/** A deploy-pause-clear's read-back: the failure pause it clears, and no PR. */
type PauseReadBack = Extract<InboxReady["readBack"], { pausedAt: string }>;
/** An agent's permission prompt or endorsement, read back from the broker's own queue row. */
type PermissionReadBack = Extract<InboxReady["readBack"], { kind: "permission" }>;
type EndorseReadBack = Extract<InboxReady["readBack"], { kind: "endorse" }>;

const secondsSince = (at: string, now: number = Date.now()): number => Math.max(0, Math.round((now - Date.parse(at)) / 1000));

/** What an inbox tap will do, as `inbox.prepare` read it back: a PR's live head and gate, an agent to retire, a deploy pause, or an agent's question. */
export function InboxReadBack({ prepared }: { prepared: InboxReady }): ReactNode {
  const { readBack } = prepared;
  return (
    <VStack gap={2} testID="inbox-readback">
      {"confirmLabel" in readBack ? <Typography variant="subtitle2" testID="inbox-readback-label">{readBack.confirmLabel}</Typography> : null}
      <Typography variant="subtitle1">{readBack.effect}</Typography>
      <ReadBackFacts prepared={prepared} />
    </VStack>
  );
}

function ReadBackFacts({ prepared }: { prepared: InboxReady }): ReactNode {
  const { readBack } = prepared;
  if ("repo" in readBack) return <PrFacts readBack={readBack} readAt={prepared.readAt} />;
  if ("agent" in readBack) return <AgentFacts readBack={readBack} readAt={prepared.readAt} />;
  if ("pausedAt" in readBack) return <PauseFacts readBack={readBack} readAt={prepared.readAt} />;
  if ("kind" in readBack) return readBack.kind === "permission" ? <PermissionFacts readBack={readBack} /> : <EndorseFacts readBack={readBack} />;
  return (
    <>
      <Typography variant="body2">{readBack.title}</Typography>
      <Typography variant="body2">{readBack.question}</Typography>
    </>
  );
}

/** The pause as the factory reads it now, the hold it leaves, then the depositing agent's words, labelled as theirs. */
function PauseFacts({ readBack, readAt }: { readBack: PauseReadBack; readAt: string }): ReactNode {
  return (
    <>
      <Typography variant="body2">{`Paused: ${readBack.why}`}</Typography>
      <Typography variant="mono">{`target ${readBack.target.slice(0, 7)}, rollback ${readBack.rollback}, read ${secondsSince(readAt)} s ago`}</Typography>
      {readBack.manualHold === undefined ? null : <Typography variant="caption" color="secondary">{`Manual hold stays: ${readBack.manualHold}`}</Typography>}
      <Typography variant="caption" color="secondary">{`Authority ${readBack.authority}`}</Typography>
      <Proposal readBack={readBack} />
    </>
  );
}

function PrFacts({ readBack, readAt }: { readBack: RepoReadBack; readAt: string }): ReactNode {
  const ref = `${readBack.repo}#${readBack.pr}`;
  return (
    <>
      <Typography variant="body2">{readBack.title.includes(ref) ? readBack.title : `${ref}: ${readBack.title}`}</Typography>
      <Typography variant="mono">{`head ${readBack.headSha.slice(0, 7)}, matches the live head, read ${secondsSince(readAt)} s ago`}</Typography>
      {"gateId" in readBack && readBack.gateId !== undefined ? <Typography variant="caption" color="secondary">{`Gate ${readBack.gateId}`}</Typography> : null}
      {readBack.hold === undefined ? null : <Typography variant="caption" color="secondary">{`Hold: ${readBack.hold.reason}`}</Typography>}
      {"evidence" in readBack && readBack.evidence !== undefined ? <EvidenceFacts evidence={readBack.evidence} /> : null}
      {"proposal" in readBack ? <OpFacts readBack={readBack} /> : null}
    </>
  );
}

/** An op's live PR state from the factory, then the depositing agent's words, labelled as theirs. */
function OpFacts({ readBack }: { readBack: OpReadBack }): ReactNode {
  const behind = readBack.behind ? ", behind its base" : "";
  return (
    <>
      <Typography variant="caption" color="secondary">{`Into ${readBack.base}${behind}; GitHub reads it ${readBack.mergeableState}. Authority ${readBack.authority}`}</Typography>
      <Proposal readBack={readBack} />
    </>
  );
}

/** A retire-agent op's agent as agent-chat's roster reads it now, then the depositing agent's words. */
export function AgentFacts({ readBack, readAt }: { readBack: AgentReadBack; readAt: string }): ReactNode {
  const spawnedBy = readBack.spawnedBy === null ? "" : `, spawned by ${readBack.spawnedBy}`;
  return (
    <>
      <Typography variant="body2">{`${readBack.agent} (id ${readBack.agentId.slice(0, 8)}), ${readBack.state}, profile ${readBack.profile}${spawnedBy}`}</Typography>
      <Typography variant="mono">{`cwd ${readBack.cwd}, read ${secondsSince(readAt)} s ago`}</Typography>
      <Typography variant="caption" color="secondary">{`Authority ${readBack.authority}`}</Typography>
      <Proposal readBack={readBack} />
    </>
  );
}

/** The tool and its input as the broker's row holds them; the description is the asking agent's own words. */
function PermissionFacts({ readBack }: { readBack: PermissionReadBack }): ReactNode {
  return (
    <>
      <Typography variant="body2" testID="inbox-readback-tool">{`Tool: ${readBack.tool}`}</Typography>
      <pre className="max-h-64 overflow-auto rounded bg-surface-raised p-2 font-mono text-sm" data-testid="inbox-readback-input">
        {readBack.inputPreview}
      </pre>
      <Typography variant="caption" color="secondary" testID="inbox-readback-description">{`${readBack.asker ?? "The agent"} says: ${readBack.description}`}</Typography>
    </>
  );
}

const EDGE_WHITESPACE = /^\s|\s$/;

/** The bytes Endorse delivers, whitespace kept, since the broker refuses any text but the stored one. */
function EndorseFacts({ readBack }: { readBack: EndorseReadBack }): ReactNode {
  return (
    <>
      <Typography variant="body2" testID="inbox-readback-recipient">{`To ${readBack.to}`}</Typography>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-raised p-2 font-mono text-sm" data-testid="inbox-readback-text">
        {readBack.text}
      </pre>
      {EDGE_WHITESPACE.test(readBack.text) ? <Typography variant="caption" color="secondary">Starts or ends with whitespace, delivered as is</Typography> : null}
    </>
  );
}

/** The depositing agent's words, labelled as theirs and never as the factory's facts. */
function Proposal({ readBack }: { readBack: OpReadBack | AgentReadBack | PauseReadBack }): ReactNode {
  return <Typography variant="caption" color="secondary" testID="inbox-readback-proposal">{`Proposed by ${readBack.proposedBy}: ${readBack.proposal}`}</Typography>;
}
