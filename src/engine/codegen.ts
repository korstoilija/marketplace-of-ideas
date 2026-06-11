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

export const SANDBOX_API_DOC = `AVAILABLE FUNCTIONS (only these — nothing else exists):
  ideas.propose({title,summary,body,claims:[string]}) -> {ideaId,claimIds}
  evidence.submit(claimId, excerpt, stance)   // stance: "supporting"|"counter"
  market.price(claimId) -> number
  market.buyYes(claimId, shares) -> {cost,yesPrice}
  market.buyNo(claimId, shares) -> {cost,yesPrice}
  market.positions() -> [{claimId,side,shares}]
  state() -> {ideas,claims,openMarkets,balance,reputation}
  await subAgent(prompt) -> verdict
  await llm(prompt) -> string
  print(...)
  Final = {}

CODE PATTERN (first iteration only — use ideas.propose to seed the market):
const{ideaId,claimIds}=ideas.propose({title:"Your Topic Here",summary:"Evaluating claims",body:"",claims:["Claim 1","Claim 2"]});
evidence.submit(claimIds[0],"Supporting evidence for claim 1","supporting");
evidence.submit(claimIds[0],"Counter evidence for claim 1","counter");
for(const cid of claimIds){const p=market.price(cid);const shares=Math.max(5,Math.abs(p-0.5)*200);if(p>0.55)market.buyYes(cid,shares);else if(p<0.45)market.buyNo(cid,shares);else print(cid+" price near 0.5, no trade")}
print("Seeded " + claimIds.length + " claims — market is live!");

SUBSEQUENT ITERATIONS — explore freely:
- Read market prices with market.price(claimId)
- Analyze your positions with market.positions()
- Delegate to subAgent(prompt) for deep evaluation
- Call llm(prompt) for quick questions
- Write any JavaScript: loops, conditionals, data analysis
- Print observations — they feed your NEXT iteration

RULES: Use EXACT function names. Print what you observe. Fix errors.`;

export const writeCodeSig = ax(
  "task:string, persona:string, stateMetadata:string, historyText:string -> code:string \"runnable JavaScript for the sandbox\"",
);

export const evaluateClaimSig = ax(
  "claimText:string, supportingEvidence:string, counterEvidence:string -> confidence:number \"probability 0-1 that the claim is true\", reasoning:string",
);

/** Content extraction: LLM returns structured {title, claims}, not JavaScript. */
export const contentSig = ax(
  "topic:string -> title:string \"short title for the idea\", claims:string[] \"2-3 verifiable claims about the topic\"",
);

/** LLM output -> runnable code: prefer the first fenced block, else strip stray fences. */
export function extractCode(response: string): string {
  const fenced = response.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return response.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

/** Build guaranteed-valid JavaScript from structured content. Zero failure rate. */
export function buildTemplate(title: string, claims: string[]): string {
  const escapedTitle = JSON.stringify(title);
  const escapedClaims = JSON.stringify(claims);
  return `const {ideaId, claimIds} = ideas.propose({title:${escapedTitle}, summary:"", body:"", claims:${escapedClaims}});
for (const cid of claimIds) {
  const p = market.price(cid);
  const shares = Math.max(5, Math.abs(p - 0.5) * 200);
  if (p > 0.55) market.buyYes(cid, shares);
  else if (p < 0.45) market.buyNo(cid, shares);
  else print(cid + " price:" + p.toFixed(2) + " (no trade)");
}
print("Seeded " + claimIds.length + " claims — market is live!");
// Force evaluation: the system evaluates every claim with real LLMs
for (const cid of claimIds) {
  const ev = evidence.list(cid) || [];
  const sup = ev.filter(e=>e.stance==="supporting").map(e=>e.excerpt);
  const cnt = ev.filter(e=>e.stance==="counter").map(e=>e.excerpt);
  const result = await evaluate(cid, sup.join("; ") || "no evidence", cnt.join("; ") || "no evidence");
  const conf = result?.aggregate?.confidence || 0.5;
  print("Evaluated " + cid + ": confidence=" + conf.toFixed(2));
  const shares = Math.max(20, Math.round(Math.abs(conf - 0.5) * 300));
  if (conf > 0.55) market.buyYes(cid, shares);
  else if (conf < 0.45) market.buyNo(cid, shares);
  // If confidence 0.45-0.55: ambiguous — mark for deeper investigation
}
print("Evaluation complete. " + claimIds.length + " claims evaluated with real LLMs.");`;
}

/** Template-first code generator: first iteration uses contentSig + buildTemplate.
 *  Subsequent iterations use writeCodeSig for self-correction. */
export function makeCodeGenerator(llm: AxLLM): CodeGenerator {
  let firstCall = true;
  return async (inputs) => {
    if (firstCall) {
      firstCall = false;
      try {
        const res = await contentSig.forward(llm, { topic: inputs.task });
        const title = String(res.title ?? "").slice(0, 100) || "Untitled";
        const claims = (Array.isArray(res.claims) ? res.claims : []).filter((c: unknown) => typeof c === "string").slice(0, 3);
        if (claims.length > 0) return buildTemplate(title, claims as string[]);
      } catch { /* fall through to codegen */ }
    }

    // Subsequent iterations: freeform code with error feedback
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
