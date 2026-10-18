import type { WorkflowRun, WorkflowStatus } from "@titan-design/workflow";
import type { FactoryHost, PendingGate } from "../host.js";
import { sliceClock } from "../loop-slice.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { watchRow, type WatchRow } from "./view.js";

/** The run's watch row; a caller reading many rows passes the pending gates it read once. */
export function rowOf(host: FactoryHost, services: ShepherdServices, registration: Registration, run: WorkflowRun, pendingGates: readonly PendingGate[] = host.pendingGates()): WatchRow {
  const pending = pendingGates.find((gate) => gate.runId === run.id);
  const train = services.train?.get().holder(registration.repo);
  return watchRow({ registration, run, ...(pending && { pending: { gate: pending.gate } }), ...(train && { train }) });
}

const FINISHED_RUN: ReadonlySet<WorkflowStatus> = new Set(["completed", "failed", "cancelled"]);

/** A run that ended, so its watch row reads done, failed or cancelled. */
export const runFinished = (status: WorkflowStatus): boolean => FINISHED_RUN.has(status);

export interface RowWithRun {
  row: WatchRow;
  run: WorkflowRun;
  registration: Registration;
}

/** Which registrations a read wants, judged from the registration and its run's status before the run is loaded. */
type RowFilter = (registration: Registration, status: WorkflowStatus) => boolean;

/**
 * Each wanted registration's watch row beside the run it was read from; a registration whose run is missing is left out.
 * Only the runs `keep` wants are loaded, since every run's step results together take most of a second to parse, and
 * the loop yields the event loop between slices so serve keeps answering while it reads.
 */
export const rowsWithRuns = (host: FactoryHost, services: ShepherdServices, keep: RowFilter = () => true): Promise<RowWithRun[]> =>
  mapRows(host, services, keep, (found) => found);

/** As `rowsWithRuns`, but each run is reduced by `build` as it is read, so a caller that keeps less than the run holds no run past its turn. */
export async function mapRows<T>(host: FactoryHost, services: ShepherdServices, keep: RowFilter, build: (found: RowWithRun) => T): Promise<T[]> {
  const pause = sliceClock();
  const statuses = host.runs.statuses();
  const pendingGates = host.pendingGates();
  const built: T[] = [];
  for (const registration of services.store.get().all()) {
    const status = statuses.get(registration.runId);
    if (status === undefined || !keep(registration, status)) continue;
    await pause();
    const run = host.runtime.status(registration.runId);
    if (run) built.push(build({ row: rowOf(host, services, registration, run, pendingGates), run, registration }));
  }
  return built;
}

export const watchRows = async (host: FactoryHost, services: ShepherdServices, keep?: RowFilter): Promise<WatchRow[]> => (await rowsWithRuns(host, services, keep)).map(({ row }) => row);

/** What `shepherd.list` reads for each state. */
export const LIST_FILTER: Record<"active" | "finished" | "all", RowFilter> = {
  active: (_registration, status) => !runFinished(status),
  finished: (_registration, status) => runFinished(status),
  all: () => true,
};

/** A finished run is read only while it still holds a pending gate, the one thing `waiting` reports; a gate id starts with its run's id. */
export function waitingFilter(host: FactoryHost): RowFilter {
  const gated = new Set(host.gates.listPending().map((gate) => gate.id.slice(0, gate.id.indexOf("/"))));
  return (registration, status) => !runFinished(status) || gated.has(registration.runId);
}
