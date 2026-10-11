// Synthetic tokens only. Each is assembled at runtime so no token-shaped literal sits in the
// repository, and each carries CANARY so a test can prove it never leaks.
export const CANARY = "CANARY";

const tail = (seed: string): string => `${CANARY}${seed}${"Zq9_".repeat(12)}`;

export const FAKE_ACCESS_TOKEN = ["sk", "ant", "oat01", tail("access")].join("-");
export const FAKE_REFRESH_TOKEN = ["sk", "ant", "ort01", tail("refresh")].join("-");
export const FAKE_JWT = ["eyJ" + tail("head"), tail("body"), tail("sig")].join(".");
export const FAKE_OPAQUE = tail("opaque");

export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
export const HOUR = 3_600_000;

export function fakeCredentials(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claudeAiOauth: {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      expiresAt: NOW + 2 * HOUR,
      refreshTokenExpiresAt: NOW + 30 * 24 * HOUR,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      ...overrides,
    },
  };
}
