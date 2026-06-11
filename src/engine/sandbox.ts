import { createContext, runInContext, type Context } from "node:vm";
import type { Store } from "../store/store.js";
import { TargetJail } from "./target.js";

const TRUNCATE_STDOUT = 1000;

export interface SandboxConfig {
  store: Store;
  agentId: string;
  subAgent: (prompt: string) => Promise<unknown>;
  llm: (prompt: string) => Promise<string>;
  recall?: (query: string) => Promise<string>;
  target?: TargetJail;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stdoutTruncated: string;
  error: string | null;
  timedOut: boolean;
  hasFinal: boolean;
}

export class Sandbox {
  private context: Context;
  private box: Record<string, unknown>;
  private captured = "";
  private timeoutMs: number;

  constructor(cfg: SandboxConfig) {
    const { store, agentId } = cfg;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;

    const print = (...args: unknown[]) => {
      this.captured += args
        .map(a => (typeof a === "object" && a !== null ? JSON.stringify(a).slice(0, 400) : String(a)))
        .join(" ") + "\n";
    };

    this.box = {
      JSON, Math, Array, Object, String, Number, Boolean, Map, Set, Promise,
      parseFloat, parseInt, isNaN,
      print,
      console: { log: print },

      ideas: {
        propose: (input: { title: string; summary: string; body: string; claims: string[]; parentId?: string }) =>
          store.propose({ ...input, author: agentId }),
        list: () => store.listIdeas(),
        get: (id: string) => store.getIdea(id),
      },
      market: {
        buyYes: (claimId: string, shares: number) => store.placeOrder({ claimId, agentId, side: "yes", shares }),
        buyNo: (claimId: string, shares: number) => store.placeOrder({ claimId, agentId, side: "no", shares }),
        price: (claimId: string) => {
          const m = store.getMarket(claimId);
          if (!m) throw new Error(`no market for ${claimId}`);
          return m.yesPrice;
        },
        positions: () => store.getPositions(agentId),
      },
      evidence: {
        submit: (claimId: string, excerpt: string, stance: "supporting" | "counter", relevance?: number) =>
          store.addEvidence({ claimId, excerpt, stance, relevance, submittedBy: agentId }),
        list: (claimId: string) =>
          store.listEvidence(claimId).map(e => ({ excerpt: e.excerpt, stance: e.stance, relevance: e.relevance })),
      },
      /** Real LLM evaluation with multi-model debate for ambiguous claims. */
      evaluate: async (claimId: string, supporting: string, counter: string) => {
        const claim = store.getClaim(claimId);
        const claimText = claim?.text || claimId;
        if (!claimId || claimId === "undefined") return { aggregate: { confidence: 0.5, consensus: 1, divergence: 0 } };
        const prompt = `Evaluate this claim. Return a confidence score 0-1.\n\nCLAIM: ${claimText}\n\nSUPPORTING: ${supporting || "none"}\n\nCOUNTER: ${counter || "none"}\n\nReply with ONLY a JSON object: {"confidence": 0.X, "reasoning": "why"}`;
        
        // Primary evaluation
        const raw = await cfg.llm(prompt);
        let conf = 0.5, reasoning = "evaluated";
        try { const p = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}"); conf = Math.max(0, Math.min(1, Number(p.confidence ?? 0.5))); reasoning = String(p.reasoning || "evaluated").slice(0, 300); } catch {}
        
        // Multi-model debate: if ambiguous (0.3-0.7), get a second opinion with different persona
        if (conf >= 0.3 && conf <= 0.7) {
          const debatePrompt = `You are a skeptical debater. Challenge the initial evaluation.\n\nCLAIM: ${claimText}\n\nINITIAL EVALUATION: confidence=${conf.toFixed(2)}\n\nArgue the OPPOSITE position. Reply with JSON: {"confidence": 0.X, "reasoning": "counter-argument"}`;
          const raw2 = await cfg.llm(debatePrompt);
          try {
            const p2 = JSON.parse(raw2.match(/\{[\s\S]*\}/)?.[0] || "{}");
            const conf2 = Math.max(0, Math.min(1, Number(p2.confidence ?? 0.5)));
            // Average the two (debate produces consensus)
            const divergence = Math.abs(conf - conf2);
            conf = (conf + conf2) / 2;
            reasoning = `DEBATED (divergence=${divergence.toFixed(2)}). Primary: ${reasoning.slice(0,100)} | Counter: ${String(p2.reasoning||'').slice(0,100)}`;
            // If still ambiguous after debate, trigger subAgent recursion
            if (conf >= 0.4 && conf <= 0.6) {
              try {
                const subResult = await cfg.subAgent(`Decompose this ambiguous claim into sub-claims and evaluate each: "${claimText}"`);
                if (subResult && typeof subResult === 'object' && 'confidence' in (subResult as Record<string,unknown>)) {
                  conf = Number((subResult as Record<string,unknown>).confidence) ?? conf;
                  reasoning += ` | RECURSIVE: ${String((subResult as Record<string,unknown>).reasoning||'').slice(0,100)}`;
                }
              } catch { /* subAgent unavailable */ }
            }
          } catch {}
        }
        
        store.recordVerdict({ claimId, agentId, confidence: conf, reasoning });
        return { aggregate: { confidence: conf, consensus: conf >= 0.3 && conf <= 0.7 ? 0.7 : 1, divergence: Math.abs(conf - 0.5) } };
      },
      state: () => {
        const me = store.getAgent(agentId);
        return { ...store.counters(), balance: me?.balance ?? 0, reputation: me?.reputation ?? 0.5 };
      },
      subAgent: (prompt: string) => cfg.subAgent(String(prompt)),
      llm: (prompt: string) => cfg.llm(String(prompt)),
      recall: async (query: string) => {
        if (!cfg.recall) return "recall disabled (no recall hook configured)";
        try { return await cfg.recall(String(query)); }
        catch (e) { return "recall error: " + String(e); }
      },
      source: () => `MARKETPLACE CODEBASE (20 TypeScript files):
  store/ — SQLite db + schema   market/ — LMSR math
  engine/ — agent, sandbox, codegen, harness, budget
  server/ — HTTP+WS API, cards, metrics
  diversity/ — embeddings, Hill diversity
  optimize/ — GEPA prompt optimization
  public/ — web UI (index.html, app.js)
  State: propose→evidence→evaluate→recurse(ambiguous)→trade→nominate(0.7/0.3)→adjudicate→GEPA`,
      target: cfg.target ? {
        list: (glob?: string) => cfg.target!.list(glob),
        read: (path: string, offset = 0, maxBytes = 32768) => cfg.target!.read(path, offset, maxBytes),
      } : undefined,
      Final: undefined as unknown,
    };

    this.context = createContext(this.box, { codeGeneration: { strings: false, wasm: false } });
  }

  async execute(code: string): Promise<ExecResult> {
    this.captured = "";
    this.box["Final"] = undefined;  // Reset Final between iterations — prevents stale state leak
    let error: string | null = null;
    let timedOut = false;

    const wrapped = `(async () => {\n${code}\n})()`;

    try {
      const run = runInContext(wrapped, this.context, { timeout: this.timeoutMs }) as Promise<unknown>;
      await Promise.race([
        run,
        new Promise((_, reject) => setTimeout(() => reject(new Error("__SANDBOX_TIMEOUT__")), this.timeoutMs)),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("__SANDBOX_TIMEOUT__") || msg.includes("timed out")) {
        timedOut = true;
        error = `[TIMEOUT after ${this.timeoutMs / 1000}s]`;
      } else {
        error = `[ERROR: ${msg}]`;
      }
      this.captured += `\n${error}\n`;
    }

    const stdout = this.captured + (error ? `\n[ERROR: ${error}]` : "");
    const hasFinal = this.box["Final"] !== undefined && this.box["Final"] !== null;
    const stdoutTruncated = stdout.length > TRUNCATE_STDOUT
      ? stdout.slice(0, TRUNCATE_STDOUT) + `\n... [${stdout.length} total chars]`
      : stdout;

    return { stdout, stdoutTruncated, error, timedOut, hasFinal };
  }

  getFinal(): unknown {
    return this.box["Final"];
  }
}
