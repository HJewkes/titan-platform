const inheritedConfigCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10) || 0;

/**
 * Environment for git calls against throwaway repos. The inherited env may carry a push hook
 * (GIT_CONFIG_COUNT entries) that refuses pushes to anything but the real remote; the extra
 * entry appended last wins, and /dev/null is not a directory, so no hook runs in the scratch repos.
 */
export const TEST_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: String(inheritedConfigCount + 1),
  [`GIT_CONFIG_KEY_${inheritedConfigCount}`]: "core.hooksPath",
  [`GIT_CONFIG_VALUE_${inheritedConfigCount}`]: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};
