import { existsSync, readFileSync } from "node:fs";
import { EXIT, defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { citationReportSchema, findingSchema, verifyCitations, type CitationCheck, type CitationReport, type CitationRunner, type Finding } from "../insights/citations.js";
import { insightCommand, type AnyInsight } from "../insights/define.js";
import { AGENT_CHAT_QUESTIONS, INSIGHT_QUESTIONS, TRANSCRIPT_QUESTIONS } from "../insights/questions.js";

const VerifyCitationsArgs = z.object({ findings: z.string().min(1).describe("JSON file holding an array of findings") }).strict();

export const verifyCitationsCommand = defineCommand<z.infer<typeof VerifyCitationsArgs>, CitationReport | string, MinerContext>({
  name: "insights.verify-citations",
  description: "Re-run every question a finding cites and check each cited field; exits non-zero on any citation that is not ok",
  args: VerifyCitationsArgs,
  result: z.union([citationReportSchema, z.string()]),
  cli: { options: { findings: { long: "--findings", description: "findings JSON file", required: true } } },
  async run(args, ctx) {
    if (ctx.surface !== "cli") throw Object.assign(new Error("findings is accepted only on the CLI"), { code: EXIT.DATAERR });
    const report = await verifyCitations(readFindings(args.findings), insightRunner([...INSIGHT_QUESTIONS, ...AGENT_CHAT_QUESTIONS, ...TRANSCRIPT_QUESTIONS], ctx));
    const text = renderCitationReport(report);
    if (!report.ok) throw Object.assign(new Error(text), { code: EXIT.GENERIC });
    return ctx.format === "human" ? text : report;
  },
});

function readFindings(file: string): Finding[] {
  if (!existsSync(file)) throw Object.assign(new Error(`findings file not found: ${file}`), { code: EXIT.NOINPUT });
  const parsed = z.array(findingSchema).safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw Object.assign(new Error(`invalid findings: ${z.prettifyError(parsed.error)}`), { code: EXIT.DATAERR });
  return parsed.data;
}

/** Runs a question by name through its registered command, so flags parse and normalize exactly as on the CLI. */
export function insightRunner(questions: readonly AnyInsight[], ctx: MinerContext): CitationRunner {
  return async (name, args) => {
    const question = questions.find((q) => q.name === name);
    if (!question) return undefined;
    const command = insightCommand(question);
    const parsed = command.args.safeParse(Object.fromEntries(Object.entries(args).map(([flag, value]) => [optionKey(flag), value])));
    if (!parsed.success) throw new Error(`invalid args: ${z.prettifyError(parsed.error)}`);
    const result = (await command.run(parsed.data, { ...ctx, format: "json" })) as { answer: unknown };
    return { answer: result.answer };
  };
}

/** Accepts `--agent-prefix`, `agent-prefix` or `agentPrefix`, the forms an analyst copies from a command line or a schema. */
function optionKey(flag: string): string {
  return flag.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function renderCitationReport(report: CitationReport): string {
  const citations = report.findings.flatMap((f) => f.citations.map((c) => ({ finding: f.id, ...c })));
  const failed = citations.filter((c) => c.status !== "ok");
  const lines = failed.map(({ finding, ...c }) => `${finding}: ${c.status} ${c.question} ${c.field}${describeActual(c)}`);
  return [`${citations.length - failed.length}/${citations.length} citations ok across ${report.findings.length} findings`, ...lines].join("\n");
}

function describeActual(check: CitationCheck): string {
  if (check.status === "error") return ` (${check.detail})`;
  if (check.status === "mismatch") return ` cited ${JSON.stringify(check.value)}, actual ${JSON.stringify(check.actual)}`;
  return "";
}
