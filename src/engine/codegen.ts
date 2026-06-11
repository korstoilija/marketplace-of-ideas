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

// --- IDEAS & CLAIMS ---
ideas.propose({title, summary, body, claims: [string]}) -> {ideaId, claimIds}
  // Each claim gets an LMSR prediction market. Use descriptive claim texts.
ideas.list() -> [{id, title, claimIds}]
ideas.get(id) -> {id, title, summary, body, claimIds}

// --- EVIDENCE ---
evidence.submit(claimId, excerpt, stance, relevance?)
  // stance: "supporting" | "counter". Submit evidence BEFORE evaluating.
evidence.list(claimId) -> [{excerpt, stance, relevance}]

// --- TRADING (your wallet, your skin in the game) ---
market.price(claimId) -> number  // current YES price in (0,1); THE signal
market.buyYes(claimId, shares) -> {cost, yesPrice}  // stake: claim is TRUE
market.buyNo(claimId, shares) -> {cost, yesPrice}   // stake: claim is FALSE
market.positions() -> your holdings

// --- META ---
state() -> {ideas, claims, openMarkets, resolvedMarkets, balance, reputation}
await subAgent(prompt) -> verdict  // recursive decomposition
await llm(prompt) -> string        // one-shot LM call
print(...)  // captured; passes observations to YOUR next iteration
Final = {...}  // set when done

// ═══════════════════════════════════════
// DECOMPOSITION STRATEGY (RLM paper §5):
// ═══════════════════════════════════════
// 1. First iteration: propose ideas with claims, submit evidence
// 2. Next: evaluate each claim → place orders based on confidence
// 3. Check prices: high divergence → investigate deeper with subAgent()
// 4. Set Final when all claims have been evaluated and traded

// EXAMPLE — correct pattern:
const { ideaId, claimIds } = ideas.propose({
  title: "Topic Analysis",
  summary: "Analyzing key claims about the topic",
  body: "",
  claims: ["Claim A: verifiable statement", "Claim B: verifiable statement"]
});
evidence.submit(claimIds[0], "Study shows X (2024)", "supporting");
evidence.submit(claimIds[0], "Counter-study shows Y (2023)", "counter");
evidence.submit(claimIds[1], "Data supports B", "supporting");
evidence.submit(claimIds[1], "Alternative explanation exists", "counter");

// Decompose: for claims you're unsure about, use subAgent
const deep = await subAgent("evaluate: " + claimIds[0] + " in depth");

for (const cid of claimIds) {
  const price = market.price(cid);
  print(cid + " price: " + price.toFixed(2));
  if (price > 0.5) market.buyYes(cid, Math.abs(price - 0.5) * 100);
  else market.buyNo(cid, Math.abs(price - 0.5) * 100);
}

Final = { summary: "Evaluated " + claimIds.length + " claims", prices: [market.price(claimIds[0]), market.price(claimIds[1])] };

RULES:
1. Output ONLY runnable JavaScript. No markdown prose or code fences.
2. DECOMPOSE FIRST. Propose ideas + evidence, THEN evaluate, THEN trade.
3. Use subAgent() for deep dives on uncertain claims (Fisher: variance → learning).
4. Stake proportional to your confidence (price distance from 0.5).
5. You cannot settle markets. A human adjudicates.
6. Print short observations each iteration. Being early and right pays.`;

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

/** Extract successful decomposition patterns from session transcripts.
 *  Finds iterations where agents used subAgent() or evidence.submit() and
 *  returns them as in-context examples for the codegen prompt. */
export function extractDecompositionExamples(
  store: import("../store/store.js").Store,
  limit = 3,
): string[] {
  const patterns: string[] = [];
  const sessions = store.listSessions();
  for (const s of sessions) {
    if (patterns.length >= limit) break;
    const iters = store.getSessionIterations(s.id);
    for (const it of iters) {
      if (patterns.length >= limit) break;
      const hasDecomp = it.code.includes("subAgent(") ||
        (it.code.includes("evidence.submit") && it.code.includes("placeOrder"));
      if (hasDecomp && it.code.length > 50) {
        patterns.push(it.code.slice(0, 500));
      }
    }
  }
  return patterns;
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
  const sig = ax("prompt:string -> answer:string");
  return async (prompt) => String((await sig.forward(llm, { prompt })).answer ?? "");
}
