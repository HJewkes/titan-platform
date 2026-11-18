import type { ReactNode } from "react";
import { Alert, EmptyState, Link, Section, SectionContent, SectionHeader, Table, TableBody, TableCell, TableRow } from "@titan-design/react-ui";
import type { ScorecardTaskRow } from "../../server/scorecard-schema.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { Spinner } from "../shell/Loading.js";
import { Labelled } from "./ScorecardTasks.js";
import { hoursText, NOT_MEASURED, numberText, usdText } from "./scorecard-format.js";
import { PHONE_TAP_LINK } from "./phone.js";

const yesNo = (value: boolean | null): string => (value === null ? NOT_MEASURED : value ? "yes" : "no");

/** Each row: label, value, and the provenance key a labelled column is stored under. */
const FIELDS: readonly [string, (r: ScorecardTaskRow) => string, string?][] = [
  ["First dispatch", (r) => r.firstDispatchTs, "firstDispatchTs"],
  ["Dispatcher", (r) => r.dispatcher],
  ["Dispatch rule", (r) => r.dispatchRule ?? NOT_MEASURED],
  ["Class", (r) => r.classAtDispatch ?? NOT_MEASURED, "classAtDispatch"],
  ["Source", (r) => r.sourceAtDispatch ?? NOT_MEASURED, "sourceAtDispatch"],
  ["Serves", (r) => r.servesAtDispatch ?? NOT_MEASURED, "servesAtDispatch"],
  ["Rank", (r) => r.rankAtDispatch ?? NOT_MEASURED, "rankAtDispatch"],
  ["Age at dispatch", (r) => hoursText(r.ageAtDispatchH)],
  ["Rule percentile", (r) => numberText(r.ruleRankPct)],
  ["In the rule's top K", (r) => yesNo(r.inRuleTopk)],
  ["Merged", (r) => r.mergedAt ?? "no"],
  ["PRs", (r) => String(r.prs)],
  ["Fix rounds", (r) => String(r.fixRounds)],
  ["Review rounds", (r) => String(r.reviewRounds)],
  ["Reverted by", (r) => r.revertedBy ?? "none", "revertedBy"],
  ["Done reason", (r) => r.doneReason ?? NOT_MEASURED, "doneReason"],
  ["Follow-ups", (r) => numberText(r.followupsN), "followups"],
  ["Brief restates done-when", (r) => yesNo(r.briefHasDoneWhen), "briefHasDoneWhen"],
  ["Created to done", (r) => hoursText(r.leadCreatedDoneH)],
  ["Dispatch to merge", (r) => hoursText(r.leadDispatchMergeH)],
  ["Cost", (r) => usdText(r.usd), "usd"],
  ["Owner gates", (r) => `${r.ownerGates} (${r.ownerGateHours}h)`],
  ["Duplicate PRs", (r) => String(r.dupPrs)],
];

/** `<initiative>/<task>`; a task id holds no `/`, so the last one splits it. */
function taskRef(id: string): { initiative: string; taskId: string } | null {
  const cut = id.lastIndexOf("/");
  return cut <= 0 || cut === id.length - 1 ? null : { initiative: id.slice(0, cut), taskId: id.slice(cut + 1) };
}

export function ScorecardTaskPage({ id }: { id: string }): ReactNode {
  const ref = taskRef(id);
  if (ref === null) return <Alert status="error" message={`${id} names no scorecard task; expected <initiative>/<task id>`} />;
  return <TaskRowSection initiative={ref.initiative} taskId={ref.taskId} />;
}

function TaskRowSection({ initiative, taskId }: { initiative: string; taskId: string }): ReactNode {
  const task = useQuery("scorecard.task", { initiative, taskId });
  if (task.status === "loading") return <Spinner size="sm" label={`Loading ${taskId}`} />;
  if (task.data === undefined) return <Alert status="error" message={`Could not load ${taskId}: ${task.error.message}`} />;
  const { row } = task.data;
  return (
    <Section testID="scorecard-task-detail">
      <SectionHeader
        title={`${initiative} / ${taskId}`}
        subtitle="Scorecard row"
        trailing={
          <Link color="primary" className={PHONE_TAP_LINK} onPress={() => open({ view: "tasks", id: taskId })}>
            Open task
          </Link>
        }
      />
      <SectionContent>{row === null ? <EmptyState title={`${taskId} has no scorecard row`} description="Only dispatched tasks are scored." /> : <RowTable row={row} />}</SectionContent>
    </Section>
  );
}

function RowTable({ row }: { row: ScorecardTaskRow }): ReactNode {
  return (
    <Table density="dense">
      <TableBody>
        {FIELDS.map(([label, value, column]) => (
          <TableRow key={label}>
            <TableCell>{label}</TableCell>
            <TableCell>
              <Labelled value={value(row)} origin={column === undefined ? undefined : row.provenance[column]} {...(column === undefined ? {} : { testID: `scorecard-field-${column}-inferred` })} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
