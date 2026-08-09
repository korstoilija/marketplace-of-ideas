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
  await build(path, content) -> string  // WRITE code to workspace/
  await browser.test(path, {wait, actions, probes}) -> {errors,warnings,logs}  // HEADLESS CHROME test
  browser.exists(path) -> {size,modified} | false  // check if file was built
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
export function buildTemplate(title: string, claims: string[], task: string): string {
  const escapedTitle = JSON.stringify(title);
  const escapedClaims = JSON.stringify(claims);
  const topicLower = title.toLowerCase() + " " + task.toLowerCase();
  const isBuildTask = topicLower.includes('build') || topicLower.includes('game') || topicLower.includes('html') || topicLower.includes('code');
  
  return `// RLM DELIBERATION PROTOCOL
const {ideaId, claimIds} = ideas.propose({title:${escapedTitle}, summary:"", body:"", claims:${escapedClaims}});
print("Proposed " + claimIds.length + " claims.");
const st = state();
print("My balance before: " + st.balance);

// ═══ STEP 1: BUILD + TEST (before trading — don't bankrupt ourselves) ═══
${isBuildTask ? `
{
  const outputPath = "output.html";
  const prompt = "Generate complete single HTML file for: " + JSON.stringify(claimIds.map(cid => cid + " (market=" + market.price(cid).toFixed(2) + ")")) + ". Return ONLY code, no markdown fences. Must load all libraries from CDN.";
  let code = await llm(prompt).catch(e => { print("LLM codegen failed: " + String(e).slice(0,100)); return ""; });
  if (code && code.length > 100) {
    code = code.replace(/^\`\`\`[a-z]*\s*\\n?/,'').replace(/\`\`\`\s*$/,'');
    const r = build(outputPath, code);
    print("Built: " + r);

    // ═══ TEST IN BROWSER ═══
    print("Testing in browser...");
    const testResult = await browser.test(outputPath, {
      wait: 4000,
      actions: ["KeyW","KeyW","KeyW","Space","Space","KeyW","KeyW"],
      probes: { "pageErrors": "window.__pageErrors?.length || 0", "hasGameLoop": "typeof requestAnimationFrame !== 'undefined' ? 1 : 0" }
    }).catch(e => { print("Browser test failed: " + String(e).slice(0,100)); return {errors:[String(e)],warnings:[],logs:[],exceptions:[],state:{}}; });
    const totalErrors = testResult.errors.length + testResult.exceptions.length;
    print("Browser test: " + totalErrors + " errors, " + testResult.warnings.length + " warnings, " + testResult.logs.length + " logs");
    
    if (totalErrors > 0) {
      const errorClaims = [];
      for (const err of testResult.errors.slice(0, 3)) errorClaims.push("Runtime error in " + outputPath + ": " + err.slice(0, 150));
      for (const ex of testResult.exceptions.slice(0, 2)) errorClaims.push("Uncaught exception in " + outputPath + ": " + ex.slice(0, 150));
      if (errorClaims.length > 0) {
        try {
          const {claimIds: bugIds} = ideas.propose({
            title: "browser-test-found-bugs-in-" + outputPath.replace(/[^a-z0-9]/g,'-'),
            summary: "Browser test found " + totalErrors + " errors/exceptions",
            body: "Test ran with keyboard simulation. Errors: " + JSON.stringify(testResult.errors.slice(0,5)),
            claims: errorClaims
          });
          print("Created " + bugIds.length + " bug claims — backed by browser evidence");
          for (const bid of bugIds) {
            for (const err of testResult.errors.slice(0, 3)) evidence.submit(bid, "Browser console error: " + err.slice(0, 200), "counter", 0.9);
            for (const ex of testResult.exceptions.slice(0, 2)) evidence.submit(bid, "Uncaught exception: " + ex.slice(0, 200), "counter", 0.9);
            try { market.buyNo(bid, 20); print("  Bought NO on " + bid + " (bug exists — backed by evidence)"); } catch(e) { print("  Trade failed (low balance): " + String(e).slice(0,80)); }
          }
        } catch(e) { print("Bug claim creation skipped: " + String(e).slice(0,100)); }
      }
    } else {
      const {claimIds: passIds} = ideas.propose({title:"browser-test-passed-"+outputPath.replace(/[^a-z0-9]/g,'-'), claims:[outputPath + " runs without JavaScript errors in headless browser"]});
      try { market.buyYes(passIds[0], 30); print("Test clean — bought YES on " + passIds[0]); } catch(e) { print("Trade failed (low balance)"); }
    }
    for (const log of testResult.logs.slice(0, 5)) { try { for (const cid of claimIds) { evidence.submit(cid, log.slice(0, 200), log.includes("error")||log.includes("fail")?"counter":"supporting", 0.5); } } catch {} }
  } else { print("Build skipped — LLM returned " + (code?.length||0) + " chars"); }
}
` : ''}

// ═══ STEP 2: EVALUATE + TRADE (with remaining balance) ═══
for (const cid of claimIds) {
  const result = await evaluate(cid, "evidence for", "evidence against");
  const conf = result?.aggregate?.confidence || 0.5;
  print("Evaluated " + cid + ": confidence=" + conf.toFixed(2));
  const shares = Math.min(20, Math.max(5, Math.round(Math.abs(conf - 0.5) * 60)));
  try {
    if (conf > 0.55) { market.buyYes(cid, shares); print("  Bought YES " + shares + "sh"); }
    else if (conf < 0.45) { market.buyNo(cid, shares); print("  Bought NO " + shares + "sh"); }
    else { print("  Holding — market uncertain"); }
  } catch(e) { print("  Trade failed: " + String(e).slice(0,80)); }
}
print("Deliberation complete. " + claimIds.length + " claims evaluated and traded.");

${isBuildTask ? `
// ═══ BUILD + TEST ═══
const outputPath = "output.html";
const prompt = "Generate complete single HTML file for: " + JSON.stringify(claimIds.map(cid => cid + " (market=" + market.price(cid).toFixed(2) + ")")) + ". Return ONLY code, no markdown fences. Must load all libraries from CDN.";
let code = await llm(prompt);
if (code && code.length > 100) {
  code = code.replace(/^\`\`\`[a-z]*\s*\\n?/,'').replace(/\`\`\`\s*$/,'');
  const r = build(outputPath, code);
  print("Built: " + r);

  // ═══ TEST IN BROWSER ═══
  print("Testing in browser...");
  const testResult = await browser.test(outputPath, {
    wait: 4000,
    actions: ["KeyW","KeyW","KeyW","Space","Space","KeyW","KeyW"],
    probes: { "pageErrors": "window.__pageErrors?.length || 0", "hasGameLoop": "typeof requestAnimationFrame !== 'undefined' ? 1 : 0" }
  });
  const totalErrors = testResult.errors.length + testResult.exceptions.length;
  print("Browser test: " + totalErrors + " errors, " + testResult.warnings.length + " warnings, " + testResult.logs.length + " logs");
  
  // ═══ TRADABLE CLAIMS FROM TEST RESULTS ═══
  if (totalErrors > 0) {
    const errorClaims = [];
    for (const err of testResult.errors.slice(0, 3)) {
      errorClaims.push("Runtime error in " + outputPath + ": " + err.slice(0, 150));
    }
    for (const ex of testResult.exceptions.slice(0, 2)) {
      errorClaims.push("Uncaught exception in " + outputPath + ": " + ex.slice(0, 150));
    }
    if (errorClaims.length > 0) {
      try {
        const { claimIds: bugIds } = ideas.propose({
          title: "browser-test-found-bugs-in-" + outputPath.replace(/[^a-z0-9]/g,'-'),
          summary: "Browser test found " + totalErrors + " errors/exceptions",
          body: "Test ran with keyboard simulation. Errors: " + JSON.stringify(testResult.errors.slice(0,5)),
          claims: errorClaims
        });
        print("Created " + bugIds.length + " bug claims — backed by browser evidence");
        for (const bid of bugIds) {
          for (const err of testResult.errors.slice(0, 3)) {
            evidence.submit(bid, "Browser console error: " + err.slice(0, 200), "counter", 0.9);
          }
          for (const ex of testResult.exceptions.slice(0, 2)) {
            evidence.submit(bid, "Uncaught exception: " + ex.slice(0, 200), "counter", 0.9);
          }
          market.buyNo(bid, 30);
          print("  Bought NO on " + bid + " (bug exists — backed by evidence)");
        }
      } catch(e) { print("Bug claim creation skipped: " + String(e).slice(0,100)); }
    }
  } else {
    const { claimIds: passIds } = ideas.propose({
      title: "browser-test-passed-" + outputPath.replace(/[^a-z0-9]/g,'-'),
      claims: [outputPath + " runs without JavaScript errors in headless browser"]
    });
    market.buyYes(passIds[0], 50);
    print("Test clean — bought YES on " + passIds[0]);
  }

  // Log console output as evidence for feature claims
  for (const log of testResult.logs.slice(0, 5)) {
    try {
      for (const cid of claimIds) {
        evidence.submit(cid, log.slice(0, 200), log.includes("error") || log.includes("fail") ? "counter" : "supporting", 0.5);
      }
    } catch {}
  }
}
` : ''}
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
        if (claims.length > 0) return buildTemplate(title, claims as string[], inputs.task);
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
