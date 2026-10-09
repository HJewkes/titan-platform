import { describe, expect, it } from "vitest";
import { formatSquashMessage, type SquashInput } from "./squash-message.js";

// Built from parts: the egress scan refuses a literal address in the tree.
const address = (local: string, domain: string): string => [local, domain].join("@");
const BOT = address("noreply", "anthropic.com");
const OWNER = address("owner.person", "mail.example.org");
const OWNER_ALT = address("12345+owner", "users.noreply.github.com");

function input(overrides: Partial<SquashInput> = {}): SquashInput {
  return {
    title: "TP-1: Add the widget",
    body: "Adds the widget so callers can stop hand-rolling it.",
    prNumber: 42,
    taskIds: ["TP-1"],
    commits: [{ subject: "Add the widget", body: "" }],
    ...overrides,
  };
}

describe("formatSquashMessage", () => {
  it("lays a multi-commit squash out as summary, one bullet per commit and refs", () => {
    const result = formatSquashMessage(
      input({
        title: "Add the widget",
        taskIds: ["TP-1", "TP-2"],
        commits: [
          { subject: "Add the widget core", body: "The core holds no I/O,\nso tests need no fakes.\n\nA second paragraph." },
          { subject: "Merge origin/main into agent-chat/tp-1", body: "" },
          { subject: "Wire the widget CLI.", body: "Reads JSON\non stdin." },
          { subject: "Merge branch 'main' into feat/widget", body: "" },
          { subject: "Merge remote-tracking branch 'origin/main' into feat/widget", body: "" },
          { subject: "Document the widget", body: "" },
        ],
      }),
    );

    expect(result.subject).toBe("Add the widget (TP-1, TP-2) (#42)");
    expect(result.body).toBe(
      [
        "## Summary",
        "",
        "Adds the widget so callers can stop hand-rolling it.",
        "",
        "## Changes",
        "",
        "- **Add the widget core.** The core holds no I/O, so tests need no fakes.",
        "",
        "  A second paragraph.",
        "- **Wire the widget CLI.** Reads JSON on stdin.",
        "- **Document the widget.**",
        "",
        "Refs: TP-1, TP-2, #42",
      ].join("\n"),
    );
  });

  it("removes trailers, every email address, GitHub's separator and its commit headers", () => {
    const result = formatSquashMessage(
      input({
        body: [
          "Adds the widget. Questions to " + OWNER + ".",
          "",
          "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
        ].join("\n"),
        commits: [
          {
            subject: "Add the widget",
            body: [
              "* Earlier squashed commit",
              "",
              "Its body.",
              "",
              "* Another one",
              "",
              "---------",
              "",
              "Co-authored-by: Claude <" + BOT + ">",
              "co-authored-by: Owner <" + OWNER_ALT + ">",
              "Signed-off-by: Owner <" + OWNER + ">",
            ].join("\n"),
          },
        ],
      }),
    );

    const message = `${result.subject}\n\n${result.body}`;
    expect(message).not.toMatch(/@[\w.-]+\.\w{2,}/);
    expect(message).not.toMatch(/co-authored-by|signed-off-by|generated with/i);
    expect(message).not.toContain("---------");
    expect(message).not.toMatch(/^\* /m);
    expect(result.body).toBe(
      [
        "## Summary",
        "",
        "Adds the widget. Questions to.",
        "",
        "## Changes",
        "",
        "- **Add the widget.** Earlier squashed commit",
        "",
        "  Its body.",
        "",
        "  Another one",
        "",
        "Refs: TP-1, #42",
      ].join("\n"),
    );
  });

  it("omits the summary section when the PR body is empty", () => {
    const result = formatSquashMessage(input({ body: "  \n\n" }));

    expect(result.body).toBe(["## Changes", "", "- **Add the widget.**", "", "Refs: TP-1, #42"].join("\n"));
  });

  it("keeps the task id out of the subject when the title already names it", () => {
    const result = formatSquashMessage(input());

    expect(result.subject).toBe("TP-1: Add the widget (#42)");
  });

  it("formats a single commit as one bullet", () => {
    const result = formatSquashMessage(input({ commits: [{ subject: "Add the widget", body: "Because callers\nneed it." }] }));

    expect(result.body).toBe(
      [
        "## Summary",
        "",
        "Adds the widget so callers can stop hand-rolling it.",
        "",
        "## Changes",
        "",
        "- **Add the widget.** Because callers need it.",
        "",
        "Refs: TP-1, #42",
      ].join("\n"),
    );
  });

  it("keeps list items and fenced code in a commit body on their own lines", () => {
    const result = formatSquashMessage(
      input({ commits: [{ subject: "Add the widget", body: "Steps:\n- one\n- two\n\n```\nwidget --run\n```" }] }),
    );

    expect(result.body).toContain("- **Add the widget.** Steps:\n  - one\n  - two\n\n  ```\n  widget --run\n  ```\n");
  });

  it("writes Refs with only the PR number when there is no task id", () => {
    const result = formatSquashMessage(input({ taskIds: [] }));

    expect(result.subject).toBe("TP-1: Add the widget (#42)");
    expect(result.body.endsWith("\n\nRefs: #42")).toBe(true);
  });

  it("gives byte-identical output for the same input", () => {
    const first = formatSquashMessage(input({ taskIds: ["TP-2", "TP-1"] }));
    const second = formatSquashMessage(input({ taskIds: ["TP-2", "TP-1"] }));

    expect(second).toEqual(first);
  });

  it("changes nothing when it formats an already formatted message", () => {
    const original = input({
      title: "Add the widget",
      body: "## Summary\n\nAdds the widget.\n\n## Test plan\n\n- [x] pnpm test",
      commits: [
        { subject: "Add the widget core", body: "Para one\nwraps.\n\nPara two." },
        { subject: "Wire the CLI", body: "" },
      ],
    });
    const once = formatSquashMessage(original);

    const twice = formatSquashMessage({ ...original, title: once.subject, body: once.body });

    expect(twice).toEqual(once);
  });

  it("keeps the last item of a star list that a blank line follows", () => {
    const list = "Fixes:\n\n* first\n* second\n\nMore text.";

    const result = formatSquashMessage(input({ body: list, commits: [{ subject: "Fix it", body: "* first\n* second\n\nMore." }] }));

    expect(result.body).toContain("## Summary\n\nFixes:\n\n* first\n* second\n\nMore text.\n\n");
    expect(result.body).toContain("- **Fix it.** * first\n  * second\n\n  More.\n");
  });

  it("keeps the author's own Changes and Test plan sections, and re-formats them unchanged", () => {
    const body = "## Summary\n\nAdds it.\n\n## Changes\n\n- did y\n\n## Test plan\n\n- [x] pnpm test";
    const original = input({ body });
    const once = formatSquashMessage(original);

    const twice = formatSquashMessage({ ...original, title: once.subject, body: once.body });

    expect(once.body).toContain("Adds it.\n\n## Changes\n\n- did y\n\n## Test plan\n\n- [x] pnpm test\n\n## Changes\n\n- **Add the widget.**");
    expect(twice).toEqual(once);
  });

  it("keeps a Refs line the author wrote at the end of the PR body", () => {
    const result = formatSquashMessage(input({ body: "Adds it.\n\nRefs: TP-1, #42" }));

    expect(result.body).toContain("## Summary\n\nAdds it.\n\nRefs: TP-1, #42\n\n## Changes");
  });

  it("keeps the author's horizontal rules and setext underlines", () => {
    const body = "Title\n-------\n\nAbove\n\n----------\n\nBelow";

    const result = formatSquashMessage(input({ body, commits: [{ subject: "Add it", body: "One\n\n----------\n\nTwo" }] }));

    expect(result.body).toContain(`## Summary\n\n${body}\n\n`);
    expect(result.body).toContain("- **Add it.** One\n\n  ----------\n\n  Two\n");
  });

  it("drops a merge of main pulled from a remote URL", () => {
    const result = formatSquashMessage(
      input({ commits: [{ subject: "Merge branch 'main' of github.com:o/r into feat/x", body: "" }, { subject: "Add it", body: "" }] }),
    );

    expect(result.body).not.toContain("Merge");
  });

  it("keeps the summary empty when re-formatting a message that had none", () => {
    const once = formatSquashMessage(input({ body: "" }));

    const twice = formatSquashMessage(input({ title: once.subject, body: once.body }));

    expect(twice).toEqual(once);
  });
});
