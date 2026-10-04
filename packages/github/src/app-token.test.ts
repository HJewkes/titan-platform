import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appInstallationToken, signAppJwt } from "./app-token.js";
import type { GhExec, GhExecOptions, GhResult } from "./exec.js";
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

    const attempt = appInstallationToken({ ...credentials, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----" }, gh.exec);

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
