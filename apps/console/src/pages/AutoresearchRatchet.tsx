import type { ReactNode } from "react";
import { HStack, Typography } from "@titan-design/react-ui";
import type { ArRound } from "../../server/autoresearch-view.js";
import { ExternalLink } from "./SessionFormat.js";
import { commitUrl, shortSha } from "./autoresearch-format.js";

type Move = NonNullable<ArRound["ratchet"]>;

/** Design §2.4: a ratchet move as commit links when the target names its repository, else as the bare `from → to`. */
export function RatchetMove({ repo, move }: { repo: string | undefined; move: Move }): ReactNode {
  const from = commitUrl(repo, move.from);
  const to = commitUrl(repo, move.to);
  if (from === undefined || to === undefined) return `${shortSha(move.from)} → ${shortSha(move.to)}`;
  return (
    <HStack gap={1} testID="autoresearch-ratchet-links">
      <ExternalLink url={from}>{shortSha(move.from)}</ExternalLink>
      <Typography variant="body2">→</Typography>
      <ExternalLink url={to}>{shortSha(move.to)}</ExternalLink>
    </HStack>
  );
}
