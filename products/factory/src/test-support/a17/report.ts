// Node strips this file's types when scripts/a17.mjs imports it, so it carries no runtime imports.

const MODES = ["webhook", "polling"] as const;
type Mode = (typeof MODES)[number];
type ModeState = "passed" | "failed" | "skipped" | "todo" | "pending" | "missing" | (string & {});

interface VitestAssertion {
  title: string;
  fullName: string;
  ancestorTitles: string[];
  status: string;
}

export interface VitestJson {
  testResults: Array<{ assertionResults: VitestAssertion[] }>;
}

export interface A17Report {
  schema: "a17-report/v1";
  sha: string;
  generatedAt: string;
  cases: Array<{ title: string } & Record<Mode, ModeState>>;
  oneMode: string[];
  notEvent: string[];
  ok: boolean;
}

interface ReportMeta {
  sha: string;
  generatedAt: string;
  /** Base titles of A17 cases with no GitHub input; they stay single-mode. */
  notEvent: readonly string[];
}

const PREFIX = "A17: ";
const SUFFIX = /^(.*) \[(webhook|polling)\]$/;

/** A case's identity is its describe path plus base title, so same-titled cases in two blocks never pair. */
function split(a: VitestAssertion): { key: string; title: string; mode?: Mode } {
  const body = a.title.slice(PREFIX.length);
  const match = SUFFIX.exec(body);
  const title = match ? match[1]! : body;
  return { key: [...a.ancestorTitles, title].join("\u0000"), title, mode: match ? (match[2] as Mode) : undefined };
}

/** Groups a vitest JSON run's A17 results by case; a case is ok only when both modes ran and passed. */
export function checkA17Report(json: VitestJson, meta: ReportMeta): A17Report {
  const grouped = new Map<string, A17Report["cases"][number]>();
  const notEvent = new Set<string>();
  for (const file of json.testResults) {
    for (const a of file.assertionResults) {
      if (!a.title.startsWith(PREFIX)) continue;
      const { key, title, mode } = split(a);
      if (meta.notEvent.includes(title)) {
        notEvent.add(title);
        continue;
      }
      const entry = grouped.get(key) ?? { title, webhook: "missing", polling: "missing" };
      if (mode) entry[mode] = a.status;
      grouped.set(key, entry);
    }
  }
  const cases = [...grouped.values()];
  const oneMode = cases.filter((c) => c.webhook !== "passed" || c.polling !== "passed").map((c) => c.title);
  return {
    schema: "a17-report/v1",
    sha: meta.sha,
    generatedAt: meta.generatedAt,
    cases,
    oneMode,
    notEvent: [...notEvent],
    ok: cases.length > 0 && oneMode.length === 0,
  };
}
