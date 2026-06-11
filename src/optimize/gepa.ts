import { AxGEPA, axSerializeOptimizedProgram, axDeserializeOptimizedProgram } from "@ax-llm/ax";
import type { Store } from "../store/store.js";
import { evaluateClaimSig, type AxLLM } from "../engine/codegen.js";

/** One human ruling, flattened into evaluateClaimSig's input fields. `outcome` rides along for the metric. */
export const MIN_EXAMPLES = 30;

export interface GepaExample {
  claimText: string;
  supportingEvidence: string;
  counterEvidence: string;
  outcome: boolean;
}

export function toExamples(store: Store): GepaExample[] {
  return store.listTrainingExamples().map(t => ({
    claimText: t.claimText,
    supportingEvidence: t.supporting.join("\n") || "(none)",
    counterEvidence: t.counter.join("\n") || "(none)",
    outcome: t.outcome,
  }));
}

/** Deterministic split — every `every`-th item (by index) is holdout. No randomness: reruns are comparable. */
export function splitHoldout<T>(items: T[], every = 4): { train: T[]; holdout: T[] } {
  const train: T[] = [], holdout: T[] = [];
  items.forEach((x, i) => (i % every === 0 ? holdout : train).push(x));
  return { train, holdout };
}

export function brier(confidence: number, outcome: boolean): number {
  const c = Math.max(0, Math.min(1, confidence));
  return (c - (outcome ? 1 : 0)) ** 2;
}

/** Higher is better, in [0,1]. Confident-and-wrong scores worst — a proper scoring rule. */
export async function gepaMetric(arg: Readonly<{ prediction: unknown; example: unknown }>): Promise<number> {
  const confidence = Number((arg.prediction as { confidence?: unknown })?.confidence ?? 0.5);
  const outcome = Boolean((arg.example as { outcome?: unknown })?.outcome);
  return 1 - brier(confidence, outcome);
}

export interface GepaReport {
  baseline: number;
  optimized: number;
  trainSize: number;
  holdoutSize: number;
  applied: boolean;
}

export class InsufficientExamplesError extends Error {
  constructor(public readonly have: number, public readonly need: number) {
    super(`need ${need} adjudicated examples for GEPA, have ${have}`);
  }
}

/** Mean metric score of the CURRENT evaluateClaimSig on the holdout. Parallelizes LLM calls. */
export async function scoreOnHoldout(llm: AxLLM, holdout: GepaExample[]): Promise<number> {
  const results = await Promise.all(holdout.map(ex =>
    evaluateClaimSig.forward(llm, {
      claimText: ex.claimText,
      supportingEvidence: ex.supportingEvidence,
      counterEvidence: ex.counterEvidence,
    }).then(res => gepaMetric({ prediction: res, example: ex })),
  ));
  if (results.length === 0) return 0;
  return results.reduce((a, b) => a + b, 0) / results.length;
}

export interface RunGepaOptions {
  store: Store;
  llm: AxLLM;
  minExamples?: number;
  maxMetricCalls?: number;
  /** Test seams — default to real AxGEPA + scoreOnHoldout. */
  optimize?: (train: GepaExample[]) => Promise<{ optimizedProgram?: unknown }>;
  score?: (holdout: GepaExample[]) => Promise<number>;
}

export async function runGepa(opts: RunGepaOptions): Promise<GepaReport> {
  const minExamples = opts.minExamples ?? MIN_EXAMPLES;
  const examples = toExamples(opts.store);
  if (examples.length < minExamples) throw new InsufficientExamplesError(examples.length, minExamples);

  const { train, holdout } = splitHoldout(examples);
  const score = opts.score ?? ((h: GepaExample[]) => scoreOnHoldout(opts.llm, h));
  const optimize = opts.optimize ?? (async (t: GepaExample[]) => {
    const optimizer = new AxGEPA({ studentAI: opts.llm });
    // If AxCompileOptions has drifted, adjust ONLY this options object (check node_modules typings).
    return optimizer.compile(evaluateClaimSig, t as never, gepaMetric as never, { maxMetricCalls: opts.maxMetricCalls ?? 40 } as never);
  });

  const baseline = await score(holdout);
  const result = await optimize(train);

  let applied = false;
  let programJson = "{}";
  if (result.optimizedProgram) {
    evaluateClaimSig.applyOptimization(result.optimizedProgram as never);
    programJson = JSON.stringify(axSerializeOptimizedProgram(result.optimizedProgram as never));
    applied = true;
  }
  const optimized = await score(holdout);

  opts.store.insertOptimization({
    baseline, optimized,
    examplesUsed: train.length, holdoutSize: holdout.length,
    programJson,
  });

  return { baseline, optimized, trainSize: train.length, holdoutSize: holdout.length, applied };
}

/** Boot hook: re-apply the latest persisted optimization. Tolerates absence and garbage. */
export function loadLatestOptimization(store: Store): boolean {
  const latest = store.latestOptimization();
  if (!latest) return false;
  try {
    const parsed = JSON.parse(latest.programJson);
    if (!parsed || Object.keys(parsed).length === 0) return false;
    evaluateClaimSig.applyOptimization(axDeserializeOptimizedProgram(parsed) as never);
    return true;
  } catch (err) {
    console.error(`loadLatestOptimization: skipping bad program (${String(err)})`);
    return false;
  }
}
