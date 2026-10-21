import type { CallClass, PoolStateStore } from "@titan-design/github";

type ClassHealth = { state: "open" | "closed" | "probed" | "auth"; resetAt: string | null };

/** Health's `githubApi` field: each call class's state, with `auth` over all of them while the token is rejected. */
export type GithubApiHealth = Record<CallClass, ClassHealth>;

interface GithubApiStatus {
  /** The pool's `onAuthFailed`: one ops-alarm line per transition into auth, never per call. */
  onAuthFailed(identity: string): void;
  /** Called beside the pool's `tokenChanged`, which leaves auth state. */
  tokenChanged(): void;
  health(): GithubApiHealth;
}

interface GithubApiStatusOptions {
  identity: string;
  store: PoolStateStore;
  log?: (line: string) => void;
}

/** Auth is held here in memory, as the pool holds it: no probe can clear it, because `/rate_limit` under a rejected token is also 401. */
export function githubApiStatus({ identity, store, log = console.error }: GithubApiStatusOptions): GithubApiStatus {
  let auth = false;
  return {
    onAuthFailed(failed) {
      if (auth) return;
      auth = true;
      log(`factory: ops-alarm github-auth identity=${failed}`);
    },
    tokenChanged() {
      auth = false;
    },
    health() {
      const of = (callClass: CallClass) => (auth ? AUTH : classHealth(store, identity, callClass));
      return { "core-read": of("core-read"), graphql: of("graphql"), mutation: of("mutation") };
    },
  };
}

const AUTH: ClassHealth = { state: "auth", resetAt: null };

function classHealth(store: PoolStateStore, identity: string, callClass: CallClass): ClassHealth {
  const pair = store.get(identity, callClass);
  if (pair === undefined || pair.state === "open") return { state: "open", resetAt: null };
  return { state: pair.state, resetAt: new Date(pair.resetAt).toISOString() };
}
