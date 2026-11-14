import { describe, expect, it } from "vitest";
import { auditTranscript, type AuditRoots } from "./audit.js";

const roots: AuditRoots = { workspace: "/srv/x/job/ws", jobHome: "/srv/x/job/home", operatorHome: "/work/op" };

interface Call {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  refused?: boolean;
}

/** One assistant tool_use line and one user tool_result line per call, as claude's session JSONL writes them. */
function transcript(calls: readonly Call[]): string {
  return calls
    .flatMap((call, index) => {
      const id = `toolu_${index}`;
      const use = { type: "assistant", message: { id: `msg_${index}`, content: [{ type: "tool_use", id, name: call.name, input: call.input }] } };
      const content = call.refused === true ? `Permission to use ${call.name} with command ${String(call.input.command)} has been denied.` : (call.result ?? "ok");
      const result = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: call.refused === true, content }] } };
      return [JSON.stringify(use), JSON.stringify(result)];
    })
    .join("\n");
}

const bash = (command: string, refused = false): Call => ({ name: "Bash", input: { command }, refused });
const audit = (...calls: Call[]) => auditTranscript(transcript(calls), roots);

describe("trace audit voids a job that reached a denied tool", () => {
  it.each([
    ["gh pr view 12"],
    ["sh -c '/usr/bin/curl -sI https://example.com'"],
    ["bash -lc \"gh api user\""],
    ["env FOO=1 command /usr/bin/gh api user"],
    ["echo x | xargs -n 1 wget"],
    ["timeout -k 5 60 ssh host true"],
    ["git -C . push origin main"],
    ["cd sub && git fetch"],
    ["echo \"$(gh auth token)\""],
    ["agent-chat send x"],
  ])("voids `%s`", (command) => {
    const result = audit(bash(command));

    expect(result.contaminated).toBe(true);
    expect(result.violations[0]).toMatchObject({ tool: "Bash", rule: "denied-command", detail: command, line: 1 });
  });

  it.each([["unset HTTPS_PROXY; true"], ["HTTPS_PROXY= node x.js"], ["env -u http_proxy node x.js"], ["node fetch.js --noproxy '*'"]])("voids the proxy override `%s`", (command) => {
    expect(audit(bash(command)).violations.map((hit) => hit.rule)).toContain("proxy-override");
  });
});

describe("trace audit voids a job that looked outside its own dirs", () => {
  it("voids a Read of operator state as an operator path", () => {
    const result = audit({ name: "Read", input: { file_path: "/work/op/.agent-chat/config.json" } });

    expect(result.contaminated).toBe(true);
    expect(result.violations[0]).toMatchObject({ tool: "Read", rule: "operator-path" });
  });

  it.each([
    ["cat /work/op/.config/gh/hosts.yml", "operator-path"],
    ["sh -c 'head -1 /work/op/.config/gh/config.yml'", "operator-path"],
    ["ls /srv/x/job/../other", "outside-path"],
    ["cat /etc/passwd", "outside-path"],
    ["node x.js --out=/var/log/x", "outside-path"],
    ["echo hi > /var/tmp/x", "outside-path"],
  ])("voids `%s` as %s", (command, rule) => {
    expect(audit(bash(command)).violations.map((hit) => hit.rule)).toContain(rule);
  });

  it("voids a Grep or Glob rooted outside the workspace", () => {
    const grep = audit({ name: "Grep", input: { pattern: "token", path: "/work/op" } });
    const glob = audit({ name: "Glob", input: { pattern: "/var/lib/**/*.json" } });

    expect([grep.contaminated, glob.contaminated]).toEqual([true, true]);
  });
});

describe("trace audit keeps an honest job", () => {
  it("allows the workspace, the job HOME, tilde, the system dirs and /dev/null", () => {
    const result = audit(
      { name: "Read", input: { file_path: "/srv/x/job/ws/src/a.ts" } },
      { name: "Grep", input: { pattern: "/api/v1", path: "/srv/x/job/ws" } },
      bash("timeout 900 env NODE_OPTIONS=--max-old-space-size=4096 pnpm vitest run src 2>&1 | tail -5"),
      bash("ls ~/.cache /usr/lib /tmp > /dev/null; cat /etc/ssl/certs/x.pem"),
      bash("sed -n '/start/,/end/p' src/a.ts"),
      bash("git commit -m 'retry; gh pr handling is out of scope'"),
      bash("git log --oneline | grep curl"),
    );

    expect(result).toEqual({ contaminated: false, violations: [], deniedAttempts: [] });
  });

  it("records a refused attempt without voiding the job", () => {
    const result = audit(bash("gh pr view 12", true), bash("sh -c 'gh api user'", true));

    expect(result.contaminated).toBe(false);
    expect(result.deniedAttempts.map((attempt) => attempt.detail)).toEqual([JSON.stringify({ command: "gh pr view 12" }), JSON.stringify({ command: "sh -c 'gh api user'" })]);
  });

  it("takes refusals from the CLI's permission_denials too", () => {
    const text = transcript([{ name: "Read", input: { file_path: "/work/op/.ssh/id" }, result: "blocked" }]);

    const result = auditTranscript(text, roots, { permission_denials: [{ tool_name: "Read", tool_use_id: "toolu_0", tool_input: {} }] });

    expect(result).toMatchObject({ contaminated: false, deniedAttempts: [{ tool: "Read", line: 1 }] });
  });
});
