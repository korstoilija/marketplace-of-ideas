import { z } from "zod";

export const IdeaSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  body: z.string(),
  claims: z.array(z.string()),
  evidenceLinks: z.array(z.string().url()),
  parentId: z.string().optional(),
  author: z.string(),
  createdAt: z.number(),
  version: z.number(),
  status: z.enum(["proposed", "under_review", "accepted", "rejected", "superseded"]),
});

export const ClaimSchema = z.object({
  id: z.string(),
  ideaId: z.string(),
  text: z.string(),
  type: z.enum(["factual", "normative", "causal", "predictive"]),
  parentClaimId: z.string().optional(),
});

export const EvidenceSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  sourceUrl: z.string().url(),
  excerpt: z.string(),
  relevance: z.number().min(0).max(1),
  submittedBy: z.string(),
  timestamp: z.number(),
});

export const VerdictSchema = z.object({
  claimId: z.string(),
  agentId: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  evidenceReviewed: z.array(z.string()),
  timestamp: z.number(),
});

export const MarketOrderSchema = z.object({
  claimId: z.string(),
  agentId: z.string(),
  side: z.enum(["yes", "no"]),
  amount: z.number().positive(),
  timestamp: z.number(),
});

export const ClaimMarketSchema = z.object({
  claimId: z.string(),
  yesShares: z.record(z.string(), z.number()),
  noShares: z.record(z.string(), z.number()),
  yesPrice: z.number().min(0).max(1),
  noPrice: z.number().min(0).max(1),
  liquidity: z.number().positive(),
  b: z.number().positive(),
  resolution: z.enum(["true", "false"]).optional(),
  resolvedAt: z.number().optional(),
});

export const AgentStateSchema = z.object({
  agentId: z.string(),
  reputation: z.number().min(0),
  tokenBalance: z.number().min(0),
  correctPredictions: z.number().int().min(0),
  totalPredictions: z.number().int().min(0),
});

export const RoundSchema = z.object({
  number: z.number().int().positive(),
  phase: z.enum(["investigation", "bidding", "rebuttal", "resolution"]),
  startedAt: z.number(),
  endedAt: z.number().optional(),
});

export const ConsensusSchema = z.object({
  round: z.number(),
  claimResolutions: z.record(z.string(), z.enum(["true", "false", "unresolved"])),
  topIdeas: z.array(z.object({ ideaId: z.string(), score: z.number() })),
  settledAt: z.number(),
});

export const DistillateSchema = z.object({
  round: z.number(),
  winningTrajectories: z.array(z.object({
    claimId: z.string(),
    rootAgent: z.string(),
    decomposition: z.string(),
    subCalls: z.array(z.object({
      subAgent: z.string(),
      verdict: VerdictSchema,
    })),
    outcome: z.enum(["true", "false"]),
  })),
  extractedContexts: z.array(z.object({
    claimId: z.string(),
    evidence: z.array(EvidenceSchema),
    counterEvidence: z.array(EvidenceSchema),
    synthesis: z.string(),
  })),
  promptMutations: z.array(z.object({
    target: z.enum(["root", "sub", "arbiter"]),
    pattern: z.string(),
    improvement: z.string(),
  })),
  distilledAt: z.number(),
});

export const EvolutionSchema = z.object({
  generation: z.number().int().positive(),
  parentDistillate: z.string(),
  modelUpdate: z.string().optional(),
  promptUpdate: z.string().optional(),
  performanceDelta: z.number().optional(),
});

export const PredictiveClaimSchema = z.object({
  claimId: z.string(),
  prediction: z.string(),
  verificationCriteria: z.string(),
  predictionDate: z.number(),
  resolutionDate: z.number().optional(),
  outcome: z.boolean().optional(),
  resolved: z.boolean(),
});

export const RentScoreSchema = z.object({
  ideaId: z.string(),
  predictiveAccuracy: z.number().min(0).max(1),
  generativeValue: z.number().min(0),
  compressionRatio: z.number().min(0).max(1),
  utilityScore: z.number().min(0).max(1),
  totalRent: z.number(),
  components: z.object({
    predictionsResolved: z.number().int(),
    predictionsCorrect: z.number().int(),
    childIdeas: z.number().int(),
    childRent: z.number(),
    citations: z.number().int(),
    problemSolvings: z.number().int(),
  }),
  computedAt: z.number(),
});

export const VerificationSchema = z.object({
  claimId: z.string(),
  method: z.enum(["empirical", "logical", "predictive", "consensus", "reproduction"]),
  status: z.enum(["pending", "verified", "falsified", "inconclusive"]),
  evidenceHash: z.string(),
  reproducibility: z.number().min(0).max(1),
  verifiedAt: z.number().optional(),
  verifiedBy: z.string().optional(),
});

export type Idea = z.infer<typeof IdeaSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type MarketOrder = z.infer<typeof MarketOrderSchema>;
export type ClaimMarket = z.infer<typeof ClaimMarketSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;
export type Round = z.infer<typeof RoundSchema>;
export type Consensus = z.infer<typeof ConsensusSchema>;
export type Distillate = z.infer<typeof DistillateSchema>;
export type Evolution = z.infer<typeof EvolutionSchema>;
export type PredictiveClaim = z.infer<typeof PredictiveClaimSchema>;
export type RentScore = z.infer<typeof RentScoreSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
