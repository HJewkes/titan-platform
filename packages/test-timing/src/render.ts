import type { GrowthFinding, ProjectTrend, SeriesId, SlowerFinding, SuiteRuns, TimingReport } from "./report.js";
import type { RunVerdict } from "./trend.js";

const seconds = (ms: number) => (ms / 1000).toFixed(1);
const percent = (ratio: number | null) => (ratio === null ? "-" : `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(1)}%`);
const shortSha = (commit: string | null) => commit?.slice(0, 9) ?? "-";
const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
const table = (head: string[], rows: string[]) => [row(head), row(head.map(() => "---")), ...rows, ""];

function where({ level, runnerClass, project, file }: SeriesId): string[] {
  return [level, runnerClass, project ?? "-", file ?? "-"];
}

function verdictRow(verdict: RunVerdict): string {
  const { point } = verdict;
  const flag = verdict.anomalous ? "**anomaly**" : "";
  return row([point.runId, shortSha(point.commit), new Date(point.startedMs).toISOString().slice(0, 16), seconds(point.ms), percent(verdict.ratio), percent(verdict.heldRatio), flag]);
}

function suiteSection({ runnerClass, verdicts }: SuiteRuns): string[] {
  return [`### ${runnerClass}`, "", ...table(["run", "commit", "started", "total s", "vs rolling min", "held", ""], verdicts.map(verdictRow))];
}

function growthRow(finding: GrowthFinding): string {
  const { growth } = finding;
  return row([...where(finding), seconds(growth.baselineMs), seconds(growth.currentMs), `+${seconds(growth.deltaMs)}`, percent(growth.ratio), shortSha(growth.since.commit)]);
}

function trendRow(trend: ProjectTrend): string {
  const cells = trend.trend ? [seconds(trend.trend.baselineMs), seconds(trend.trend.currentMs), percent(trend.trend.ratio)] : ["-", "-", "-"];
  return row([trend.runnerClass, trend.project ?? "-", trend.runs, ...cells]);
}

function anomalyLines(report: TimingReport): string[] {
  if (report.anomalies.length === 0) return ["None.", ""];
  const held = `over the rolling minimum for ${report.rules.anomaly.hold} runs`;
  const line = ({ runnerClass, point, heldRatio }: TimingReport["anomalies"][number]) => `- **${runnerClass}** ${point.runId} (${shortSha(point.commit)}): ${percent(heldRatio)} ${held}`;
  return [...report.anomalies.map(line), ""];
}

/** The report a seat reads: anomalies first, then growth, the suite runs and every project's trend. */
export function renderReportMarkdown(report: TimingReport, { top = 30 }: { top?: number } = {}): string {
  const { stats, rules } = report;
  const span = `${stats.oldestStartedAt ?? "-"} to ${stats.newestStartedAt ?? "-"}`;
  const growthHead = ["level", "runner", "project", "file", "baseline s", "now s", "added s", "rise", "since"];
  return [
    "# Test timing report",
    "",
    `Generated ${report.generatedAt} from ${stats.runs} runs and ${stats.files} file rows (${span}). Full-scope runs only.`,
    "",
    `## Anomalies (suite ${percent(rules.anomaly.threshold)} over the minimum of the last ${rules.anomaly.window} runs, held ${rules.anomaly.hold} runs)`,
    "",
    ...anomalyLines(report),
    `## Growth (min of last ${rules.growth.recent} vs min of the ${rules.growth.baseline} before, ${percent(rules.growth.threshold)} and ${seconds(rules.growth.floorMs)} s or more)`,
    "",
    ...(report.growth.length === 0 ? ["None.", ""] : table(growthHead, report.growth.slice(0, top).map(growthRow))),
    ...(report.growth.length > top ? [`${report.growth.length - top} more in the JSON report.`, ""] : []),
    "## Suite runs",
    "",
    ...report.suites.flatMap(suiteSection),
    "## Project trends",
    "",
    ...table(["runner", "project", "runs", "baseline s", "now s", "change"], report.projects.map(trendRow)),
  ].join("\n");
}

/** "What got slower since <label>", largest rise first. */
export function renderSlowerMarkdown(findings: SlowerFinding[], label: string, { top = 50 }: { top?: number } = {}): string {
  const head = ["level", "runner", "project", "file", "before s", "after s", "added s", "rise", "runs after"];
  const cells = ({ shift, ...id }: SlowerFinding) => [...where(id), seconds(shift.beforeMs), seconds(shift.afterMs), `+${seconds(shift.deltaMs)}`, percent(shift.ratio), shift.afterRuns];
  const rows = findings.slice(0, top).map((finding) => row(cells(finding)));
  return [`# Slower since ${label}`, "", ...(rows.length === 0 ? ["Nothing got slower.", ""] : table(head, rows))].join("\n");
}
