export interface Interval {
  estimate: number;
  lower: number;
  upper: number;
}
export interface BetaPrior {
  alpha: number;
  beta: number;
}
export function wilson(_s: number, _n: number, _o?: { confidence?: number }): Interval {
  throw new Error("stub");
}
export function betaBinomialInterval(_s: number, _n: number, _o?: { confidence?: number; prior?: BetaPrior }): Interval {
  throw new Error("stub");
}
