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
  await test(snippet) -> string   // REPL: test code snippets, see results immediately
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
  "topic:string -> title:string \"specific, under 60 chars, not generic\", claims:string[] \"2-3 specific, falsifiable, actionable claims — no vague statements\"",
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
print("Seeded " + claimIds.length + " claims.");

// Step 0: If target is available, read a DIVERSE sample of files for grounded evidence
if (typeof target !== "undefined") {
  const allFiles = target.list();
  // Pick files from different directories for diversity
  const dirs = [...new Set(allFiles.map(f => f.path.split("/")[0]))];
  const sample = [];
  for (const dir of dirs.slice(0, 4)) {
    const dirFiles = allFiles.filter(f => f.path.startsWith(dir + "/")).slice(0, 2);
    sample.push(...dirFiles);
  }
  if (sample.length === 0) sample.push(...allFiles.slice(0, 8));
  for (const f of sample) {
    try {
      const chunk = target.read(f.path, 0, 2000);
      print("TARGET: " + f.path + " (" + chunk.length + " chars)");
      evidence.submit(claimIds[0], "target:" + f.path + ": " + chunk.slice(0, 300), "supporting");
    } catch(e) { print("target read failed: " + f.path); }
  }
}

// Step 1: Gather evidence for each claim — BOTH directions, stance decided by content.
// recall() is model knowledge, not retrieval: submit it as the stance you asked for,
// and ask for both sides so the market is not fed one-sided fabrication.
for (const cid of claimIds) {
  const claimText = (ideas.get(ideaId)?.claims || []).find(c => c === cid) || cid;
  const pro = await recall("strongest evidence FOR: " + claimText);
  if (pro && !pro.includes("error") && !pro.includes("unavailable")) {
    evidence.submit(cid, pro.slice(0, 300), "supporting");
  }
  const con = await recall("strongest evidence AGAINST: " + claimText);
  if (con && !con.includes("error") && !con.includes("unavailable")) {
    evidence.submit(cid, con.slice(0, 300), "counter");
  }
  print("Evidence gathered for " + cid);
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
print("Deliberation complete. " + claimIds.length + " claims evaluated" + (Object.keys(evaluations).length ? " with RLM recursion" : ""));

// ═══ TRADING: two-sided market with price impact ═══
const trades = [];
for (const cid of claimIds) {
  const conf = evaluations[cid] || 0.5;
  const before = market.price(cid);
  const shares = Math.max(10, Math.round(Math.abs(conf - 0.5) * 400));
  
  if (conf >= 0.6) { market.buyYes(cid, shares); trades.push({cid, side:'YES', shares, conf, before, after:market.price(cid)}); }
  else if (conf <= 0.4) { market.buyNo(cid, shares); trades.push({cid, side:'NO', shares, conf, before, after:market.price(cid)}); }
  else { trades.push({cid, side:'HOLD', shares:0, conf, before, after:before}); }
}
print("Traded " + trades.filter(t=>t.shares>0).length + "/" + trades.length + " claims.");

// ═══ LEARNING: price impact shows market response ═══
for (const t of trades.filter(t=>t.shares>0).slice(0, 5)) {
  const impact = (t.after - t.before).toFixed(3);
  const moved = t.before !== t.after ? (t.after > t.before ? '↑' : '↓') : '=';
  print(t.cid.slice(0,25) + ' ' + t.side + ' ' + t.shares + 'sh @' + t.conf.toFixed(2) + ' ' + moved + impact);
}

// ═══ INSTITUTIONS: reputation, calibration, persistence ═══
const myState = state();
print("Balance: " + myState.balance.toFixed(0) + " tokens. Reputation: " + myState.reputation.toFixed(3));
print("Active markets: " + myState.openMarkets + ". Your positions: " + market.positions().length);
print("Prices are signals. Being right when others are wrong is how reputation compounds.");`;
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
