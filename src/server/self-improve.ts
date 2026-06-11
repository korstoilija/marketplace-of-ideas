import type { Store } from "../store/store.js";
import { buildProviders, evaluateClaimSig, type AxLLM } from "../engine/codegen.js";

export interface ImprovementClaim {
  claimId: string;
  text: string;
  evidence: string;
  errorCount: number;
  evaluated?: { confidence: number; reasoning: string };
}

/** Read error logs and extract evidence-based improvement claims. */
export function extractErrorPatterns(store: Store): ImprovementClaim[] {
  const sessions = store.listSessions();
  const errors: Array<{ agentId: string; stdout: string }> = [];

  for (const s of sessions) {
    const iters = store.getSessionIterations(s.id);
    for (const it of iters) {
      if (it.stdout.includes("ERROR") || it.stdout.includes("ReferenceError") || it.stdout.includes("TypeError")) {
        errors.push({ agentId: it.agentId, stdout: it.stdout });
      }
    }
  }

  const patterns: Record<string, { count: number; examples: string[] }> = {};

  for (const e of errors) {
    if (e.stdout.includes("shares must be positive")) {
      patterns["zero-shares"] = patterns["zero-shares"] || { count: 0, examples: [] };
      patterns["zero-shares"].count++;
      if (patterns["zero-shares"].examples.length < 3) patterns["zero-shares"].examples.push(e.stdout.slice(0, 100));
    } else if (e.stdout.includes("ReferenceError")) {
      patterns["wrong-function"] = patterns["wrong-function"] || { count: 0, examples: [] };
      patterns["wrong-function"].count++;
      if (patterns["wrong-function"].examples.length < 3) patterns["wrong-function"].examples.push(e.stdout.slice(0, 100));
    } else if (e.stdout.includes("TypeError")) {
      patterns["type-error"] = patterns["type-error"] || { count: 0, examples: [] };
      patterns["type-error"].count++;
      if (patterns["type-error"].examples.length < 3) patterns["type-error"].examples.push(e.stdout.slice(0, 100));
    } else {
      patterns["other"] = patterns["other"] || { count: 0, examples: [] };
      patterns["other"].count++;
      if (patterns["other"].examples.length < 3) patterns["other"].examples.push(e.stdout.slice(0, 100));
    }
  }

  const claims: ImprovementClaim[] = [];

  if (patterns["zero-shares"]) {
    claims.push({
      claimId: "fix-zero-shares",
      text: "Agents need share amount validation to prevent zero-share errors",
      evidence: `Evidence: ${patterns["zero-shares"].count} errors. Example: ${patterns["zero-shares"].examples[0]}`,
      errorCount: patterns["zero-shares"].count,
    });
  }

  if (patterns["wrong-function"]) {
    claims.push({
      claimId: "fix-function-names",
      text: "Agents hallucinate function names instead of using the documented API",
      evidence: `Evidence: ${patterns["wrong-function"].count} ReferenceErrors. Example: ${patterns["wrong-function"].examples[0]}`,
      errorCount: patterns["wrong-function"].count,
    });
  }

  if (patterns["type-error"]) {
    claims.push({
      claimId: "fix-type-coercion",
      text: "Agents produce type errors from incorrect parameter handling",
      evidence: `Evidence: ${patterns["type-error"].count} TypeErrors. Example: ${patterns["type-error"].examples[0]}`,
      errorCount: patterns["type-error"].count,
    });
  }

  if (patterns["other"]) {
    claims.push({
      claimId: "fix-other-errors",
      text: "Other recurring agent errors need systematic investigation",
      evidence: `Evidence: ${patterns["other"].count} unclassified errors. Example: ${patterns["other"].examples[0] || "none"}`,
      errorCount: patterns["other"].count,
    });
  }

  claims.sort((a, b) => b.errorCount - a.errorCount);
  return claims;
}

/** Evaluate improvement claims using real LLMs. Returns confidence scores. */
export async function evaluateImprovementClaims(
  claims: ImprovementClaim[],
  store: Store,
): Promise<ImprovementClaim[]> {
  const providers = buildProviders();
  if (providers.length === 0) return claims;

  const llm = providers[0].llm;

  for (const claim of claims) {
    try {
      const res = await evaluateClaimSig.forward(llm, {
        claimText: claim.text,
        supportingEvidence: claim.evidence,
        counterEvidence: "The current system already handles some cases; not all errors need fixing",
      });
      claim.evaluated = {
        confidence: Number(res.confidence ?? 0.5),
        reasoning: String(res.reasoning ?? "").slice(0, 200),
      };
    } catch {
      claim.evaluated = { confidence: 0.5, reasoning: "evaluation failed" };
    }
  }

  return claims;
}

/** Propose improvement claims as marketplace ideas with evidence from error logs. */
export function proposeImprovements(store: Store, claims: ImprovementClaim[]): string[] {
  const ids: string[] = [];
  for (const claim of claims) {
    store.ensureAgent("self-improve");
    const r = store.propose({
      title: claim.claimId,
      summary: claim.text,
      body: claim.evidence,
      claims: [claim.text],
      author: "self-improve",
    });
    store.addEvidence({
      claimId: r.claimIds[0],
      excerpt: claim.evidence,
      stance: "supporting",
      submittedBy: "self-improve",
    });
    ids.push(r.claimIds[0]);
  }
  return ids;
}

/** Full self-improvement loop: extract errors → create claims → evaluate → propose → return prioritized roadmap */
export async function selfImprove(store: Store) {
  const claims = extractErrorPatterns(store);
  await evaluateImprovementClaims(claims, store);
  const claimIds = proposeImprovements(store, claims);
  return {
    claims: claims.map(c => ({
      id: c.claimId,
      text: c.text,
      errorCount: c.errorCount,
      confidence: c.evaluated?.confidence ?? null,
      reasoning: c.evaluated?.reasoning ?? "",
    })),
    claimIds,
    totalErrors: claims.reduce((s, c) => s + c.errorCount, 0),
  };
}
