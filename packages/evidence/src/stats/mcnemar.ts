export type McNemarMethod = "exact" | "chi-square";
export interface McNemarResult {
  method: McNemarMethod;
  statistic: number;
  pValue: number;
}
export function mcnemar(_a: number, _b: number, _o?: { method?: McNemarMethod | "auto" }): McNemarResult {
  throw new Error("stub");
}
