// Acklam's rational approximation, relative error below 1.2e-9.
const A = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const C = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
const P_LOW = 0.02425;

function polynomial(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((sum, c) => sum * x + c, 0);
}

function tailQuantile(p: number): number {
  const q = Math.sqrt(-2 * Math.log(p));
  return polynomial(C, q) / (polynomial(D, q) * q + 1);
}

/** The standard normal quantile: the z with P(Z <= z) = p. */
export function normalQuantile(p: number): number {
  if (p <= 0 || p >= 1) throw new RangeError(`normalQuantile needs 0 < p < 1, got ${p}`);
  if (p < P_LOW) return tailQuantile(p);
  if (p > 1 - P_LOW) return -tailQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (polynomial(A, r) * q) / (polynomial(B, r) * r + 1);
}

// Numerical Recipes erfcc, fractional error below 1.2e-7.
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly = polynomial(
    [0.17087277, -0.82215223, 1.48851587, -1.13520398, 0.27886807, -0.18628806, 0.09678418, 0.37409196, 1.00002368, -1.26551223],
    t,
  );
  const value = t * Math.exp(-z * z + poly);
  return x >= 0 ? value : 2 - value;
}

/** P(X > x) for a chi-square variable with one degree of freedom. */
export function chiSquare1Survival(x: number): number {
  return x <= 0 ? 1 : erfc(Math.sqrt(x / 2));
}

// Lanczos approximation, g = 7, nine coefficients.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const shifted = x - 1;
  let sum = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] as number) / (shifted + i);
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

// Lentz's continued fraction for the incomplete beta (Numerical Recipes betacf).
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = 1 / (Math.abs(d) < tiny ? tiny : d);
  let h = d;
  for (let m = 1; m <= 300; m++) {
    for (const numerator of [(m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)), (-(a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1))]) {
      d = 1 + numerator * d;
      d = 1 / (Math.abs(d) < tiny ? tiny : d);
      c = 1 + numerator / c;
      if (Math.abs(c) < tiny) c = tiny;
      h *= d * c;
    }
    if (Math.abs(d * c - 1) < 1e-15) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b), which is the Beta(a, b) CDF at x. */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** The p quantile of Beta(a, b), found by bisection on the CDF. */
export function betaQuantile(p: number, a: number, b: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 200 && high - low > 1e-15; i++) {
    const mid = (low + high) / 2;
    if (regularizedBeta(mid, a, b) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
