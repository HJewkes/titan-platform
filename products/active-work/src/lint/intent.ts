import { promises as fs } from 'node:fs';
import path from 'node:path';
import { IntentLineSchema } from '@titan-design/pm';
import YAML from 'yaml';
import type { LintFinding } from './types.js';

function problemsOf(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    return [`not YAML: ${err instanceof Error ? err.message : String(err)}`];
  }
  const result = IntentLineSchema.safeParse(parsed);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/**
 * Refuse each intent line under `plan/intent/` that fails the pm schema: a line with no quote or no date cannot be
 * cited, so it is an error rather than a warning.
 */
export async function lintIntent(slug: string, initiativeDir: string): Promise<LintFinding[]> {
  const dir = path.join(initiativeDir, 'plan', 'intent');
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith('.yml')).sort();
  } catch {
    return [];
  }
  const findings: LintFinding[] = [];
  for (const name of files) {
    const problems = problemsOf(await fs.readFile(path.join(dir, name), 'utf8'));
    if (problems.length === 0) continue;
    findings.push({ level: 'error', slug, file: path.posix.join('plan', 'intent', name), message: `intent line refused: ${problems.join('; ')}` });
  }
  return findings;
}
