import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectServed } from "./report.js";

const HARNESS_ID = "session_01SidechainParent";
const PLAN = "codewatch-audit-plan.md";

describe("served labels for a subagent sidechain", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "served-sidechain-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("labels a sidechain's blocks against the parent's wrap record via the harness url it carries", async () => {
    const sessions = path.join(dir, "root", "codewatch", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      path.join(sessions, "2026-09-20-1000-wrap.md"),
      `---\nsession_id: ${HARNESS_ID}\n---\nFollowed ${PLAN} to close the audit.\n`,
    );
    const sidechainDir = path.join(dir, "projects", "p", "parent-uuid", "subagents");
    mkdirSync(sidechainDir, { recursive: true });
    const sidechain = path.join(sidechainDir, "agent-a1.jsonl");
    const turn = `# Open loops (1 hanging)\n- [3d] Ship it.\n    see: source:codewatch/${PLAN} "Plan"`;
    writeFileSync(
      sidechain,
      [
        { type: "attachment", timestamp: "2026-09-20T09:59:00Z", text: `https://claude.ai/code/${HARNESS_ID}` },
        { type: "user", timestamp: "2026-09-20T10:00:00Z", message: { content: turn } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );

    const inputs = await collectServed([sidechain], path.join(dir, "root"), {});

    expect(inputs.observations).toMatchObject([{ key: PLAN, opened: false, cited: true }]);
  });
});
