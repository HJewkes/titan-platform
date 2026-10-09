import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import { formatReport } from "./report.js";
import { matchRules } from "./rules.js";
import { scan } from "./scan.js";
import { locateTokens } from "./tokens.js";

// Every token-shaped fixture is assembled at runtime so this repo never holds a literal one.
const alnum = (n: number) => "Ab1".repeat(n).slice(0, n);
const digits = (n: number) => "1234567890".repeat(n).slice(0, n);
const pem = (label: string) => "-".repeat(5) + `BEGIN ${label}` + "-".repeat(5);
const fake = {
  ghp: "ghp_" + "A".repeat(36),
  gho: "gho_" + alnum(36),
  ghu: "ghu_" + alnum(36),
  ghs: "ghs_" + alnum(36),
  ghr: "ghr_" + alnum(36),
  pat: "github_pat_" + alnum(22) + "_" + alnum(59),
  anthropic: "sk-ant-" + "api03-" + alnum(93) + "AA",
  akia: "AKIA" + "Z".repeat(16),
  asia: "ASIA" + "Q2".repeat(8),
  slackBot: "xoxb-" + digits(12) + "-" + digits(13) + "-" + alnum(24),
  slackUser: "xoxp-" + digits(12) + "-" + digits(12) + "-" + digits(12) + "-" + alnum(32),
  rsaKey: pem("RSA PRIVATE KEY"),
  pkcs8Key: pem("PRIVATE KEY"),
  opensshKey: pem("OPENSSH PRIVATE KEY"),
};

describe("credential-token", () => {
  it.each([
    ["github", "a classic ghp_ token", fake.ghp],
    ["github", "a gho_ OAuth token", fake.gho],
    ["github", "a ghu_ user-to-server token", fake.ghu],
    ["github", "a ghs_ server-to-server token", fake.ghs],
    ["github", "a ghr_ refresh token", fake.ghr],
    ["github", "a fine-grained github_pat_ token", fake.pat],
    ["anthropic", "an sk-ant- key", fake.anthropic],
    ["aws-access-key", "an AKIA access key id", fake.akia],
    ["aws-access-key", "an ASIA temporary access key id", fake.asia],
    ["slack", "a xoxb- bot token", fake.slackBot],
    ["slack", "a xoxp- user token", fake.slackUser],
    ["private-key", "an RSA PEM header", fake.rsaKey],
    ["private-key", "a PKCS#8 PEM header", fake.pkcs8Key],
    ["private-key", "an OpenSSH PEM header", fake.opensshKey],
  ])("flags %s for %s", (kind, _label, token) => {
    expect(matchRules(`export GH="${token}" # set`)).toEqual([{ rule: "credential-token", kind }]);
  });

  it.each([
    ["a 40-hex git sha", "a3f1c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2"],
    ["the literal word token", "set the token in your env"],
    ["a docs mention of a bare prefix", "GitHub tokens start with ghp_, gho_ or github_pat_"],
    ["a truncated classic token", "ghp_" + "A".repeat(35)],
    ["a classic token with an unknown prefix", "ghx_" + "A".repeat(36)],
    ["a prefix glued to a longer word", "xghp_" + "A".repeat(36)],
    ["a truncated fine-grained token", "github_pat_" + alnum(22) + "_" + alnum(20)],
    ["a bare Anthropic prefix", "keys look like sk-ant-api03-..."],
    ["a short Anthropic body", "sk-ant-" + "api03-" + alnum(20)],
    ["an access key id one character short", "AKIA" + "Z".repeat(15)],
    ["an access key id inside a longer word", "AKIA" + "Z".repeat(17)],
    ["a lower-case access key id", "akia" + "z".repeat(16)],
    ["a bare Slack prefix", "Slack bot tokens start with xoxb-"],
    ["a Slack prefix with a short body", "xoxb-" + digits(4) + "-abc"],
    ["a public key PEM header", "-".repeat(5) + "BEGIN PUBLIC KEY" + "-".repeat(5)],
    ["a certificate PEM header", "-".repeat(5) + "BEGIN CERTIFICATE" + "-".repeat(5)],
    ["prose about private keys", "never commit a BEGIN PRIVATE KEY block"],
  ])("ignores %s", (_label, text) => {
    expect(matchRules(text)).toEqual([]);
  });

  // `\\n` here is a literal backslash and n, the way JSON logs and .jsonl transcripts escape a break.
  const escaped = [
    ["github", fake.ghp],
    ["anthropic", fake.anthropic],
    ["aws-access-key", fake.akia],
    ["slack", fake.slackBot],
  ] as const;
  it.each(escaped.flatMap(([kind, token]) => ["\\n", "\\t", "\\r", '\\"'].map((escape) => [kind, escape, token])))(
    "flags %s after a %s escape",
    (kind, escape, token) => {
      expect(matchRules(`{"body":"x${escape}${token}"}`)).toEqual([{ rule: "credential-token", kind }]);
    },
  );

  it.each([
    ["a percent-encoded space", `q=%20${fake.ghp}`],
    ["a percent-encoded equals sign", `token%3D${fake.ghp}`],
    ["a URL path", `https://example.invalid/hook/${fake.ghp}/run`],
    ["an underscore-joined name", `MY_TOKEN_${fake.ghp}`],
    ["a trailing hyphen", `${fake.ghp}-x`],
    ["an equals assignment", `TOKEN=${fake.ghp}`],
    ["parentheses", `(${fake.ghp})`],
    ["a code span", `\`${fake.ghp}\``],
    ["URL credentials", `https://x:${fake.ghp}@github.com/o/r.git`],
    ["trailing punctuation", `use ${fake.ghp}.`],
  ])("flags a token in %s", (_label, text) => {
    expect(matchRules(text)).toEqual([{ rule: "credential-token", kind: "github" }]);
  });

  it.each([
    ["an underscore-joined name", "aws-access-key", `MY_KEY_${fake.akia}`],
    ["a trailing hyphen", "aws-access-key", `${fake.akia}-x`],
    ["a percent-encoded equals sign", "slack", `token%3D${fake.slackBot}`],
    ["a URL path", "anthropic", `/keys/${fake.anthropic}/x`],
    ["an admin key", "anthropic", "sk-ant-" + "admin01-" + alnum(93) + "AA"],
  ])("flags a token in %s for %s", (_label, kind, text) => {
    expect(matchRules(text)).toEqual([{ rule: "credential-token", kind }]);
  });

  it("ignores token-like runs glued inside a long base64 string", () => {
    const blob = (inner: string) => alnum(40) + "+" + alnum(7) + inner + "+" + alnum(30) + "==";
    for (const token of [fake.ghp, fake.akia, fake.slackBot]) {
      expect(matchRules(blob("9" + token))).toEqual([]);
      expect(matchRules(blob("+" + token))).toEqual([]);
      expect(matchRules(blob(token.slice(0, -1) + "+" + token.slice(-1)))).toEqual([]);
    }
  });

  it("ignores lockfile integrity hashes whose base64 holds token-like runs", () => {
    const blob = "x".repeat(10) + "AKIA" + "Z".repeat(16) + "9ghp_" + "A".repeat(36) + "q".repeat(8) + "==";
    expect(matchRules(`      integrity: sha512-${blob}`)).toEqual([]);
    expect(matchRules(`    "integrity": "sha512-${blob}",`)).toEqual([]);
  });

  it("reports each kind once per line, at its first offset", () => {
    const text = `a ${fake.akia} b ${fake.ghp} c ${fake.gho}`;
    expect(locateTokens(text)).toEqual([
      { kind: "github", offset: text.indexOf(fake.ghp) },
      { kind: "aws-access-key", offset: 2 },
    ]);
  });
});

describe("credential-token reporting", () => {
  const tokens = Object.values(fake);
  const diff = [
    "diff --git a/notes.md b/notes.md",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/notes.md",
    `@@ -0,0 +1,${tokens.length} @@`,
    ...tokens.map((token) => `+key: ${token}`),
  ].join("\n");
  const result = scan([parseDiff(diff)]);
  const report = formatReport(result.findings, { ...result, termsLoaded: false }).join("\n");

  it("names the location, rule and kind of each token", () => {
    expect(report).toContain("notes.md:1 credential-token github");
    expect(report).toContain("notes.md:7 credential-token anthropic");
    expect(report).toContain("notes.md:8 credential-token aws-access-key");
    expect(report).toContain("notes.md:10 credential-token slack");
    expect(report).toContain("notes.md:12 credential-token private-key");
    expect(report).toContain(`egress-scan: ${tokens.length} findings (home-path 0, aw-data-path 0, private-term 0, credential-token ${tokens.length})`);
  });

  it("never echoes a token or any run of its body", () => {
    for (const token of tokens) {
      expect(report).not.toContain(token);
      expect(report).not.toContain(token.slice(-12));
    }
  });
});
