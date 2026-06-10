import { ax, ai, type AxAI } from "@ax-llm/ax";
import { Store } from "../store/index.js";
import { evaluateClaim, type ProviderId, type EvaluateResult } from "../evaluate/sub-agent.js";
import type { Distillate } from "../types/deliberation.js";
import { createContext, runInContext, type Context } from "node:vm";

const MAX_DEPTH = 2;
const TRUNCATE_STDOUT = 1000;
const ITERATION_CAP = 20;
const EXEC_TIMEOUT = 20000;

const providerNames: Record<ProviderId, string> = {
  openai: "openai",
  anthropic: "anthropic",
  deepseek: "deepseek",
  mistral: "mistral",
  "google-gemini": "google-gemini",
  grok: "grok",
};

const envKeys: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  "google-gemini": "GOOGLE_GEMINI_API_KEY",
  grok: "GROK_API_KEY",
};

const SYSTEM_PROMPT = `You are a Recursive Language Model (RLM) agent in a marketplace of ideas.
Your identity: AGENT_ID, personality: PERSONA, provider: PROVIDER/MODEL.

You write JavaScript code that executes in a sandbox with these functions:
  propose(title, summary, body, claimTexts[], author?) → {idea_id, claim_count}
  addEvidence(claimId, excerpt, relevance?, submittedBy?) → {evidence_id}
  evaluate(claimId, claimText, supporting[], counter[], providers?) → {aggregate, individual}
    This calls REAL LLMs. Returns real verdicts with confidence scores.
  getMarket(claimId) → {yes_price, no_price, resolution, verdict_count}
  placeOrder(claimId, side, amount) → {avg_price, new_yes_price, agent_balance}
    side is "yes" or "no". Uses YOUR wallet.
  findDivergence(minVerdicts?) → [{claim_id, variance, divergence, yes_price}]
  distill() → {round, trajectories}
  getState() → {ideas, claims, active_markets, settled_markets, agents}
  subAgent(prompt) → {finalValue, success}
  print(msg) → captured stdout

RULES:
1. Write ONLY valid JavaScript. No explanations, no markdown.
2. After evaluate(), placeOrder() based on confidence.
3. Investigate high-divergence claims (findDivergence).
4. You CANNOT settle markets. Only the human adjudicator settles.
   Your job is to evaluate and trade. The harness handles settlement.
5. When done: Final = {summary: "...", key_findings: [...]}
6. Never load the full corpus. Use getState() and tools.`;

const METADATA_TEMPLATE = `STATE: IDEAS ideas, CLAIMS claims, ACTIVE markets active, SETTLED settled
Wallet: BALANCE tokens, reputation REPUTATION
Distillates: DISTILLATES

HISTORY(last iterations):
HISTORY

Write JavaScript code. Use tools. Set Final when done.`;

export interface AgentConfig {
  agentId: string;
  provider: ProviderId;
  model?: string;
  persona: string;
}

export interface AgentIteration {
  iteration: number;
  code: string;
  stdout: string;
  timedOut: boolean;
  hasFinal: boolean;
}

export interface AgentRun {
  agentId: string;
  depth: number;
  iterations: AgentIteration[];
  finalValue: unknown;
  success: boolean;
  error: string | null;
}

export class RlmAgent {
  agentId: string;
  config: AgentConfig;
  store: Store;
  depth: number;
  apiKey: string;
  apiBase: string;
  messages: Array<{ role: string; content: string }>;
  history: string[];

  constructor(config: AgentConfig, store: Store, depth = 0) {
    this.agentId = config.agentId;
    this.config = config;
    this.store = store;
    this.depth = depth;
    this.apiKey = process.env[envKeys[config.provider]] ?? "";

    const bases: Record<ProviderId, string> = {
      deepseek: "https://api.deepseek.com/v1",
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com/v1",
      mistral: "https://api.mistral.ai/v1",
      "google-gemini": "https://generativelanguage.googleapis.com/v1beta",
      grok: "https://api.x.ai/v1",
    };
    this.apiBase = bases[config.provider];

    this.messages = [{
      role: "system",
      content: SYSTEM_PROMPT
        .replaceAll("AGENT_ID", config.agentId)
        .replaceAll("PERSONA", config.persona)
        .replaceAll("PROVIDER", config.provider)
        .replaceAll("MODEL", config.model ?? config.provider),
    }];
    this.history = [];
  }

  private async writeCode(hist: string[]): Promise<string> {
    const summary = this.store.getSummary();
    const ag = this.store.ensureAgent(this.agentId);
    const metadata = METADATA_TEMPLATE
      .replace("IDEAS", String(summary.ideas))
      .replace("CLAIMS", String(summary.claims))
      .replace("ACTIVE", String(summary.active_markets))
      .replace("SETTLED", String(summary.settled_markets))
      .replace("BALANCE", String(Math.round(ag.tokenBalance)))
      .replace("REPUTATION", ag.reputation.toFixed(3))
      .replace("DISTILLATES", String(summary.distillates))
      .replace("HISTORY", hist.slice(-6).map((h, i) => `[${i}] ${(h as string).slice(0, 200)}`).join("\n"));

    this.messages.push({ role: "user", content: metadata });

    const res = await fetch(`${this.apiBase}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.config.model ?? "deepseek-chat",
        messages: this.messages,
        temperature: 0.3,
        max_tokens: 1200,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.config.provider} error ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    const content = data.choices[0]?.message?.content ?? "";
    this.messages.push({ role: "assistant", content });
    const jsBlock = content.match(/```(?:js|javascript)?\n?([\s\S]*?)```/);
    return jsBlock ? jsBlock[1].trim() : content.trim();
  }

  private buildSandbox(parentStore: Store, parentAgentId: string, depth: number, captureRef: { captured: string }): [Context, Record<string, unknown>] {
    const store = parentStore;
    const agentId = parentAgentId;
    const cap = captureRef;

    const globals: Record<string, unknown> = {
      console: { log: (...args: unknown[]) => { cap.captured += args.map(String).join(" ") + "\n"; } },
      JSON, Math, Date, Array, Object, String, Number, Map, Set, parseInt, parseFloat, isNaN, isFinite, Promise,

      propose: (title: string, summary: string, body: string, claimTexts: string[], author = "agent") => {
        const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
        store.upsertIdea({
          id, title, summary, body,
          claims: claimTexts.map((_, i) => `${id}-claim-${i + 1}`),
          evidenceLinks: [], author, createdAt: Date.now(), version: 1, status: "proposed",
        });
        claimTexts.forEach((text, i) => {
          const cid = `${id}-claim-${i + 1}`;
          store.upsertClaim({ id: cid, ideaId: id, text, type: "factual" });
          store.ensureMarket(cid);
        });
        cap.captured += `propose: ${id} (${claimTexts.length} claims)\n`;
        return { idea_id: id, claim_count: claimTexts.length };
      },

      addEvidence: (claimId: string, excerpt: string, relevance = 0.5, submittedBy = agentId) => {
        store.insertEvidence({
          id: `ev-${Date.now()}-${claimId}`, claimId, sourceUrl: "", excerpt, relevance, submittedBy, timestamp: Date.now(),
        });
        return { evidence_id: `ev-${Date.now()}`, total: store.getEvidenceForClaim(claimId).length };
      },

      evaluate: async (claimId: string, claimText: string, supporting: string[] = [], counter: string[] = [], providers: string[] = []) => {
        const providerList = (providers.length > 0 ? providers : ["deepseek"]).filter(p =>
          Object.keys(envKeys).includes(p),
        ) as ProviderId[];
        if (providerList.length === 0) return { error: "no providers available" };
        try {
          const result = await evaluateClaim(claimId, claimText, { supporting, counter }, providerList[0]);
          store.insertVerdict(result.verdict);
          cap.captured += `evaluate: ${claimId.slice(0, 30)} confidence=${result.confidence.toFixed(2)}\n`;
          return { aggregate: { confidence: result.confidence, consensus: 1, divergence: 0 }, individual: [result] };
        } catch (e) {
          return { error: String(e) };
        }
      },

      placeOrder: (claimId: string, side: string, amount: number) => {
        if (side !== "yes" && side !== "no") return { error: "side must be yes or no" };
        return store.placeOrderAndUpdateMarket(claimId, agentId, side as "yes" | "no", amount);
      },
      getMarket: (claimId: string) => store.getMarketSummary(claimId),
      findDivergence: (min = 2) => store.getDivergentClaims(min),
      distill: () => {
        const winning: Distillate["winningTrajectories"] = [];
        const rows = store.db.prepare("SELECT claim_id, resolution FROM markets WHERE resolution IS NOT NULL").all() as Record<string, unknown>[];
        for (const r of rows) {
          const cid = r["claim_id"] as string;
          const outcome = r["resolution"] as string;
          const vs = store.getVerdictsForClaim(cid);
          const correct = vs.filter(v => outcome === "true" ? v.confidence > 0.5 : v.confidence < 0.5);
          if (correct.length > 0) winning.push({
            claimId: cid, rootAgent: agentId, decomposition: `Resolved ${outcome}`,
            subCalls: correct.map(v => ({ subAgent: v.agentId, verdict: v })),
            outcome: outcome as "true" | "false",
          });
        }
        const d: Distillate = {
          round: (store.db.prepare("SELECT COUNT(*) as c FROM distillates").get() as { c: number }).c + 1,
          winningTrajectories: winning, extractedContexts: [],
          promptMutations: winning.map(w => ({ target: "sub" as const, pattern: w.subCalls[0]?.verdict.reasoning.slice(0, 100) ?? "", improvement: `Resolved ${w.outcome}` })),
          distilledAt: Date.now(),
        };
        store.insertDistillate(d);
        return { round: d.round, trajectories: winning.length };
      },
      getState: () => {
        const s = store.getSummary();
        const ag = store.ensureAgent(agentId);
        return { ...s, my_balance: ag.tokenBalance, my_reputation: ag.reputation };
      },
      subAgent: async (prompt: string): Promise<AgentRun> => {
        if (depth >= MAX_DEPTH) {
          const result = await evaluateClaim("leaf", prompt, { supporting: [], counter: [] }, this.config.provider);
          return { agentId: "leaf", depth, iterations: [], finalValue: result.verdict, success: true, error: null };
        }
        const child = new RlmAgent({ ...this.config, agentId: this.agentId }, parentStore, depth + 1);
        child.messages = [{ role: "system", content: `Sub-agent (depth ${depth + 1}) spawned by ${this.agentId}. Evaluate: ${prompt}` }];
        return child.run(3);
      },
      print: (msg: string) => { cap.captured += String(msg) + "\n"; },
      Final: undefined as unknown,
    };

    const ctx = createContext(globals);
    return [ctx, globals];
  }

  async run(maxIterations = ITERATION_CAP): Promise<AgentRun> {
    const iterations: AgentIteration[] = [];
    const cap = { captured: "" };
    const [ctx, globals] = this.buildSandbox(this.store, this.agentId, this.depth, cap);

    for (let i = 0; i < maxIterations; i++) {
      cap.captured = "";

      let code: string;
      try {
        code = await this.writeCode(this.history);
      } catch (err) {
        return { agentId: this.agentId, depth: this.depth, iterations, finalValue: null, success: false, error: `writeCode failed: ${String(err)}` };
      }

      let stdout = "";
      let timedOut = false;

      if (process.env["RLM_VERBOSE"]) {
        console.error(`\n─── ${this.agentId} iter ${i} ───`);
        console.error("CODE:", code.slice(0, 300));
      }

      try {
        const wrapped = `(async()=>{try{${code}}catch(e){console.log("ERROR:"+e.message)}})()`;
        await Promise.race([
          runInContext(wrapped, ctx, { timeout: EXEC_TIMEOUT, breakOnSigint: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), EXEC_TIMEOUT + 2000)),
        ]);
        stdout = cap.captured;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("TIMEOUT")) { timedOut = true; stdout = cap.captured + "\n[TIMEOUT]"; }
        else { stdout = cap.captured + `\n[ERROR]`; }
      }

      const hasFinal = (ctx as Record<string, unknown>)["Final"] !== undefined;
      const stdoutTruncated = stdout.length > TRUNCATE_STDOUT
        ? stdout.slice(0, TRUNCATE_STDOUT) + `... [${stdout.length} total]` : stdout;

      this.history.push(code);
      this.history.push(stdoutTruncated);
      iterations.push({ iteration: i, code, stdout, timedOut, hasFinal });

      if (hasFinal) {
        return { agentId: this.agentId, depth: this.depth, iterations, finalValue: (ctx as Record<string, unknown>)["Final"], success: true, error: null };
      }
    }

    return { agentId: this.agentId, depth: this.depth, iterations, finalValue: null, success: false, error: `Max iterations (${maxIterations}) reached` };
  }
}
