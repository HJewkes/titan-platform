import type { ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";

type Prepared = ConsoleCommands["inbox.prepare"]["result"];
export type InboxReady = Extract<Prepared, { status: "ready" }>;
/** A gate, hold or op read-back, g10 included; only a gate's carries `gateId`, only a g10 hold's `confirmLabel`, only an op's `proposal`. */
type RepoReadBack = Extract<InboxReady["readBack"], { repo: string }>;
type OpReadBack = Extract<RepoReadBack, { proposal: string }>;
/** A deploy-pause-clear's read-back: the failure pause it clears, and no PR. */
type PauseReadBack = Extract<InboxReady["readBack"], { pausedAt: string }>;

const secondsSince = (at: string, now: number = Date.now()): number => Math.max(0, Math.round((now - Date.parse(at)) / 1000));

/** What an inbox tap will do, as `inbox.prepare` read it back: a PR's live head and gate, a deploy pause, or an agent's question. */
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
  if ("pausedAt" in readBack) return <PauseFacts readBack={readBack} readAt={prepared.readAt} />;
  if ("kind" in readBack) return <Typography variant="mono">{readBack.kind === "permission" ? `${readBack.tool}: ${readBack.inputPreview}` : `To ${readBack.to}: ${readBack.text}`}</Typography>;
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

/** The depositing agent's words, labelled as theirs and never as the factory's facts. */
function Proposal({ readBack }: { readBack: OpReadBack | PauseReadBack }): ReactNode {
  return <Typography variant="caption" color="secondary" testID="inbox-readback-proposal">{`Proposed by ${readBack.proposedBy}: ${readBack.proposal}`}</Typography>;
}
