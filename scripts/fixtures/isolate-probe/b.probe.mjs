import { expect, it } from "vitest";
import { bump } from "./counter.mjs";

it("bumps the shared counter", ({ task }) => {
  console.log(`probe ${task.file.projectName} ${bump()}`);
  expect(true).toBe(true);
});
