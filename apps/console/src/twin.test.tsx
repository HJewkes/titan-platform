// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { snapshotKey, staticSource, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { TWIN_ROUTES } from "../server/twin/routes.js";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";
import { VIEW_KEYS } from "./router.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Entry = Pick<IntersectionObserverEntry, "target" | "isIntersecting">;

/** jsdom has no IntersectionObserver; this one sees every target at once, so each lazy frame asks for its answer. */
class SeeEverything {
  constructor(private readonly onChange: (entries: Entry[]) => void) {}
  observe(target: Element): void {
    this.onChange([{ target, isIntersecting: true }]);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", SeeEverything));

let snapshot: Snapshot;
const asked = new Set<string>();

beforeAll(async () => {
  snapshot = await twinSnapshot();
});

/** The twin's source, keeping the key of every call so a test can name the ones the snapshot cannot answer. */
function recordingSource(keys: string[]): DataSource {
  const inner = staticSource({ snapshot });
  return {
    call: (name, args, options) => {
      keys.push(snapshotKey(name, args ?? {}));
      return inner.call(name, args, options);
    },
    subscribe: (handlers, options) => inner.subscribe(handlers, options),
  };
}

const SETTLE_TICK_MS = 50;

/** A page asks for more once an answer lands (a round's frames after the round), so wait until a tick adds no call. */
async function settle(keys: readonly string[]): Promise<void> {
  for (let seen = -1; seen !== keys.length; ) {
    seen = keys.length;
    await act(() => new Promise((resolve) => setTimeout(resolve, SETTLE_TICK_MS)));
  }
}

describe("the twin fixtures", () => {
  it("name a route for every rail view", () => {
    const covered = new Set(TWIN_ROUTES.map((route) => route.hash.split(/[/?]/)[1] || "home"));
    expect(VIEW_KEYS.filter((view) => !covered.has(view))).toEqual([]);
  });

  it.each(TWIN_ROUTES)("answer every call $name makes", async ({ hash }) => {
    const keys: string[] = [];
    window.location.hash = hash;
    render(
      <RpcProvider source={recordingSource(keys)}>
        <App />
      </RpcProvider>,
    );
    await settle(keys);
    keys.forEach((key) => asked.add(key));
    expect(keys.filter((key) => !(key in snapshot.calls))).toEqual([]);
  });

  // Runs after the routes above; a fixture no route asks for is dead weight that drifts unseen.
  it("hold no answer that no route asks for", () => {
    expect(Object.keys(snapshot.calls).filter((key) => !asked.has(key))).toEqual([]);
  });
});
