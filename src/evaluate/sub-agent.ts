import { ax, ai, type AxAI, type AxAIService } from "@ax-llm/ax";
import type { Verdict } from "../types/deliberation.js";

export type ProviderId = "openai" | "anthropic" | "deepseek" | "mistral" | "google-gemini" | "grok";

const providerNames: Record<ProviderId, string> = {
  openai: "openai",
  anthropic: "anthropic", 
  deepseek: "deepseek",
  mistral: "mistral",
  "google-gemini": "google-gemini",
  grok: "grok",
};

const envKeys: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  "google-gemini": "GOOGLE_GEMINI_API_KEY",
  grok: "GROK_API_KEY",
};

const aiInstances = new Map<ProviderId, AxAI>();

function getAI(provider: ProviderId): AxAI {
  const existing = aiInstances.get(provider);
  if (existing) return existing;
  const key = process.env[envKeys[provider]] ?? "";
  if (!key) throw new Error(`No API key for ${provider}`);
  const instance = ai({ name: providerNames[provider], apiKey: key } as Parameters<typeof ai>[0]);
  aiInstances.set(provider, instance);
  return instance;
}

const evaluateSignature = ax(`
  claim:string,
  supporting_evidence:string[],
  counter_evidence:string[] 
  -> 
  confidence:number "0-1 confidence that the claim is true",
  reasoning:string "brief reasoning citing specific evidence",
  strengths:string[] "strengths of the evidence",
  weaknesses:string[] "weaknesses"
`);

export interface EvaluateResult {
  verdict: Verdict;
  provider: ProviderId;
  confidence: number;
  reasoning: string;
}

export async function evaluateClaim(
  claimId: string,
  claimText: string,
  evidence: { supporting: string[]; counter: string[] },
  provider: ProviderId = "deepseek",
): Promise<EvaluateResult> {
  const ai = getAI(provider);
  const result = await evaluateSignature.forward(ai, {
    claim: claimText,
    supporting_evidence: evidence.supporting,
    counter_evidence: evidence.counter,
  });

  const confidence = Math.max(0, Math.min(1, result.confidence ?? 0.5));
  const reasoning = result.reasoning ?? "";

  const verdict: Verdict = {
    claimId,
    agentId: `sub-${provider}`,
    confidence: Math.round(confidence * 1000) / 1000,
    reasoning,
    evidenceReviewed: [],
    timestamp: Date.now(),
  };

  return { verdict, provider, confidence, reasoning };
}

export async function evaluateClaimMulti(
  claimId: string,
  claimText: string,
  evidence: { supporting: string[]; counter: string[] },
  providers: ProviderId[] = [],
): Promise<EvaluateResult[]> {
  const available = providers.length > 0
    ? providers
    : (Object.keys(envKeys) as ProviderId[]).filter(p => process.env[envKeys[p]]);

  if (available.length === 0) throw new Error("No providers available");

  const results = await Promise.allSettled(
    available.map(p => evaluateClaim(claimId, claimText, evidence, p)),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<EvaluateResult> => r.status === "fulfilled")
    .map(r => r.value);
}

export function aggregateVerdicts(results: EvaluateResult[]): {
  verdict: Verdict;
  consensus: number;
  divergence: number;
  sources: ProviderId[];
} {
  if (results.length === 0) {
    return {
      verdict: { claimId: "", agentId: "aggregate", confidence: 0.5, reasoning: "No evaluations", evidenceReviewed: [], timestamp: Date.now() },
      consensus: 0, divergence: 0, sources: [],
    };
  }
  const confidences = results.map(r => r.confidence);
  const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;
  const divergence = Math.sqrt(variance);
  const consensus = 1 - divergence;

  const sources = results.map(r => r.provider);
  const reasoningLines = results.map(r => `[${r.provider}] c=${r.confidence.toFixed(2)}: ${r.reasoning.slice(0, 100)}`);

  const verdict: Verdict = {
    claimId: results[0].verdict.claimId,
    agentId: `aggregate-${sources.join("+")}`,
    confidence: Math.round(mean * 1000) / 1000,
    reasoning: `Aggregated from ${results.length} evaluators. Mean: ${mean.toFixed(2)}, consensus: ${consensus.toFixed(2)}, divergence: ${divergence.toFixed(2)}.\n${reasoningLines.join("\n")}`,
    evidenceReviewed: [],
    timestamp: Date.now(),
  };

  return { verdict, consensus: +consensus.toFixed(3), divergence: +divergence.toFixed(3), sources };
}
