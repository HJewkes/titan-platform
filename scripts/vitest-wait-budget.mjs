import { vi } from "vitest";
import { WAIT_BUDGET_MS } from "./wait-budget.mjs";

const BUDGETED = Symbol.for("titan-platform.wait-budget");

// vitest has no config for vi.waitFor's 1 s default, so wrap it once per worker; an explicit timeout still wins.
function withBudget(wait) {
  if (wait[BUDGETED]) return wait;
  const budgeted = (callback, options = {}) =>
    wait(callback, typeof options === "number" ? options : { ...options, timeout: options.timeout ?? WAIT_BUDGET_MS });
  budgeted[BUDGETED] = true;
  return budgeted;
}

vi.waitFor = withBudget(vi.waitFor);
vi.waitUntil = withBudget(vi.waitUntil);

// Only DOM tests use testing-library; node tests skip loading it.
if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/dom");
  configure({ asyncUtilTimeout: WAIT_BUDGET_MS });
}
