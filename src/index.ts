import { createMarket, buyShares, resolveMarket, lmsrPrice, lmsrCost, computeRentScore } from "./market/lmsr.js";

import {
  IdeaSchema,
  ClaimSchema,
  EvidenceSchema,
  VerdictSchema,
  MarketOrderSchema,
  ClaimMarketSchema,
  AgentStateSchema,
  RoundSchema,
  ConsensusSchema,
  DistillateSchema,
  EvolutionSchema,
  PredictiveClaimSchema,
  RentScoreSchema,
  VerificationSchema,
} from "./types/deliberation.js";

import type {
  Idea,
  Claim,
  Evidence,
  Verdict,
  MarketOrder,
  ClaimMarket,
  AgentState,
  Round,
  Consensus,
  Distillate,
  Evolution,
  PredictiveClaim,
  RentScore,
  Verification,
} from "./types/deliberation.js";

export {
  createMarket,
  buyShares,
  resolveMarket,
  lmsrPrice,
  lmsrCost,
  computeRentScore,
};

export {
  IdeaSchema,
  ClaimSchema,
  EvidenceSchema,
  VerdictSchema,
  MarketOrderSchema,
  ClaimMarketSchema,
  AgentStateSchema,
  RoundSchema,
  ConsensusSchema,
  DistillateSchema,
  EvolutionSchema,
  PredictiveClaimSchema,
  RentScoreSchema,
  VerificationSchema,
};

export type {
  Idea,
  Claim,
  Evidence,
  Verdict,
  MarketOrder,
  ClaimMarket,
  AgentState,
  Round,
  Consensus,
  Distillate,
  Evolution,
  PredictiveClaim,
  RentScore,
  Verification,
};

console.error("Marketplace of Ideas — RLM deliberation engine with LMSR prediction markets");
console.error("Run the MCP server with: npm run registry");
