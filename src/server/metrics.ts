import type { Store } from "../store/store.js";

export interface Metrics {
  adjudicated: number;
  meanPriceTrue: number | null;
  meanPriceFalse: number | null;
  informativeness: number | null;
  calibration: Array<{ bucket: string; n: number; fracTrue: number }>;
  verdictVariance: number | null;
  reputationSpread: number;
}

const BUCKETS = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.0001]] as const;

export function computeMetrics(store: Store): Metrics {
  const adjudications = store.db.prepare("SELECT claim_id, outcome FROM adjudications ORDER BY ruled_at").all() as Array<{ claim_id: string; outcome: number }>;
  const judged = adjudications.map(a => {
    const path = store.priceHistory(a.claim_id);
    return { price: path.length ? path[path.length - 1].yesPrice : 0.5, outcome: a.outcome === 1 };
  });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const pricesTrue = judged.filter(j => j.outcome).map(j => j.price);
  const pricesFalse = judged.filter(j => !j.outcome).map(j => j.price);
  const calibration = BUCKETS.map(([lo, hi]) => {
    const inBucket = judged.filter(j => j.price >= lo && j.price < hi);
    return { bucket: `${lo}-${hi > 1 ? "1.0" : hi}`, n: inBucket.length, fracTrue: inBucket.length ? inBucket.filter(j => j.outcome).length / inBucket.length : 0 };
  });
  const varRows = store.db.prepare("SELECT claim_id, AVG(confidence) m, AVG(confidence * confidence) - AVG(confidence) * AVG(confidence) v FROM verdicts GROUP BY claim_id HAVING COUNT(*) >= 2").all() as Array<{ v: number }>;
  const verdictVariance = mean(varRows.map(r => Math.max(0, r.v)));
  const reps = store.listAgents().filter(a => a.total > 0).map(a => a.reputation);
  const reputationSpread = reps.length ? Math.max(...reps) - Math.min(...reps) : 0;
  return {
    adjudicated: judged.length,
    meanPriceTrue: mean(pricesTrue), meanPriceFalse: mean(pricesFalse),
    informativeness: mean(pricesTrue) !== null && mean(pricesFalse) !== null ? mean(pricesTrue)! - mean(pricesFalse)! : null,
    calibration, verdictVariance, reputationSpread,
  };
}
