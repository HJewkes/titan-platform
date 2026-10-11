import type { ReactNode } from "react";
import { HStack, Link, Typography } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { refToRoute } from "../refs.js";
import { open } from "../router.js";

type ListResult = ConsoleCommands["sessions.list"]["result"];
export type SessionRow = ListResult["sessions"][number];
type DegradedReason = NonNullable<ListResult["degraded"]>["reason"];

/** How warning copy names each degraded reason, as "the session graph is <state>". */
export const GRAPH_STATE: Record<DegradedReason, string> = {
  "graph-missing": "missing",
  "graph-not-migrated": "older than this console",
  "graph-unreadable": "unreadable",
  "transcript-missing": "missing this session's transcript",
};

export function NoneText(): ReactNode {
  return (
    <Typography variant="caption" color="secondary">
      none
    </Typography>
  );
}

/** `task:`, `agent:` and `pr:` refs, each sent wherever `refToRoute` says; a ref it cannot place stays text. */
export function RefLinks({ refs }: { refs: readonly string[] }): ReactNode {
  if (refs.length === 0) return <NoneText />;
  return (
    <HStack gap={2} wrap>
      {refs.map((ref) => (
        <RefLink key={ref} refText={ref} />
      ))}
    </HStack>
  );
}

function RefLink({ refText }: { refText: string }): ReactNode {
  const label = refText.slice(refText.indexOf(":") + 1);
  const target = refToRoute(refText);
  if (target?.kind === "route") {
    const { route } = target;
    return (
      <Link color="primary" onPress={() => open(route)}>
        {label}
      </Link>
    );
  }
  if (target?.kind === "github") return <ExternalLink url={target.url}>{label}</ExternalLink>;
  return <Typography variant="body2">{label}</Typography>;
}

/** react-ui 0.20's `Link` renders no anchor and ignores `href` until TD-P1, so the press opens the URL itself. */
export function ExternalLink({ url, children }: { url: string; children: string }): ReactNode {
  return (
    <Link color="primary" href={url} isExternal onPress={() => window.open(url, "_blank", "noopener")}>
      {children}
    </Link>
  );
}

export function spanMs(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const span = Date.parse(end) - Date.parse(start);
  return Number.isFinite(span) && span >= 0 ? span : null;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "unknown";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const TOKENS = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatTokens(count: number): string {
  return TOKENS.format(count);
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Prompt and output tokens across every model, cache reads and writes included. */
export function usageTokens(row: SessionRow): number {
  return row.usage.reduce((sum, model) => sum + model.inputTokens + model.cacheReadTokens + model.cacheCreationTokens + model.outputTokens, 0);
}
