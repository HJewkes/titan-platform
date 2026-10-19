import type { ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";

type Prepared = ConsoleCommands["inbox.prepare"]["result"];
export type InboxReady = Extract<Prepared, { status: "ready" }>;
/** A gate or hold read-back, g10 included; only a gate's carries `gateId`, only a g10 hold's carries `confirmLabel`. */
type RepoReadBack = Extract<InboxReady["readBack"], { repo: string }>;

const secondsSince = (at: string, now: number = Date.now()): number => Math.max(0, Math.round((now - Date.parse(at)) / 1000));

/** What an inbox tap will do, as `inbox.prepare` read it back: a PR's live head and gate, or an agent's question. */
export function InboxReadBack({ prepared }: { prepared: InboxReady }): ReactNode {
  const { readBack } = prepared;
  return (
    <VStack gap={2} testID="inbox-readback">
      {"confirmLabel" in readBack ? <Typography variant="subtitle2" testID="inbox-readback-label">{readBack.confirmLabel}</Typography> : null}
      <Typography variant="subtitle1">{readBack.effect}</Typography>
      {"repo" in readBack ? (
        <PrFacts readBack={readBack} readAt={prepared.readAt} />
      ) : (
        <>
          <Typography variant="body2">{readBack.title}</Typography>
          <Typography variant="body2">{readBack.question}</Typography>
        </>
      )}
    </VStack>
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
    </>
  );
}
