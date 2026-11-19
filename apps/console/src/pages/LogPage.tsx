import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, Card, CardContent, EmptyState, HStack, Link, Section, SectionContent, SectionHeader, Typography, VStack } from "@titan-design/react-ui";
import type { LogRow } from "../../server/log-rows.js";
import { useQuery, type ServedCommands } from "../data/rpc.js";
import { parseRoute, open } from "../router.js";
import { Spinner } from "../shell/Loading.js";
import { OverruleTap } from "./LogOverrule.js";
import { LogPolicyHeader } from "./LogPolicy.js";
import { logTime } from "./log-format.js";
import { PHONE_TAP_LINK } from "./phone.js";

type LogView = ServedCommands["log.list"]["result"];

const APPROVAL_LABEL: Record<LogRow["approval"], { text: string; color: "info" | "warning" | "success" | "primary" | "secondary" | "default" }> = {
  owner: { text: "you approved", color: "primary" },
  reviewer: { text: "reviewer MERGE", color: "info" },
  plan: { text: "plan approval", color: "secondary" },
  "auto-by-rec": { text: "auto-by-rec", color: "success" },
  shadow: { text: "shadow: would have gone by rec", color: "warning" },
  unrecorded: { text: "approval not recorded", color: "default" },
};

function daysFrom(query: string | undefined): number | undefined {
  const days = Number(new URLSearchParams(query ?? "").get("days"));
  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : undefined;
}

/**
 * Decisions and ships (TP-6775): every merged PR and every auto-by-rec decision, newest first by day, with how each was
 * approved, the recommendation and its rationale, and the way to reverse it. The by-rec policy and its exclusion floor
 * head the page. A live round or deposit answer takes the Overrule tap (TP-6778); the visual rows' frames come with TP-6777.
 */
export function LogPage({ query }: { query?: string }): ReactNode {
  const days = daysFrom(query);
  const log = useQuery("log.list", days === undefined ? {} : { days });
  if (log.status === "loading") return <Spinner size="sm" label="Loading the log" />;
  if (log.data === undefined) return <Alert status="error" message={`Could not load the log: ${log.error.message}`} />;
  return <LogBody view={log.data} />;
}

function LogBody({ view }: { view: LogView }): ReactNode {
  return (
    <VStack gap={6}>
      <LogPolicyHeader header={view.header} />
      {view.gaps.map((gap) => (
        <Alert key={gap} status="warning" message={gap} testID="log-gap" />
      ))}
      <Typography variant="body2" color="secondary" className="break-words" testID="log-digest">
        {view.digest}
      </Typography>
      {view.days.length === 0 ? (
        <EmptyState title="Nothing shipped or decided" description="No PR merged and no auto-by-rec row was written in this window." />
      ) : (
        view.days.map((day) => (
          <Section key={day.date} testID={`log-day-${day.date}`}>
            <SectionHeader title={day.date} subtitle={`${day.rows.length} ${day.rows.length === 1 ? "entry" : "entries"}`} />
            <SectionContent>
              <VStack gap={3}>
                {day.rows.map((row) => (
                  <LogRowCard key={row.key} row={row} />
                ))}
              </VStack>
            </SectionContent>
          </Section>
        ))
      )}
    </VStack>
  );
}

function RowTitle({ row }: { row: LogRow }): ReactNode {
  const external = row.href.startsWith("https://");
  return (
    <Link
      color="primary"
      href={external ? row.href : undefined}
      isExternal={external}
      onPress={external ? undefined : () => open(parseRoute(row.href))}
      className={`${PHONE_TAP_LINK} break-words`}
      testID={`log-link-${row.key}`}
    >
      {row.title}
    </Link>
  );
}

function LogRowCard({ row }: { row: LogRow }): ReactNode {
  return (
    <Card variant="outline" testID={`log-row-${row.key}`}>
      <CardContent>
        <VStack gap={2} className="min-w-0">
          <RowTitle row={row} />
          <RowBadges row={row} />
          <Recommendation row={row} />
          <Overruled row={row} />
          <Typography variant="caption" color="secondary" className="break-words">
            {[row.openedAt === undefined ? undefined : `Opened ${logTime(row.openedAt)}`, `Resolved ${logTime(row.resolvedAt)}`, `by ${row.resolver}`].filter(Boolean).join(" · ")}
          </Typography>
          {row.visual ? <FramesSlot row={row} /> : null}
          <Reverse row={row} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function RowBadges({ row }: { row: LogRow }): ReactNode {
  const approval = APPROVAL_LABEL[row.approval];
  return (
    <HStack gap={2} align="center" wrap>
      <Badge variant="subtle" size="sm" color={row.kind === "ship" ? "primary" : "secondary"}>
        <BadgeText>{row.kind === "ship" ? "ship" : row.source}</BadgeText>
      </Badge>
      <Badge variant="subtle" size="sm" color={approval.color} testID={`log-approval-${row.key}`}>
        <BadgeText>{approval.text}</BadgeText>
      </Badge>
      {row.shadow && row.approval !== "shadow" ? (
        <Badge variant="outline" size="sm" color="warning" testID={`log-shadow-${row.key}`}>
          <BadgeText>shadow: by-rec would have merged it</BadgeText>
        </Badge>
      ) : null}
      {row.rule !== undefined ? <Typography variant="caption" color="secondary">{row.rule}</Typography> : null}
    </HStack>
  );
}

function Recommendation({ row }: { row: LogRow }): ReactNode {
  if (row.recommendation === undefined) return null;
  const { answer, by, rationale } = row.recommendation;
  return (
    <VStack gap={1} className="min-w-0">
      <Typography variant="body2" className="break-words">{`Recommended: ${answer}, by ${by}`}</Typography>
      {rationale === undefined ? null : (
        <Typography variant="body2" color="secondary" className="break-words" testID={`log-rationale-${row.key}`}>
          {rationale}
        </Typography>
      )}
    </VStack>
  );
}

function Overruled({ row }: { row: LogRow }): ReactNode {
  if (row.overruled === undefined) return null;
  const { from, to, at } = row.overruled;
  return (
    <Typography variant="body2" className="break-words" testID={`log-overruled-picks-${row.key}`}>
      {`Overruled ${logTime(at)}: auto-by-rec picked ${from}; you picked ${to}.`}
    </Typography>
  );
}

/** Slice G (TP-6777) fills this with the visual gate's before and after frames. */
function FramesSlot({ row }: { row: LogRow }): ReactNode {
  return (
    <div data-testid={`log-frames-${row.key}`} className="rounded border border-dashed p-2">
      <Typography variant="caption" color="secondary">
        Visual change: before and after frames are added by TP-6777.
      </Typography>
    </div>
  );
}

function Reverse({ row }: { row: LogRow }): ReactNode {
  const { reverse } = row;
  if (reverse.kind === "revert") {
    return (
      <Link color="primary" href={reverse.href} isExternal className={PHONE_TAP_LINK} testID={`log-revert-${row.key}`}>
        Revert: open the PR, then its Revert button
      </Link>
    );
  }
  if (reverse.kind === "overrule") return <OverruleTap rowKey={row.key} reverse={reverse} />;
  return <Typography variant="caption" color="secondary">{`Nothing to reverse: ${reverse.reason}.`}</Typography>;
}
