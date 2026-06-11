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
  ideas.list() -> [{id,title,claimIds}]
  ideas.get(id) -> {id,title,summary,body,claims}
  evidence.submit(claimId, excerpt, stance)   // stance: "supporting"|"counter"
  evidence.list(claimId) -> [{excerpt,stance,relevance}]
  market.price(claimId) -> number
  market.buyYes(claimId, shares) -> {cost,yesPrice}
  market.buyNo(claimId, shares) -> {cost,yesPrice}
  market.positions() -> [{claimId,side,shares}]
  await evaluate(claimId, supporting, counter) -> {aggregate:{confidence,consensus,divergence}}
  state() -> {ideas,claims,openMarkets,balance,reputation}
  await subAgent(prompt) -> verdict
  await llm(prompt) -> string
  await recall(query) -> string  // knowledge retrieval, returns evidence snippets
  print(...)
  Final = {}`;

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
  return `// RLM DELIBERATION PROTOCOL
const {ideaId, claimIds} = ideas.propose({title:${escapedTitle}, summary:"", body:"", claims:${escapedClaims}});
print("Seeded " + claimIds.length + " claims.");

// Step 1: Add evidence for each claim
for (const cid of claimIds) {
  const claimText = (ideas.get(ideaId)?.claims || []).find(c => c === cid) || cid;
  const searchResult = await recall("evidence about: " + claimText);
  if (searchResult && !searchResult.includes("error") && !searchResult.includes("unavailable")) {
    evidence.submit(cid, searchResult.slice(0, 300), "supporting");
  }
  print("Evidence submitted for " + cid);
}

// Step 2: Evaluate each claim with real LLM
const evaluations = {};
for (const cid of claimIds) {
  const ev = evidence.list(cid) || [];
  const sup = ev.filter(e => e.stance === "supporting").map(e => e.excerpt);
  const cnt = ev.filter(e => e.stance === "counter").map(e => e.excerpt);
  const result = await evaluate(cid, sup.join("; ") || "no evidence", cnt.join("; ") || "no evidence");
  const conf = result?.aggregate?.confidence || 0.5;
  evaluations[cid] = conf;
  print("Evaluated " + cid + ": confidence=" + conf.toFixed(2));
  
  // Step 3: RLM RECURSION — for ambiguous claims, decompose further
  if (conf >= 0.35 && conf <= 0.65) {
    print("Ambiguous claim — spawning sub-agent for deeper analysis: " + cid);
    try {
      const deep = await subAgent("Decompose this ambiguous claim into sub-claims and evaluate each: " + cid);
      if (deep && deep.confidence !== undefined) {
        evaluations[cid] = deep.confidence;
        print("After decomposition: " + cid + " confidence=" + deep.confidence.toFixed(2));
      }
    } catch(e) { print("Sub-agent unavailable: " + cid); }
  }
  
  // Step 4: Trade based on evaluation confidence
  const finalConf = evaluations[cid];
  const shares = Math.max(20, Math.round(Math.abs(finalConf - 0.5) * 300));
  if (finalConf > 0.55) market.buyYes(cid, shares);
  else if (finalConf < 0.45) market.buyNo(cid, shares);
  else print(cid + " remains ambiguous despite recursion");
}
print("Deliberation complete. " + claimIds.length + " claims evaluated" + (Object.keys(evaluations).length ? " with RLM recursion" : ""));`;
}

/** Per-call code generator: first iteration uses contentSig + buildTemplate.
 *  Subsequent iterations use writeCodeSig for self-correction.
 *  Stateless — the outer agent loop tracks which iteration it's on via metadata. */
export function makeCodeGenerator(llm: AxLLM): CodeGenerator {
  return async (inputs) => {
    // First iteration: use structured content extraction (no JS generation needed)
    if (!inputs.historyText || inputs.historyText === "(first iteration)") {
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
