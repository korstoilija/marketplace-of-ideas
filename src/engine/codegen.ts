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
  await recall(query) -> string  // knowledge retrieval
  await build(path, content) -> string  // WRITE code to workspace/ — corps can BUILD
  await debug() -> object  // self-diagnose: balance, reputation, recent logs, calibration
  await test(snippet) -> string   // REPL: test code snippets
  print(...)
  Final = {}

NEVER shadow these globals with local variables. Do NOT write \`const evidence = ...\` or \`const ideas = ...\`. The globals are functions, not values.`;

export const writeCodeSig = ax(
  "task:string, persona:string, stateMetadata:string, historyText:string -> code:string \"runnable JavaScript for the sandbox\"",
);

export const evaluateClaimSig = ax(
  "claimText:string, supportingEvidence:string, counterEvidence:string -> confidence:number \"probability 0-1 that the claim is true\", reasoning:string",
);

/** Content extraction: LLM returns structured {title, claims}, not JavaScript. */
export const contentSig = ax(
  "topic:string, fileList:string -> title:string \"specific, under 60 chars\", claims:string[] \"2-3 specific claims referencing ONLY files from fileList\"",
);

/** LLM output -> runnable code: strip ALL non-code content. */
export function extractCode(response: string): string {
  // Remove leading/trailing whitespace and pipe characters (common LLM artifact)
  let code = response.replace(/^\s*\|\s*/gm, "").replace(/^\s*\|\|/gm, "//").trim();
  // Remove markdown fences
  const fenced = code.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  if (fenced) code = fenced[1].trim();
  // If still has non-JS markers, try to find the first valid JS line and use from there
  if (code.startsWith("//") || code.startsWith("|") || code.startsWith("```")) {
    const lines = code.split("\n");
    const jsStart = lines.findIndex(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("|") && !l.trim().startsWith("```"));
    if (jsStart > 0) code = lines.slice(jsStart).join("\n");
  }
  return code;
}

/** Build guaranteed-valid JavaScript from structured content. Zero failure rate. */
export function buildTemplate(title: string, claims: string[]): string {
  const escapedTitle = JSON.stringify(title);
  const escapedClaims = JSON.stringify(claims);
  return `// RLM DELIBERATION PROTOCOL
const {ideaId, claimIds} = ideas.propose({title:${escapedTitle}, summary:"", body:"", claims:${escapedClaims}});
print("Proposed " + claimIds.length + " claims.");

for (const cid of claimIds) {
  const result = await evaluate(cid, "evidence for", "evidence against");
  const conf = result?.aggregate?.confidence || 0.5;
  print("Evaluated " + cid + ": confidence=" + conf.toFixed(2));
  const shares = Math.max(10, Math.round(Math.abs(conf - 0.5) * 300));
  const before = market.price(cid);
  if (conf > 0.55) { market.buyYes(cid, shares); print("  Bought YES " + shares + "sh"); }
  else if (conf < 0.45) { market.buyNo(cid, shares); print("  Bought NO " + shares + "sh"); }
  else { print("  Holding — market uncertain"); }
}
print("Deliberation complete. " + claimIds.length + " claims evaluated and traded.");
`;
}

/** Per-call code generator: first iteration uses contentSig + buildTemplate.
 *  Subsequent iterations use writeCodeSig for self-correction.
 *  Stateless — the outer agent loop tracks which iteration it's on via metadata. */
export function makeCodeGenerator(llm: AxLLM): CodeGenerator {
  return async (inputs) => {
    // First iteration: use structured content extraction with FILE LIST context
    if (!inputs.historyText || inputs.historyText === "(first iteration)") {
      try {
        const res = await contentSig.forward(llm, { topic: inputs.task, fileList: inputs.stateMetadata || "" });
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
