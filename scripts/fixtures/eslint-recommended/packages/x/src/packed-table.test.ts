import { expect, it } from "vitest";

const [alpha, bravo, charlie, delta, echo] = [true, false, true, false, true];
const table = [
  [alpha && bravo, charlie || !delta, (echo && alpha) || !bravo, delta && charlie && echo, bravo && !alpha && delta, !echo && charlie && bravo && alpha, delta && !charlie && bravo, alpha || bravo || charlie || delta || echo, alpha && !echo && bravo],
];

it("keeps every row the same width", () => {
  expect(table.every((row) => row.length === 9)).toBe(true);
});
