import { type ReactNode } from "react";
import { Badge, Typography } from "@titan-design/react-ui";
import type { ShipLineage } from "../../server/ship-lineage.js";

type KnownLineage = Extract<ShipLineage, { known: true }>;
type LineageState = "merged" | "stale" | "fresh" | "unknown";

const sha7 = (sha: string): string => sha.slice(0, 7);

/** Stale only when the proven head is known to lack base commits; a moved or uncompared head is not called fresh. */
function stateOf(lineage: KnownLineage): LineageState {
  if (lineage.merged) return "merged";
  if (lineage.behind === null) return "unknown";
  return lineage.behind > 0 ? "stale" : "fresh";
}

function behindText(lineage: KnownLineage): string | null {
  if (lineage.merged) return null;
  if (lineage.behind === null) return "behind unknown";
  return lineage.behind === 0 ? "up to date" : `${lineage.behind} behind`;
}

const Facts = ({ parts }: { parts: string[] }): ReactNode => <Typography variant="caption" color="secondary">{parts.join(" · ")}</Typography>;

/** The three facts openrig prints before a Ship: proven-at sha, merged or UNMERGED, the base tip; freshness only beside them. */
export function ShipLineageLine({ lineage }: { lineage: ShipLineage | undefined }): ReactNode {
  if (lineage === undefined || !lineage.known) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="ship-lineage" data-state="unknown">
        <Badge color="warning" size="sm">lineage unknown</Badge>
        {lineage?.known === false ? <Typography variant="caption" color="secondary">{lineage.reason}</Typography> : null}
      </div>
    );
  }
  const state = stateOf(lineage);
  const behind = behindText(lineage);
  const moved = lineage.headSha === lineage.provenSha ? [] : [`head moved to ${sha7(lineage.headSha)}`];
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="ship-lineage" data-state={state}>
      <Facts parts={[`proven at ${sha7(lineage.provenSha)}`]} />
      <Badge color={lineage.merged ? "success" : "info"} size="sm">{lineage.merged ? `merged${lineage.mergeSha ? ` ${sha7(lineage.mergeSha)}` : ""}` : "UNMERGED"}</Badge>
      <Facts parts={[...moved, `${lineage.baseRef} ${sha7(lineage.baseSha)}`]} />
      {behind === null ? null : state === "stale" ? <Badge color="warning" size="sm">{behind}</Badge> : <Facts parts={[behind]} />}
    </div>
  );
}
