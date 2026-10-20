import type { ReactNode } from "react";
import { Alert, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { GateStrip as Strip, UnmetGate } from "../../server/gate-strip.js";
import { useQuery } from "../data/rpc.js";

const sha7 = (sha: string): string => sha.slice(0, 7);

const isUnknown = (gate: UnmetGate): boolean => gate.key.startsWith("unknown:");

/**
 * Decision 489: every approval surface shows the gates besides the owner's own, at the PR's live head, so a tap is never
 * read as clearing them. Read only; an unknown row is shown as an error because it never counts as a pass.
 */
export function GateStripView({ strip, boundHead }: { strip: Strip; boundHead?: string }): ReactNode {
  const moved = boundHead !== undefined && boundHead !== strip.head;
  return (
    <VStack gap={1} testID={`gate-strip-${strip.repo}#${strip.pr}`}>
      <Typography variant="caption" color="secondary">{headline(strip)}</Typography>
      {moved ? <Alert status="warning" size="compact" message={`The PR moved to ${sha7(strip.head)}; this asks about ${sha7(boundHead)}`} /> : null}
      <UnmetRows unmet={strip.unmet} />
      <Typography variant="caption" color="secondary">{ciLine(strip)}</Typography>
      {strip.verdicts.length > 0 ? <Typography variant="caption" color="secondary">{verdictLine(strip)}</Typography> : null}
    </VStack>
  );
}

const headline = (strip: Strip): string => {
  const count = strip.unmet.length === 0 ? "nothing else waits" : `${strip.unmet.length} unmet besides your approval`;
  return `Gates at ${sha7(strip.head)}: ${count}`;
};

function UnmetRows({ unmet }: { unmet: readonly UnmetGate[] }): ReactNode {
  if (unmet.length === 0) return null;
  return (
    <VStack gap={0}>
      {unmet.map((gate) => (
        <Typography key={gate.key} variant="caption" color={isUnknown(gate) ? "error" : "warning"} testID={`gate-unmet-${gate.key}`}>
          {`• ${gate.label}`}
        </Typography>
      ))}
    </VStack>
  );
}

function ciLine({ ci }: Strip): string {
  const factory = ci.factory === null ? "no factory reading" : `factory ${ci.factory.verdict}${ci.factory.atHead ? "" : ` at older head ${sha7(ci.factory.headSha)}`}`;
  const counts = (["pass", "fail", "pending"] as const).map((state) => [state, ci.checks.filter((check) => check.state === state).length] as const).filter(([, n]) => n > 0);
  const checks = counts.length === 0 ? "no checks read" : counts.map(([state, n]) => `${n} ${state}`).join(", ");
  return `CI: ${factory}; checks ${checks}`;
}

function verdictLine({ verdicts }: Strip): string {
  const each = verdicts.map((verdict) => `${verdict.reviewer ?? verdict.stepId} ${verdict.verdict}${verdict.atHead ? "" : ` at older head${verdict.headSha === null ? "" : ` ${sha7(verdict.headSha)}`}, not counted`}`);
  return `Reviewers: ${each.join("; ")}`;
}

/** A round question bound to a merge reads its strip live when the page opens. */
export function MergeGates({ repo, pr, headSha }: { repo: string; pr: number; headSha: string }): ReactNode {
  const read = useQuery("gates.strip", { repo, pr });
  if (read.status === "loading") return <Spinner size="sm" label="Reading the PR's other gates" />;
  if (read.data === undefined) return <Alert status="error" size="compact" message={`Gates unknown: ${read.error.message}`} testID="gate-strip-unknown" />;
  if (read.data.status === "none") return <Alert status="warning" size="compact" message={`Gates unknown: ${read.data.reason}`} testID="gate-strip-unknown" />;
  return <GateStripView strip={read.data.strip} boundHead={headSha} />;
}
