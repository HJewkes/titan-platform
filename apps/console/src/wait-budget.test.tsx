// @vitest-environment jsdom
import { getConfig } from "@testing-library/react";
import { expect, it } from "vitest";

// inbox.test.tsx froze main for 2 h when a findBy gave up at testing-library's 1 s default on a loaded runner (TP-3983).
it("gives findBy and waitFor at least 10 s before a render counts as missing", () => {
  expect(getConfig().asyncUtilTimeout).toBeGreaterThanOrEqual(10_000);
});
