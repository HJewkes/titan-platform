import { rmSync } from "node:fs";
import { afterAll } from "vitest";
import { runTtsConformance } from "../conformance.js";
import { loadKokoroEngine } from "./engine.js";
import { fakeEngine, filledCache, letterG2p } from "./fake-engine.test-helpers.js";
import { kokoroProvider } from "./provider.js";

// The cache passes the offline guard, so the missing peer is what the provider runs into.
const cacheDir = filledCache();
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

const missingPeer = (name: string): Promise<never> => Promise.reject(new Error(`Cannot find package '${name}'`));

// Mutations caught: speed not passed to the engine (pace unchanged); the engine call left outside the deadline.
runTtsConformance("kokoroProvider", {
  working: () => kokoroProvider({ g2p: letterG2p(), loadEngine: () => Promise.resolve(fakeEngine()) }),
  unavailable: () =>
    kokoroProvider({
      g2p: letterG2p(),
      cacheDir,
      loadEngine: (options) => loadKokoroEngine({ ...options, importModule: missingPeer }),
    }),
  hung: () => kokoroProvider({ g2p: letterG2p(), loadEngine: () => Promise.resolve(fakeEngine({ hang: true })) }),
});
