import { describe, expect, it } from "vitest";
import { INGRESS_KINDS } from "../ingress/kinds.js";
import { RECONCILER_KINDS } from "../reconciler/kinds.js";
import { SOURCES_MODES, type SourcesMode } from "./mode.js";
import { SCENARIO_DELIVERIES, SCENARIO_RULESETS, deliver, loggedKinds, scenarioReconciler, scenarioSnapshot } from "./scenario.test-helpers.js";

type Table = readonly { kinds: readonly string[] }[];

const kindsOf = (table: Table): Set<string> => new Set(table.flatMap((row) => row.kinds));

/** TP-3099 I3: under webhook both sources write; under polling the reconciler alone does. */
function declaredKinds(mode: SourcesMode, reconciler: Table = RECONCILER_KINDS): Set<string> {
  return mode === "webhook" ? kindsOf([...INGRESS_KINDS, ...reconciler]) : kindsOf(reconciler);
}

/** The kinds a webhook deployment logs that a polling one cannot. */
const pollingGap = (reconciler: Table): string[] => [...declaredKinds("webhook", reconciler)].filter((kind) => !declaredKinds("polling", reconciler).has(kind)).sort();

/** Webhook: the ingress stores each delivery, then the backstop pass re-observes the same repo. Polling: the pass alone. */
async function runScenario(mode: SourcesMode): Promise<Set<string>> {
  const reconciler = scenarioReconciler({ snapshot: scenarioSnapshot(), rulesets: SCENARIO_RULESETS });
  if (mode === "webhook") deliver(reconciler.db, SCENARIO_DELIVERIES);
  await reconciler.service.tick();
  return loggedKinds(reconciler.db);
}

describe("declared kind sets (TP-3099 I3)", () => {
  it("are equal: kinds(webhook) = ingress ∪ reconciler, kinds(polling) = reconciler", () => {
    expect(declaredKinds("webhook")).toEqual(declaredKinds("polling"));
    expect(pollingGap(RECONCILER_KINDS)).toEqual([]);
  });

  it("go red when one kind is dropped from the reconciler table", () => {
    const declared = [...kindsOf(RECONCILER_KINDS)];

    const gaps = declared.map((dropped) => pollingGap(RECONCILER_KINDS.map((row) => ({ kinds: row.kinds.filter((kind) => kind !== dropped) }))));

    expect(gaps).toEqual(declared.map((dropped) => [dropped]));
  });
});

describe("logged kind sets after one synthetic scenario (TP-3099 I3)", () => {
  it("are the same under each mode", async () => {
    const [webhook, polling] = await Promise.all(SOURCES_MODES.map(runScenario));

    expect(webhook.size).toBeGreaterThan(0);
    expect(polling).toEqual(webhook);
  });

  it("are, under polling, every kind the reconciler table declares", async () => {
    expect(await runScenario("polling")).toEqual(kindsOf(RECONCILER_KINDS));
  });

  it("are, under webhook, every kind the ingress table declares before the backstop pass runs", () => {
    const reconciler = scenarioReconciler({ snapshot: scenarioSnapshot(), rulesets: SCENARIO_RULESETS });

    deliver(reconciler.db, SCENARIO_DELIVERIES);

    expect(loggedKinds(reconciler.db)).toEqual(kindsOf(INGRESS_KINDS));
  });
});
