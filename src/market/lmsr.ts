export type Side = "yes" | "no";

/** LMSR cost function C(qYes, qNo) = b * ln(e^(qYes/b) + e^(qNo/b)). */
export function lmsrCost(qYes: number, qNo: number, b: number): number {
  const m = Math.max(qYes, qNo) / b;
  return b * (m + Math.log(Math.exp(qYes / b - m) + Math.exp(qNo / b - m)));
}

export function lmsrPrice(qYes: number, qNo: number, b: number): { yes: number; no: number } {
  const m = Math.max(qYes, qNo) / b;
  const ey = Math.exp(qYes / b - m);
  const en = Math.exp(qNo / b - m);
  return { yes: ey / (ey + en), no: en / (ey + en) };
}

/** Token cost to buy `shares` on `side` given current quantities. Always positive. */
export function buyCost(qYes: number, qNo: number, b: number, side: Side, shares: number): number {
  if (shares <= 0) throw new Error("shares must be positive");
  const after = side === "yes"
    ? lmsrCost(qYes + shares, qNo, b)
    : lmsrCost(qYes, qNo + shares, b);
  return after - lmsrCost(qYes, qNo, b);
}
