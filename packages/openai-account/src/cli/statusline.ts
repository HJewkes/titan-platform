import { assertAccountLabel } from "../profile.js";
import { quotaAdmission, type UsageResult } from "../usage.js";
import { readNativeUsage } from "../node/native.js";
import { selectionOf, type CliContext, type SelectionOptions } from "./context.js";

const unknownLine = (label: string): string => `codex|${label}|unknown|unknown||`;

/** Display evidence even when exhausted; admission and freshness are separate concerns. */
export function statuslineLine(label: string, result: UsageResult, now: number): string {
  try { assertAccountLabel(label); }
  catch { return unknownLine("default"); }
  try {
    if (result.status !== "known" || result.reading.account !== label) return unknownLine(label);
    const admission = quotaAdmission(result, now);
    if (!admission.allowed && admission.reason !== "weekly-reserve" && admission.reason !== "five-hour-ceiling") return unknownLine(label);
    const limits = result.reading.rate_limits;
    const age = Math.floor(now - result.reading.written_at);
    return `codex|${label}|${Math.floor(limits.five_hour.used_percentage)}|${Math.floor(limits.seven_day.used_percentage)}|${age}|`;
  } catch { return unknownLine(label); }
}

export async function runStatusline(options: SelectionOptions, context: CliContext): Promise<number> {
  const { label, profile } = selectionOf(context, options);
  let line = unknownLine(label);
  const binding = options.expectedAccountId;
  if (profile && binding !== undefined && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(binding)) {
    try {
      const result = await (context.readNativeUsage ?? readNativeUsage)(profile, { expectedAccountId: binding, env: { ...context.env } });
      line = statuslineLine(label, result, context.now() / 1000);
    } catch { /* A statusline must not print transcript data or reader errors. */ }
  }
  context.out(line);
  return 0;
}
