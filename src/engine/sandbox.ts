import { createContext, runInContext, type Context } from "node:vm";
import type { Store } from "../store/store.js";

const TRUNCATE_STDOUT = 1000;

export interface SandboxConfig {
  store: Store;
  agentId: string;
  subAgent: (prompt: string) => Promise<unknown>;
  llm: (prompt: string) => Promise<string>;
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
      state: () => {
        const me = store.getAgent(agentId);
        return { ...store.counters(), balance: me?.balance ?? 0, reputation: me?.reputation ?? 0.5 };
      },
      subAgent: (prompt: string) => cfg.subAgent(String(prompt)),
      llm: (prompt: string) => cfg.llm(String(prompt)),
      Final: undefined as unknown,
    };

    this.context = createContext(this.box, { codeGeneration: { strings: false, wasm: false } });
  }

  async execute(code: string): Promise<ExecResult> {
    this.captured = "";
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
        error = msg;
      }
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
