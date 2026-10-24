import { alarmKey, type OwnerItemDeposit } from "@titan-design/owner-queue";
import type { ApiError } from "./watch.js";

/** The asker and key of the planner's no-review alarm; the next wake that sees a review withdraws every open deposit with them. */
export const PLANNER_ALARM_ASKER = "titan-factory";
export const PLANNER_ALARM_KEYS = ["planner-alarm"] as const;

const RERUN_COMMAND = "systemctl --user start factory-planner-wake.service";

export interface PlannerAlarm {
  name: string;
  reason: "exited" | "timeout";
  spawnedAt: string;
  noFileAfterMinutes: number;
  reviewDir: string;
  transcriptPath?: string;
  apiError?: ApiError;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function why(alarm: PlannerAlarm): string {
  const cause = alarm.reason === "exited" ? "exited" : `still running after ${alarm.noFileAfterMinutes} min`;
  return alarm.apiError ? `${cause}: ${oneLine(alarm.apiError.text)}` : cause;
}

/**
 * One deposit per wake, so a failure after a withdrawn alarm files a fresh item; the alarm key
 * folds the repeats of a planner that keeps failing into one card.
 */
export function plannerAlarmDeposit(alarm: PlannerAlarm): OwnerItemDeposit {
  const { apiError } = alarm;
  const resets = apiError?.resetsAt === undefined ? [] : [`Resets at ${new Date(apiError.resetsAt * 1000).toISOString()}.`];
  return {
    depositId: `${alarm.name}-no-review-${alarm.spawnedAt}`,
    asker: PLANNER_ALARM_ASKER,
    kind: "do",
    door: "two-way",
    summary: `${alarm.name} wake wrote no review (${why(alarm)})`.slice(0, 280),
    context: [
      `Spawned ${alarm.spawnedAt}; no new review in ${alarm.reviewDir}.`,
      ...(alarm.transcriptPath ? [`Transcript: ${alarm.transcriptPath}.`] : []),
      ...(apiError ? [`API error${apiError.apiError ? ` ${apiError.apiError}` : ""}: ${oneLine(apiError.text)}.`, ...resets] : []),
      "Fix the cause, then run the wake again.",
    ].join(" "),
    command: RERUN_COMMAND,
    keys: [...PLANNER_ALARM_KEYS, alarmKey(`planner-alarm:${alarm.name}`)],
  };
}
