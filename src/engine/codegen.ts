import { ai, ax } from "@ax-llm/ax";
import type { CodeGenerator, LeafEvaluator } from "./agent.js";

export type AxLLM = ReturnType<typeof ai>;

export interface Provider { name: string; llm: AxLLM }

/** AxAI instance per provider with an env key set. DeepSeek first: it is the cheap default. */
export function buildProviders(env: Record<string, string | undefined> = process.env): Provider[] {
  const defs: Array<{ name: string; key: string }> = [
    { name: "deepseek", key: "DEEPSEEK_API_KEY" },
    { name: "mistral", key: "MISTRAL_API_KEY" },
    { name: "anthropic", key: "ANTHROPIC_API_KEY" },
    { name: "openai", key: "OPENAI_API_KEY" },
  ];
  return defs
    .filter(d => env[d.key])
    .map(d => ({ name: d.name, llm: ai({ name: d.name as never, apiKey: env[d.key]! }) }));
}

export const SANDBOX_API_DOC = `You write JavaScript executed in a sandbox. Available API (top-level await works):
- ideas.propose({title, summary, body, claims: [string]}) -> {ideaId, claimIds}  // propose an idea; each claim gets a market
- ideas.list() -> [{id, title, claimIds}]
- ideas.get(id) -> {id, title, summary, body, claimIds}
- market.buyYes(claimId, shares) -> {cost, yesPrice}  // stake tokens that claim is TRUE; cost is deducted from your balance
- market.buyNo(claimId, shares) -> {cost, yesPrice}   // stake that it is FALSE
- market.price(claimId) -> number                      // current YES price in (0,1); THE signal
- market.positions() -> your holdings
- evidence.submit(claimId, excerpt, stance, relevance?) // stance: "supporting" | "counter"
- evidence.list(claimId) -> [{excerpt, stance, relevance}]
- state() -> {ideas, claims, openMarkets, resolvedMarkets, balance, reputation}  // YOUR wallet
- await subAgent(prompt) -> verdict                    // delegate a sub-question; returns structured result
- await llm(prompt) -> string                          // one-shot LM call
- print(...) // captured; the ONLY way to pass observations to your own next iteration
- Final = {...} // set when your work is done; ends your loop

RULES:
1. Output ONLY runnable JavaScript. No markdown prose.
2. Never dump large data; print short observations.
3. You cannot settle markets. A human adjudicates. Your job: make prices informative.
4. Stake proportional to your confidence. Being early and right is what pays.`;

export const writeCodeSig = ax(
  "task:string, persona:string, stateMetadata:string, historyText:string -> code:string \"runnable JavaScript for the sandbox\"",
);

export const evaluateClaimSig = ax(
  "claimText:string, supportingEvidence:string, counterEvidence:string -> confidence:number \"probability 0-1 that the claim is true\", reasoning:string",
);

/** LLM output -> runnable code: prefer the first fenced block, else strip stray fences. */
export function extractCode(response: string): string {
  const fenced = response.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return response.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export function makeCodeGenerator(llm: AxLLM): CodeGenerator {
  return async (inputs) => {
    const res = await writeCodeSig.forward(llm, {
      task: `${inputs.task}\n\n${SANDBOX_API_DOC}`,
      persona: inputs.persona,
      stateMetadata: inputs.stateMetadata,
      historyText: inputs.historyText || "(first iteration)",
    });
    return extractCode(String(res.code ?? ""));
  };
}

export function makeLeafEvaluator(llm: AxLLM): LeafEvaluator {
  return async (prompt) => {
    const res = await evaluateClaimSig.forward(llm, {
      claimText: prompt,
      supportingEvidence: "(see claim text)",
      counterEvidence: "(see claim text)",
    });
    const confidence = Math.max(0, Math.min(1, Number(res.confidence ?? 0.5)));
    return { confidence, reasoning: String(res.reasoning ?? "") };
  };
}

export function makeLlm(llm: AxLLM): (prompt: string) => Promise<string> {
  const sig = ax("prompt:string -> response:string");
  return async (prompt) => String((await sig.forward(llm, { prompt })).response ?? "");
}
