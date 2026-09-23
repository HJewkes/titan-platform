import { describe, expect, it } from "vitest";
import { PROJECT } from "../test-support/python-audit.js";
import { countSuppressions, findSuppressions, suppressionTotals } from "./suppressions.js";

describe("countSuppressions", () => {
  it("emits one diagnostic per noqa and type: ignore marker, with its line and codes", () => {
    const result = countSuppressions(["pkg/core.py", "pkg/helpers.py"], { cwd: PROJECT });

    expect(result.diagnostics.map((d) => `${d.file}:${d.line} ${d.rule} | ${d.message}`)).toEqual([
      "pkg/core.py:49 suppression/noqa | blanket noqa suppresses every check on this line",
      "pkg/core.py:50 suppression/noqa | noqa suppresses F401",
      "pkg/core.py:51 suppression/type-ignore | blanket type: ignore suppresses every check on this line",
      "pkg/core.py:52 suppression/noqa | noqa suppresses E501, F841",
      "pkg/core.py:52 suppression/type-ignore | type: ignore suppresses assignment",
      "pkg/helpers.py:1 suppression/noqa | noqa suppresses F401",
    ]);
    expect(result.diagnostics.every((d) => d.severity === "warn")).toBe(true);
  });

  it("reports an unreadable file as not checked instead of throwing", () => {
    const result = countSuppressions(["nope.py"], { cwd: PROJECT });

    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([expect.objectContaining({ tool: "suppressions", kind: "file-not-checked", file: "nope.py" })]);
  });
});

describe("findSuppressions", () => {
  it("accepts the spacing and case variants flake8 and ruff accept", () => {
    const text = "a = 1  #noqa:E501\nb = 2  # NOQA\nc = 3  #type:ignore\nd = 4  # not a noqa marker\n";

    const found = findSuppressions("m.py", text).map((d) => `${d.line} ${d.rule} ${d.column}`);

    expect(found).toEqual(["1 suppression/noqa 8", "2 suppression/noqa 8", "3 suppression/type-ignore 8"]);
  });
});

describe("suppressionTotals", () => {
  it("totals markers overall and per file, ignoring other diagnostics", () => {
    const { diagnostics } = countSuppressions(["pkg/core.py", "pkg/helpers.py"], { cwd: PROJECT });
    const other = { ...diagnostics[0]!, rule: "vulture/unused-import" };

    const totals = suppressionTotals([...diagnostics, other]);

    expect(totals).toEqual({
      noqa: 4,
      typeIgnore: 2,
      byFile: { "pkg/core.py": { noqa: 3, typeIgnore: 2 }, "pkg/helpers.py": { noqa: 1, typeIgnore: 0 } },
    });
  });
});
