import { createContext, useContext } from "react";
import type { CodeReadCommandMap } from "@titan-design/code-read/query";

type Describe = CodeReadCommandMap["api.describe"]["result"];

/** What every page reads: the pinned snapshot and what the serving source can do. */
export interface ReportInfo {
  snapshotId: number;
  describe: Describe & { newest: NonNullable<Describe["newest"]> };
}

export const ReportContext = createContext<ReportInfo | null>(null);

export function useReport(): ReportInfo {
  const report = useContext(ReportContext);
  if (!report) throw new Error("useReport must be used under ReportContext");
  return report;
}
