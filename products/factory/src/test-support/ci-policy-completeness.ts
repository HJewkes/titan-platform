import { expect } from "vitest";
import { MAX_LINES_PER_CARD, MAX_LINES_PER_FILE, shownLine, type CiPolicyFile, type CiPolicyFileChange } from "../shepherd/ci-policy-changes.js";

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** removed + added of a minimal line diff, from a longest common subsequence computed apart from the code under test. */
function changedLineCount(before: readonly string[], after: readonly string[]): number {
  let previous = new Array<number>(after.length + 1).fill(0);
  for (const line of before) {
    const row = [0];
    after.forEach((other, j) => row.push(line === other ? previous[j]! + 1 : Math.max(previous[j + 1]!, row[j]!)));
    previous = row;
  }
  return before.length + after.length - 2 * previous[after.length]!;
}

/**
 * The D21 boundary rule: for every file, shown + omitted = removed + added, the caps alone decide how many lines show,
 * and each shown line is the cleaned text of the line it names, in diff order on each side.
 */
export function expectEveryChangedLine(files: readonly CiPolicyFile[], changes: readonly CiPolicyFileChange[]): void {
  expect(changes.map((change) => change.path)).toEqual(files.map((file) => shownLine(file.path)));
  let cardLeft = MAX_LINES_PER_CARD;
  changes.forEach((change, index) => {
    const sides = { "-": splitLines(files[index]!.before), "+": splitLines(files[index]!.after) };
    const changed = changedLineCount(sides["-"], sides["+"]);
    expect(change.lines.length + change.omitted).toBe(changed);
    expect(change.lines).toHaveLength(Math.min(changed, MAX_LINES_PER_FILE, cardLeft));
    cardLeft -= change.lines.length;
    for (const line of change.lines) expect(line.text).toBe(shownLine(sides[line.side][line.n - 1] ?? "<no such line>"));
    for (const side of ["-", "+"] as const) {
      const numbers = change.lines.filter((line) => line.side === side).map((line) => line.n);
      expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    }
  });
}
