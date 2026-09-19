import { createQueryResolver, type QueryResolver } from "@titan-design/code-read/query";
import { pageDataSource } from "@titan-design/react-app";
import type { DataSource, SnapshotResolver } from "@titan-design/rpc-client";
import { EXIT, errorEnvelope } from "@titan-design/rpc-protocol";
import { datasetSource, isReportDataset } from "./dataset.js";

const resolvers = new WeakMap<object, QueryResolver>();

/** Answers any call a snapshot did not record from its dataset, through code-read's own queries. */
export const resolveFromDataset: SnapshotResolver = (command, args, dataset) => {
  if (!isReportDataset(dataset)) return errorEnvelope("This snapshot carries no code-report dataset", EXIT.UNAVAILABLE);
  let resolve = resolvers.get(dataset);
  if (!resolve) resolvers.set(dataset, (resolve = createQueryResolver(datasetSource(dataset))));
  return resolve(command, args);
};

/** Live against the serving daemon, or static over the snapshot embedded in the page. */
export function reportDataSource(doc?: Document): DataSource {
  return pageDataSource({ doc, resolve: resolveFromDataset });
}
