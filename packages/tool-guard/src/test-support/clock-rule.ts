/** The one test module that reads a clock: every CPU or ratio check goes through it. */
export const CLOCK_HOME = "test-support/cpu-budget.ts";

const CLOCK_READ = /\b(?:process\.(?:threadCpuUsage|cpuUsage|hrtime(?:\.bigint)?)|performance\.now|Date\.now)\(/;

/** Test files and test-support modules, by path relative to the package's src. */
export const isTestModule = (file: string): boolean => file.endsWith(".test.ts") || file.startsWith("test-support/");

/**
 * The rule's violations among `files` ([path relative to src, text]): a test module other than CLOCK_HOME that reads a
 * clock without an entry in `allowed`, and an `allowed` entry whose file no longer reads one, so the list only shrinks.
 */
export function clockRuleViolations(files: ReadonlyArray<readonly [string, string]>, allowed: Readonly<Record<string, string>>): string[] {
  const readers = new Map<string, string>();
  for (const [file, text] of files) {
    const read = isTestModule(file) && file !== CLOCK_HOME ? CLOCK_READ.exec(text) : null;
    if (read) readers.set(file, read[0]);
  }
  const unlisted = [...readers].filter(([file]) => !(file in allowed));
  const stale = Object.keys(allowed).filter((file) => !readers.has(file));
  return [
    ...unlisted.map(([file, read]) => `${file} reads a clock (${read}). Time a CPU or ratio check with cpuBudgetIt from ${CLOCK_HOME}, whose wall timeout follows from its CPU budget (TP-3877).`),
    ...stale.map((file) => `${file} no longer reads a clock; remove its entry from the allowlist.`),
  ];
}
