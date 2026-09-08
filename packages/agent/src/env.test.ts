import { describe, expect, it } from "vitest";
import {
  AuthMisconfiguredError,
  assertApiKeySourceAllowed,
  assertAuthEnvOk,
  prepareEnv,
} from "./env.js";

const OAUTH: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth" };

describe("prepareEnv", () => {
  const cases: Array<{ variable: string; value: string; kept: boolean; why: string }> = [
    { variable: "CLAUDECODE", value: "1", kept: false, why: "the child CLI refuses to start inside a parent session" },
    { variable: "CLAUDE_CODE_SSE_PORT", value: "9000", kept: false, why: "points at the parent session's transport" },
    { variable: "CLAUDE_CODE_ENTRYPOINT", value: "cli", kept: false, why: "describes the parent, not the child" },
    { variable: "CLAUDE_CODE_EXECPATH", value: "/usr/bin/claude", kept: false, why: "not on the passthrough allowlist" },
    { variable: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-oauth", kept: true, why: "the subscription credential" },
    { variable: "CLAUDE_CODE_USE_BEDROCK", value: "1", kept: true, why: "selects a cloud provider on purpose" },
    { variable: "CLAUDE_CODE_USE_VERTEX", value: "1", kept: true, why: "selects a cloud provider on purpose" },
    { variable: "CLAUDE_CODE_USE_FOUNDRY", value: "1", kept: true, why: "selects a cloud provider on purpose" },
    { variable: "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", value: "1", kept: true, why: "a deliberate opt-out" },
    { variable: "ANTHROPIC_API_KEY", value: "sk-ant", kept: false, why: "would silently outrank the OAuth token" },
    { variable: "ANTHROPIC_AUTH_TOKEN", value: "tok", kept: false, why: "same metered-billing path" },
    { variable: "HTTP_PROXY", value: "http://p", kept: false, why: "re-routes the child's API traffic" },
    { variable: "https_proxy", value: "http://p", kept: false, why: "lowercase spelling leaks the same way" },
    { variable: "ALL_PROXY", value: "socks://p", kept: false, why: "re-routes the child's API traffic" },
    { variable: "PATH", value: "/usr/bin", kept: true, why: "ordinary process environment" },
    { variable: "ANTHROPIC_MODEL", value: "opus", kept: true, why: "not a credential" },
  ];

  for (const { variable, value, kept, why } of cases) {
    it(`${kept ? "keeps" : "strips"} ${variable} because ${why}`, () => {
      const out = prepareEnv({ ...OAUTH, [variable]: value });
      expect(out[variable]).toBe(kept ? value : undefined);
    });
  }

  it("keeps the API key when the caller opts into API-key billing", () => {
    const out = prepareEnv({ ANTHROPIC_API_KEY: "sk-ant" }, { allowApiKeyBilling: true });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("defaults CLAUDE_CODE_MAX_RETRIES to 3 so an outage fails fast", () => {
    expect(prepareEnv(OAUTH).CLAUDE_CODE_MAX_RETRIES).toBe("3");
  });

  it("respects an explicit retry count", () => {
    expect(prepareEnv({ ...OAUTH, CLAUDE_CODE_MAX_RETRIES: "7" }).CLAUDE_CODE_MAX_RETRIES).toBe("7");
  });

  it("does not mutate the environment it was given", () => {
    const source: NodeJS.ProcessEnv = { ...OAUTH, CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-ant" };
    prepareEnv(source);
    expect(source.CLAUDECODE).toBe("1");
    expect(source.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("drops variables whose value is undefined", () => {
    expect("EMPTY" in prepareEnv({ ...OAUTH, EMPTY: undefined })).toBe(false);
  });
});

describe("assertAuthEnvOk", () => {
  it("passes when the OAuth token is present and no API key survived", () => {
    expect(() => assertAuthEnvOk(prepareEnv(OAUTH))).not.toThrow();
  });

  it("rejects a missing OAuth token on the subscription path", () => {
    expect(() => assertAuthEnvOk(prepareEnv({}))).toThrow(/CLAUDE_CODE_OAUTH_TOKEN is not set/);
  });

  it("rejects a leaked API key on the subscription path", () => {
    expect(() => assertAuthEnvOk({ ...OAUTH, ANTHROPIC_API_KEY: "sk-ant" } as Record<string, string>)).toThrow(
      /survived the scrub/,
    );
  });

  it("requires a credential when API-key billing is requested", () => {
    expect(() => assertAuthEnvOk({}, { allowApiKeyBilling: true })).toThrow(/neither ANTHROPIC_API_KEY/);
  });

  it("accepts the API-key path when the key is present", () => {
    expect(() => assertAuthEnvOk({ ANTHROPIC_API_KEY: "sk-ant" }, { allowApiKeyBilling: true })).not.toThrow();
  });

  it("carries a hint on the leaked-key error", () => {
    try {
      assertAuthEnvOk({ ...OAUTH, ANTHROPIC_API_KEY: "sk-ant" } as Record<string, string>);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AuthMisconfiguredError);
      expect((error as AuthMisconfiguredError).hint).toMatch(/allowApiKeyBilling/);
    }
  });
});

describe("assertApiKeySourceAllowed", () => {
  it.each(["none", "oauth", "apiKeyHelper", "/login managed key", "some-future-source"])(
    "allows %s because the guard is a blacklist, not a whitelist",
    (source) => {
      expect(() => assertApiKeySourceAllowed(source)).not.toThrow();
    },
  );

  it.each(["ANTHROPIC_API_KEY", "env"])("forbids %s", (source) => {
    expect(() => assertApiKeySourceAllowed(source)).toThrow(/env-based API-key billing/);
  });

  it("refuses to pass an unverifiable session", () => {
    expect(() => assertApiKeySourceAllowed(undefined)).toThrow(/no apiKeySource/);
  });
});
