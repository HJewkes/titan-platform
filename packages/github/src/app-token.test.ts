import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appInstallationToken, signAppJwt } from "./app-token.js";
import { redact, redactStreams } from "./redact.js";
import { GhError, type GhExec, type GhExecOptions, type GhResult } from "./exec.js";
import { fakeGitHub, fakeSha, FAKE_APP_ID } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { rateBudget } from "./budget.js";
import { githubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const NOW = Date.parse("2026-03-01T12:00:00Z");
const REPO = "octo/demo";
const HEAD = fakeSha("head");
const TOKEN = "ghs_installation_secret_token";

interface Call {
  args: readonly string[];
  input?: string;
  options?: GhExecOptions;
}

function scripted(answer: (call: Call) => GhResult): { exec: GhExec; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, exec: async (args, input, options) => (calls.push({ args, input, options }), answer({ args, input, options })) };
}

// Built at runtime so the repo never holds a literal PEM private-key header.
const pemBlock = (label: string, body: string) => ["BEGIN", "END"].map((edge) => `-----${edge} ${label}-----`).join(`\n${body}\n`);
const ok = (body: unknown): GhResult => ({ code: 0, stdout: `HTTP/2.0 201 Created\r\n\r\n${JSON.stringify(body)}`, stderr: "" });
const credentials = { appId: 77, installationId: 9, privateKeyPem: PEM, now: () => NOW };
const request = { name: "shepherd", headSha: HEAD, conclusion: "success" as const, title: "Done", summary: "All good", externalId: "x-1" };

describe("appInstallationToken", () => {
  it("signs an RS256 JWT that verifies, issued 60 s back and valid under 10 minutes", () => {
    const [header, payload, signature] = signAppJwt(77, PEM, NOW).split(".") as [string, string, string];

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const verified = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"));
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(verified).toBe(true);
    expect(claims.iss).toBe("77");
    expect(claims.iat).toBe(NOW / 1000 - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.exp * 1000).toBeGreaterThan(NOW);
  });

  it("exchanges the JWT through the child env only, never argv", async () => {
    const gh = scripted(() => ok({ token: TOKEN, expires_at: "2026-03-01T13:00:00Z" }));

    const result = await appInstallationToken(credentials, gh.exec);

    expect(result).toEqual({ token: TOKEN, expiresAtMs: Date.parse("2026-03-01T13:00:00Z") });
    expect(gh.calls[0]!.args).toEqual(["api", "-i", "-X", "POST", "app/installations/9/access_tokens"]);
    expect(gh.calls[0]!.options?.env?.GH_TOKEN?.split(".")).toHaveLength(3);
    expect(gh.calls[0]!.args.join(" ")).not.toContain(gh.calls[0]!.options!.env!.GH_TOKEN!);
  });

  it("refuses a malformed key before any gh call, without echoing the key", async () => {
    const gh = scripted(() => ok({}));

    const attempt = appInstallationToken({ ...credentials, privateKeyPem: pemBlock("PRIVATE KEY", "bm90LWEta2V5") }, gh.exec);

    await expect(attempt).rejects.toBeInstanceOf(GitHubInputError);
    await expect(attempt).rejects.not.toThrow(/bm90LWEta2V5/);
    expect(gh.calls).toEqual([]);
  });

  it("refuses an exchange that answers an already expired token", async () => {
    const gh = scripted(() => ok({ token: TOKEN, expires_at: "2026-03-01T11:59:00Z" }));

    const attempt = appInstallationToken(credentials, gh.exec);

    await expect(attempt).rejects.toThrow(/already expired/);
    await expect(attempt).rejects.not.toThrow(new RegExp(TOKEN));
  });

  it("never echoes stdout, so a token in a failed or status-less answer stays out of the error", async () => {
    const failed = scripted(() => ({ code: 1, stdout: `HTTP/2.0 201 Created\r\n\r\n{"token":"${TOKEN}"}`, stderr: "" }));
    const bare = scripted(() => ({ code: 0, stdout: `{"token":"${TOKEN}"}`, stderr: "" }));
    const leaky = scripted(() => ({ code: 1, stdout: `{"token":"${TOKEN}"}`, stderr: `boom ${TOKEN}` }));

    for (const gh of [failed, bare, leaky]) {
      const error = await appInstallationToken(credentials, gh.exec).catch((caught: Error) => caught);
      expect((error as Error).message).toContain("installation token exchange failed");
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("redacts the JWT from an exec that throws while quoting its env", async () => {
    const exec: GhExec = async (_args, _input, options) => {
      throw new Error(`spawn failed with env ${JSON.stringify(options!.env)}`);
    };

    const error = await appInstallationToken(credentials, exec).catch((caught: Error) => caught);

    expect((error as Error).message).toContain("could not run");
    expect((error as Error).message).not.toMatch(/eyJ/);
  });

  it("refuses a body that is not JSON without echoing it", async () => {
    const gh = scripted(() => ({ code: 0, stdout: `HTTP/2.0 201 Created\r\n\r\nnot json ${TOKEN}`, stderr: "" }));

    const error = await appInstallationToken(credentials, gh.exec).catch((caught: Error) => caught);

    expect((error as Error).message).toMatch(/not JSON/);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("refuses a non-RSA key", async () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const gh = scripted(() => ok({}));

    await expect(appInstallationToken({ ...credentials, privateKeyPem: ec }, gh.exec)).rejects.toBeInstanceOf(GitHubInputError);
    expect(gh.calls).toEqual([]);
  });

  it("redacts the JWT and the PEM from a failed exchange", async () => {
    const gh = scripted(({ options }) => ({ code: 1, stdout: "", stderr: `gh: Bad credentials ${options!.env!.GH_TOKEN} ${PEM} (HTTP 401)` }));

    const error = await appInstallationToken(credentials, gh.exec).catch((caught: Error) => caught);

    const jwt = gh.calls[0]!.options!.env!.GH_TOKEN!;
    expect((error as Error).message).toContain("HTTP");
    expect((error as Error).message).not.toContain(jwt);
    expect((error as Error).message).not.toContain(PEM);
    expect((error as Error).message).not.toContain(PEM.split("\n")[1]!);
  });
});

describe("createCheckRun", () => {
  const wireWith = (gh: { exec: GhExec }, appToken = async () => TOKEN) => ghCliWire(gh.exec, { budget: rateBudget(), appToken });

  it("posts a completed run with the token in the child env of that call only", async () => {
    const gh = scripted(() => ok({ id: 55 }));
    const before = process.env.GH_TOKEN;

    const result = await githubPort(wireWith(gh)).createCheckRun(REPO, request);

    const call = gh.calls[0]!;
    expect(result).toEqual({ id: 55 });
    expect(call.args).toEqual(["api", "-i", "-X", "POST", `repos/${REPO}/check-runs`, "--input", "-"]);
    expect(JSON.parse(call.input!)).toEqual({ name: "shepherd", head_sha: HEAD, status: "completed", conclusion: "success", external_id: "x-1", output: { title: "Done", summary: "All good" } });
    expect(call.options?.env).toEqual({ GH_TOKEN: TOKEN });
    expect(call.args.join(" ")).not.toContain(TOKEN);
    expect(process.env.GH_TOKEN).toBe(before);
  });

  it("refuses a conclusion outside the three before any exec", async () => {
    const gh = scripted(() => ok({ id: 1 }));
    const port = githubPort(wireWith(gh));

    for (const conclusion of ["neutral", "cancelled", "SUCCESS", ""]) {
      const attempt = port.createCheckRun(REPO, { ...request, conclusion: conclusion as "success" });
      await expect(attempt).rejects.toBeInstanceOf(GitHubInputError);
    }

    expect(gh.calls).toEqual([]);
  });

  it("keeps the token out of an error and out of anything logged", async () => {
    const gh = scripted(({ options }) => ({ code: 1, stdout: "", stderr: `gh: Resource not accessible with ${options!.env!.GH_TOKEN} (HTTP 403)` }));
    const logged: string[] = [];
    const spies = (["log", "error", "warn"] as const).map((level) => ({ level, original: console[level] }));
    for (const { level } of spies) console[level] = (...parts: unknown[]) => void logged.push(parts.join(" "));

    const error = await githubPort(wireWith(gh)).createCheckRun(REPO, request).catch((caught: Error) => caught);
    for (const { level, original } of spies) console[level] = original;

    expect((error as Error).message).toContain("HTTP 403");
    expect([(error as Error).message, (error as Error).stack ?? "", ...logged].join("\n")).not.toContain(TOKEN);
    expect(PEM).not.toContain(TOKEN);
  });

  it("keeps the HTTP status on a rethrown failure and redacts a rejecting token provider", async () => {
    const gh = scripted(() => ({ code: 1, stdout: "", stderr: `gh: nope ${TOKEN} (HTTP 422)` }));

    const failure = await githubPort(wireWith(gh)).createCheckRun(REPO, request).catch((caught: GhError) => caught);
    const minting = await githubPort(wireWith(gh, async () => { throw new Error("mint failed"); })).createCheckRun(REPO, request).catch((caught: Error) => caught);

    expect(failure).toBeInstanceOf(GhError);
    expect((failure as GhError).status).toBe(422);
    expect((failure as GhError).message).not.toContain(TOKEN);
    expect((minting as Error).message).toBe("mint failed");
  });

  it("refuses when the wire has no token provider", async () => {
    const gh = scripted(() => ok({ id: 1 }));

    const attempt = githubPort(ghCliWire(gh.exec, { budget: rateBudget() })).createCheckRun(REPO, request);

    await expect(attempt).rejects.toThrow(/token provider/);
    expect(gh.calls).toEqual([]);
  });
});

describe("fake createCheckRun round trip", () => {
  it("records the run under the configured app id so latestCheckRuns returns it", async () => {
    const fake = fakeGitHub({ appId: 31337 });
    const port = githubPort(fake.wire);

    const { id } = await port.createCheckRun(REPO, request);
    const latest = await port.latestCheckRuns(REPO, HEAD);

    expect(fake.createdCheckRuns).toEqual([{ id, repo: REPO, request }]);
    expect(latest).toMatchObject([{ id, name: "shepherd", status: "completed", conclusion: "success", appId: 31337, headSha: HEAD }]);
  });

  it("defaults the app id and refuses a bad conclusion before the wire", async () => {
    const fake = fakeGitHub();
    const port = githubPort(fake.wire);

    await expect(port.createCheckRun(REPO, { ...request, conclusion: "neutral" as "success" })).rejects.toBeInstanceOf(GitHubInputError);
    await port.createCheckRun(REPO, request);

    expect(fake.calls).toEqual(["createCheckRun"]);
    expect((await port.checkRuns(REPO, HEAD))[0]?.appId).toBe(FAKE_APP_ID);
  });
});

describe("token shape scrub", () => {
  const SHAPED = "ghs_" + "A1b2C3d4".repeat(5);
  const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2ln-nature_x";
  const exchange = (stdout: string, stderr: string) => appInstallationToken(credentials, scripted(() => ({ code: 1, stdout, stderr })).exec).catch((caught: Error) => caught.message);
  const checkRun = (result: GhResult, appToken = async () => TOKEN) =>
    githubPort(ghCliWire(scripted(() => result).exec, { budget: rateBudget(), appToken })).createCheckRun(REPO, request).catch((caught: Error) => caught);

  it("scrubs a bare token in stderr with empty stdout, with or without a newline", async () => {
    for (const echoed of [`denied ${SHAPED}`, `denied ${SHAPED}\n`, `denied ${JWT}\n`]) {
      expect(await exchange("", echoed)).not.toMatch(/ghs_A1b2|eyJhbGci/);
      const error = (await checkRun({ code: 1, stdout: "", stderr: echoed })) as GhError;
      expect(error.result.stderr).not.toMatch(/ghs_A1b2|eyJhbGci/);
    }
  });

  it("scrubs escaped JSON that never forms a closed token pair", async () => {
    const message = await exchange(`{\\"token\\":\\"${SHAPED}`, `{\\"token\\":\\"${SHAPED}\\"}`);

    expect(message).toContain("[redacted]");
    expect(message).not.toContain("ghs_A1b2");
  });

  it("cuts a token split across stdout and stderr from both halves", () => {
    const [out, err] = redactStreams(`partial ${SHAPED.slice(0, 15)}`, `${SHAPED.slice(15)} tail`, []);

    expect(out + err).not.toMatch(/A1b2/);
    expect(out).toBe("partial [redacted]");
    expect(err).toBe("[redacted] tail");
  });

  it("redacts a token quoted by a rejecting appToken provider", async () => {
    const error = await checkRun(ok({ id: 1 }), async () => { throw new Error(`mint failed for ${SHAPED}`); });

    expect((error as Error).message).toBe("mint failed for [redacted]");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("gh: not found at api.github.com/repos/a.b", [])).toBe("gh: not found at api.github.com/repos/a.b");
  });

  it("keeps dotted names that only open like a JWT, and still redacts a real JWT", () => {
    expect(redact("load eyJson.config.js and keyJar.x.y", [])).toBe("load eyJson.config.js and keyJar.x.y");
    expect(redact(`bearer ${JWT}`, [])).toBe("bearer [redacted]");
  });

  it("redacts a classic 40-hex token after a token keyword, in any case, and leaves a bare sha alone", () => {
    const hex = "0123456789abcdef".repeat(3).slice(0, 40);

    for (const line of [`token ${hex}`, `Authorization: token ${hex}`, `BEARER ${hex}`, `{"token": "${hex}"}`]) {
      expect(redact(line, [])).not.toContain(hex);
    }
    expect(redact(`commit ${hex}`, [])).toBe(`commit ${hex}`);
  });

  it("redacts a token whose underscore is URL-encoded", () => {
    expect(redact(`next=${SHAPED.replace("_", "%5F")}&x=1`, [])).toBe("next=[redacted]&x=1");
    expect(redact(`next=${SHAPED.replace("_", "%5f")}`, [])).toBe("next=[redacted]");
  });

  it("cuts the first word of stderr with a whole token ending stdout, since the token may go on there", () => {
    const [out, err] = redactStreams(`minted ${SHAPED}`, "gh: Not Found (HTTP 404)", []);

    expect(out).toBe("minted [redacted]");
    expect(err).toBe("[redacted]: Not Found (HTTP 404)");
  });

  it("cuts a token split by a newline at the end of stdout from both halves", () => {
    const [out, err] = redactStreams(`partial ${SHAPED.slice(0, 15)}\n`, `${SHAPED.slice(15)} tail`, []);

    expect(out).toBe("partial [redacted]");
    expect(err).toBe("[redacted] tail");
  });

  it("cuts an exact secret from both streams wherever it is split across the seam", () => {
    for (const secret of ["secret", "s3cr3t-Value_with.mixed+chars/0123456789"]) {
      for (let at = 1; at < secret.length; at++) {
        for (const newline of ["", "\n"]) {
          const [out, err] = redactStreams(`my ${secret.slice(0, at)}${newline}`, `${secret.slice(at)} here`, [secret]);

          expect(out).toBe("my [redacted]");
          expect(err).toBe("[redacted] here");
          expect(`${out}${err}`).not.toContain(secret);
        }
      }
    }
  });

  it("cuts a secret that contains whitespace wherever it is split, including at the whitespace", () => {
    const pem = "-----BEGIN KEY-----\nQUJDREVGRw\nSElKS0xNTg\n-----END KEY-----\n";
    for (const secret of ["sec ret", "sec\nret", " secret", "secret ", "a b c d", pem]) {
      for (let at = 1; at < secret.length; at++) {
        // A newline added at a whitespace seam is a different byte sequence from the secret, so only the bare split is the secret.
        const atWhitespace = /\s/.test(secret.slice(at - 1, at + 1));
        for (const newline of atWhitespace ? [""] : ["", "\n"]) {
          const [out, err] = redactStreams(`my ${secret.slice(0, at)}${newline}`, `${secret.slice(at)} ###`, [secret]);
          const shown = [out, err].map((text) => text.replaceAll("[redacted]", ""));

          for (let i = 0; i + 2 <= secret.length; i++) {
            const fragment = secret.slice(i, i + 2);
            if (fragment.trim().length < 2) continue;
            for (const text of shown) expect(text).not.toContain(fragment);
          }
        }
      }
    }
  });

  it("cuts a token whole when a straddling secret sits inside it", () => {
    const hexToken = "0123456789abcdef0123456789abcdef01234567";

    expect(redactStreams(`token: ${hexToken.slice(0, 20)}`, `${hexToken.slice(20)} tail`, ["23456"])).toEqual(["token: [redacted]", "[redacted] tail"]);
    expect(redactStreams(`x ${SHAPED.slice(0, 8)}`, `${SHAPED.slice(8)} tail`, [SHAPED.slice(6, 10)])).toEqual(["x [redacted]", "[redacted] tail"]);
  });

  it("cuts two overlapping secrets split by whitespace at the seam from both streams", () => {
    expect(redactStreams("x abc \n", "def y", ["c \nd", "abcdef"])).toEqual(["x [redacted]", "[redacted] y"]);
  });

  it("throws a REST error whose message carries neither half of a split token", async () => {
    for (const stdout of [`partial ${SHAPED.slice(0, 15)}`, `partial ${SHAPED.slice(0, 15)}\n`]) {
      const result = { code: 1, stdout, stderr: `${SHAPED.slice(15)} (HTTP 403)` };
      const error = await githubPort(ghCliWire(scripted(() => result).exec, { budget: rateBudget() })).getPr(REPO, 7).catch((caught: Error) => caught);

      expect(error).toBeInstanceOf(GhError);
      expect((error as GhError).message).toMatch(/failed \(1\): \[redacted\] \(HTTP 403\)$/);
      expect((error as GhError).message).not.toMatch(/A1b2|C3d4/);
    }
  });

  it("redacts a token quoted in a GraphQL error message", async () => {
    const body = { errors: [{ message: `bad credential ${SHAPED}` }] };
    const exec = scripted(() => ({ code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`, stderr: "" })).exec;

    await expect(githubPort(ghCliWire(exec, { budget: rateBudget() })).listReviewComments(REPO, 7)).rejects.toThrow(/bad credential \[redacted\]$/);
  });

  describe("TP-1500 gaps", () => {
    const hex = "0123456789abcdef".repeat(3).slice(0, 40);
    const throwsWith = async (stdout: string, stderr: string): Promise<string> => {
      const exec = scripted(() => ({ code: 1, stdout, stderr })).exec;
      const error = await githubPort(ghCliWire(exec, { budget: rateBudget() })).getPr(REPO, 7).catch((caught: Error) => caught);
      return (error as GhError).message;
    };

    it.each([
      [`GH_TOKEN=${hex}`],
      [`GITHUB_TOKEN: ${hex}`],
      [`{"access_token":"${hex}"}`],
      [`https://${hex}@github.com/o/r`],
      [`https://x-access-token:${hex}@github.com/o/r`],
    ])("redacts a 40-hex token in %s", async (line) => {
      const message = await throwsWith("", line);

      expect(message).not.toContain(hex);
      expect(message).toContain("[redacted]");
    });

    it("redacts a JWT right after an underscore and keeps a dotted file name that only opens like one", () => {
      expect(redact(`X_${JWT}`, [])).toBe("X_[redacted]");
      expect(redact("see eyJsonwebtoken.config.js", [])).toBe("see eyJsonwebtoken.config.js");
    });

    it("keeps a bare commit sha and a sha in a URL path", () => {
      expect(redact(`sha ${hex} https://github.com/o/r/commit/${hex}`, [])).toBe(`sha ${hex} https://github.com/o/r/commit/${hex}`);
    });

    it.each([
      [`partial ${SHAPED.slice(0, 15)}\n\n`, `${SHAPED.slice(15)} (HTTP 403)`],
      [`partial ${SHAPED.slice(0, 15)} \n`, `${SHAPED.slice(15)} (HTTP 403)`],
      [`partial ${SHAPED.slice(0, 15)}\n`, `\n${SHAPED.slice(15)} (HTTP 403)`],
      [`Authorization: Bearer `, `${hex} (HTTP 403)`],
    ])("scrubs a token split across %j and %j", async (stdout, stderr) => {
      const message = await throwsWith(stdout, stderr);

      expect(message).not.toMatch(/A1b2|C3d4|0123456789abcdef/);
      expect(message).toContain("(HTTP 403)");
    });

    it("redacts a token in the Link next URL of a refused page", async () => {
      const link = `<https://evil.example/p?access_token=${hex}>; rel="next"`;
      const exec = scripted(() => ({ code: 0, stdout: `HTTP/2.0 200 OK\r\nLink: ${link}\r\n\r\n[]`, stderr: "" })).exec;

      const error = await ghCliWire(exec, { budget: rateBudget() }).listIssueComments(REPO, 7).catch((caught: Error) => caught);

      expect((error as Error).message).toContain("refusing to follow");
      expect((error as Error).message).not.toContain(hex);
    });
  });

  describe("TP-1504 gaps", () => {
    const hex = "0123456789abcdef".repeat(3).slice(0, 40);
    const SHORT_JWT = "eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJlLXg";
    const throwsWith = async (stdout: string, stderr: string): Promise<string> => {
      const exec = scripted(() => ({ code: 1, stdout, stderr })).exec;
      const error = await githubPort(ghCliWire(exec, { budget: rateBudget() })).getPr(REPO, 7).catch((caught: Error) => caught);
      return (error as GhError).message;
    };

    it.each([
      [`https://${hex}:x-oauth-basic@github.com/o/r`, hex],
      [`next?a=1%26token=${hex}`, hex],
      [`access_token%3D${hex}`, hex],
      [`Authorization: Bearer%20${SHORT_JWT}`, "c2lnbmF0dXJl"],
      [`Bearer%20${JWT}`, "eyJhbGci"],
      [`token:       ${hex}`, hex],
      [`token${" ".repeat(40)}${hex}`, hex],
      [`GH_TOKEN ${hex}`, hex],
    ])("redacts the secret in the thrown message for %s", async (line, secret) => {
      const message = await throwsWith("", line);

      expect(message).not.toContain(secret);
      expect(message).toContain("[redacted]");
    });

    it.each([
      ["GH_TOKEN", `=${hex} (HTTP 403)`],
      ["tok", `en=${hex} (HTTP 403)`],
      ["warning: GH_TOKEN\n", `: ${hex} (HTTP 403)`],
    ])("scrubs a keyword ending stdout and a hex run inside stderr: %j | %j", async (stdout, stderr) => {
      const message = await throwsWith(stdout, `${stderr}`);

      expect(message).not.toContain(hex);
      expect(message).toContain("(HTTP 403)");
    });

    it("keeps the text between a split keyword and its hex run", () => {
      expect(redactStreams("GH_TOKEN", `=${hex} tail`, [])).toEqual(["GH_TOKEN", "=[redacted] tail"]);
    });

    it("redacts a JWT with a short payload and keeps dotted file names that only open like one", () => {
      expect(redact(`jwt ${SHORT_JWT}`, [])).toBe("jwt [redacted]");
      expect(redact("see eyJsonwebtoken.config.js and eyJsonwebtoken.e30.ts", [])).toBe("see eyJsonwebtoken.config.js and eyJsonwebtoken.e30.ts");
    });

    it("scans a megabyte of whitespace after a keyword in linear time", () => {
      for (const keyword of ["bearer", "token", "bearer token"]) {
        const text = `${keyword}${" ".repeat(1 << 20)}`;
        const started = performance.now();

        expect(redact(text, [])).toBe(text);
        expect(performance.now() - started).toBeLessThan(100);
      }
    });

    it("redacts a hex run past any gap or userinfo length that the unbounded forms redacted before", () => {
      const user = "u".repeat(5000);

      for (const line of [`bearer token${" ".repeat(65)}${hex}`, `token:${" ".repeat(64)}${hex}`, `token:${" ".repeat(65)}${hex}`, `token${" ".repeat(5000)}${hex}`, `https://${user}:${hex}@h`]) {
        expect(redact(line, [])).not.toContain(hex);
      }
    });

    it("keeps the text around a gap-bound or userinfo redaction", () => {
      expect(redact(`x token:${" ".repeat(70)}${hex} y`, [])).toBe(`x token:${" ".repeat(70)}[redacted] y`);
      expect(redact(`https://${"u".repeat(300)}:${hex}@h/p`, [])).toBe(`https://${"u".repeat(300)}:[redacted]@h/p`);
    });

    it("scans a chain of hex runs with colons in linear time", () => {
      for (const unit of [`${hex}:`, `${hex}:x`, `${hex}@`]) {
        const text = unit.repeat((1 << 19) / unit.length);
        const started = performance.now();

        redact(text, []);
        expect(performance.now() - started).toBeLessThan(2000);
      }
    });

    it("keeps a dotted snapshot file name that only opens like a JWT", () => {
      expect(redact("see eyJsonwebtoken.spec.snapshot_file", [])).toBe("see eyJsonwebtoken.spec.snapshot_file");
    });

    it("scans a megabyte of letters and hex in linear time", () => {
      for (const filler of ["a", "z", "ab.", "x:"]) {
        const text = filler.repeat((1 << 20) / filler.length);
        const started = performance.now();

        redact(text, []);
        expect(performance.now() - started).toBeLessThan(2000);
      }
    });
  });

  describe("TP-1509 gaps", () => {
    const hex = "0123456789abcdef".repeat(3).slice(0, 40);

    it.each(["-eyJaaaaaaaaaaaa", "_eyJaaaaaaaaaaaa"])("scans %j repeated to 128 KB in linear time", (unit) => {
      const text = unit.repeat((1 << 17) / unit.length);
      const started = performance.now();

      expect(redact(text, [])).toBe(text);
      expect(performance.now() - started).toBeLessThan(100);
    });

    it("scans a megabyte of JWT-shaped runs, with and without dots, in linear time", () => {
      for (const unit of ["-eyJaaaaaaaaaaaa", "-eyJaaaaaaaaaaaa.", "eyJaaaaaaaaaaaa.e30.", "x.aaaaaaaaaaaa"]) {
        const text = unit.repeat((1 << 20) / unit.length);
        const started = performance.now();

        redactStreams(text, text, []);
        expect(performance.now() - started).toBeLessThan(2000);
      }
    });

    it("scans a megabyte of text for a hundred exact secrets, some present, in linear time", () => {
      const secrets = [...Array.from({ length: 99 }, (_, i) => `secret-${i}-aaaaaaaaaaaa`), "needle-xyz"];
      const text = `${"aaaaaaa ".repeat(127)}needle-xyz `.repeat(1024);
      const started = performance.now();

      const [out, err] = redactStreams(text, text, secrets);

      expect(performance.now() - started).toBeLessThan(2000);
      expect(`${out}${err}`).not.toContain("needle-xyz");
    });

    it("redacts a JWT behind a run of JWT-shaped words from its first header", () => {
      expect(redact(`x ${"-eyJaaaaaaaaaaaa".repeat(4)}.e30.c2lnbmF0dXJlLXg y`, [])).toBe("x -[redacted] y");
      expect(redact(`${JWT}.${JWT}`, [])).not.toMatch(/eyJ|c2ln/);
    });

    it.each([
      [`https://${hex}`, ":x-oauth-basic@h", ["https://[redacted]", ":x-oauth-basic@h"]],
      [`https://u:${hex}`, "@h", ["https://u:[redacted]", "@h"]],
      [`https://u:${hex}\n`, "@github.com/o/r", ["https://u:[redacted]", "@github.com/o/r"]],
    ])("redacts URL userinfo that only stderr completes: %j | %j", (stdout, stderr, expected) => {
      expect(redactStreams(stdout, stderr, [])).toEqual(expected);
    });

    it.each(
      [SHAPED, "ghp_" + "Z9y8X7w6".repeat(5), "github_pat_" + "11ABCDEFG0".repeat(8) + "xy"].flatMap((token) =>
        [`token: ${hex} (HTTP 401)`, `\ntoken ${hex} (HTTP 401)`, `bearer ${hex} (HTTP 401)`, `GH_TOKEN=${hex} (HTTP 401)`, `https://${hex}@h`].map((stderr) => [token, stderr]),
      ),
    )("keeps the stderr token redacted behind its keyword or scheme when stdout ends in %s: %j", (token, stderr) => {
      const [out, err] = redactStreams(`minted ${token}`, stderr, []);

      expect(out).toBe("minted [redacted]");
      expect(err).not.toContain(hex);
      expect(err).toContain("[redacted]");
    });

    it("redacts the tail of a token split anywhere after its prefix", () => {
      for (let cut = 4; cut < SHAPED.length; cut++) {
        const [out, err] = redactStreams(`partial ${SHAPED.slice(0, cut)}`, `${SHAPED.slice(cut)} tail`, []);

        expect([out, err]).toEqual(["partial [redacted]", "[redacted] tail"]);
      }
    });
  });
});
