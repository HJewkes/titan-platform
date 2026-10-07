/** A leaf module: a constant shared across files that import each other must not be evaluated through an import cycle. */

/** How long a GitHub, daemon or broker read that keeps failing is waited out before a step gives up to the owner. */
export const GITHUB_READ_GIVE_UP_MS = 60 * 60_000;
