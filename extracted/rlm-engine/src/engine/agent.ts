import { Sandbox, type ExecResult } from "./sandbox.js";
import type { Store } from "../store/store.js";

export interface CodeGenInputs { task: string; persona: string; stateMetadata: string; historyText: string }
export type CodeGenerator = (inputs: CodeGenInputs) => Promise<string>;
export type LeafEvaluator = (prompt: string) => Promise<{ confidence: number; reasoning: string }>;

export interface AgentConfig {
  agentId: string;
  persona: string;
  task: string;
  store: Store;
  codegen: CodeGenerator;
  leafEvaluator: LeafEvaluator;
  llm: (prompt: string) => Promise<string>;
  maxIterations: number;
  maxDepth: number;
  maxSubAgentCalls: number;
  sandboxTimeoutMs: number;
  depth?: number;
  onIteration?: (agentId: string, iteration: number) => void;
  recall?: (query: string) => Promise<string>;
  recordIteration?: (rec: { agentId: string; depth: number; iteration: number; code: string; stdout: string; timedOut: boolean; hasFinal: boolean }) => void;
}

export interface AgentRun {
  agentId: string;
  final: unknown;
  iterations: Array<{ code: string; result: ExecResult }>;
}

const HISTORY_ENTRY_CHARS = 300;
const HISTORY_ENTRIES = 8;

export class RlmAgent {
  private cfg: AgentConfig;
  private depth: number;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.depth = cfg.depth ?? 0;
  }

  async run(): Promise<AgentRun> {
    const { store, agentId } = this.cfg;
    store.ensureAgent(agentId);

    let subCallsThisIteration = 0;

    const subAgent = async (prompt: string): Promise<unknown> => {
      if (subCallsThisIteration >= this.cfg.maxSubAgentCalls) {
        throw new Error(`sub-agent budget exhausted (max ${this.cfg.maxSubAgentCalls} per iteration)`);
      }
      subCallsThisIteration++;
      if (this.depth >= this.cfg.maxDepth) {
        return this.cfg.leafEvaluator(prompt);
      }
      const child = new RlmAgent({
        ...this.cfg,
        task: prompt,
        depth: this.depth + 1,
      });
      const childRun = await child.run();
      return childRun.final;
    };

    const sandbox = new Sandbox({
      store,
      agentId,
      subAgent,
      llm: this.cfg.llm,
      recall: this.cfg.recall,
      timeoutMs: this.cfg.sandboxTimeoutMs,
    });

    const history: string[] = [];
    const iterations: Array<{ code: string; result: ExecResult }> = [];

    for (let i = 0; i < this.cfg.maxIterations; i++) {
      subCallsThisIteration = 0;
      const code = await Promise.race([
        this.cfg.codegen({
          task: this.cfg.task,
          persona: this.cfg.persona,
          stateMetadata: this.buildMetadata(),
          historyText: history.slice(-HISTORY_ENTRIES).join("\n"),
        }),
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error("codegen timed out after 120s")), 120_000)),
      ]);

      const result = await sandbox.execute(code);
      iterations.push({ code, result });
      this.cfg.recordIteration?.({ agentId, depth: this.depth, iteration: i, code, stdout: result.stdout, timedOut: result.timedOut, hasFinal: result.hasFinal });
      history.push(`[code ${i}] ${code.slice(0, HISTORY_ENTRY_CHARS)}`);
      const hasError = result.stdout.includes("ERROR") || result.stdout.includes("ReferenceError") || result.stdout.includes("TypeError");
      if (hasError) {
        history.push(`[out ${i}] ⚠ YOUR LAST CODE FAILED: ${result.stdout.slice(0, HISTORY_ENTRY_CHARS)}`);
      } else {
        history.push(`[out ${i}] ${result.stdoutTruncated.slice(0, HISTORY_ENTRY_CHARS)}`);
      }
      this.cfg.onIteration?.(agentId, i);

      if (result.hasFinal) {
        return { agentId, final: sandbox.getFinal(), iterations };
      }
    }
    return { agentId, final: null, iterations };
  }

  private buildMetadata(): string {
    const { store, agentId } = this.cfg;
    const c = store.counters();
    const me = store.getAgent(agentId);
    const hot = store.listIdeas().slice(-3)
      .flatMap(i => i.claimIds.slice(0, 2))
      .map(cid => `${cid}=${store.getMarket(cid)?.yesPrice.toFixed(2) ?? "?"}`)
      .join(" ");
    return `ideas=${c.ideas} claims=${c.claims} open=${c.openMarkets} resolved=${c.resolvedMarkets} ` + `balance=${me?.balance.toFixed(0)} reputation=${me?.reputation.toFixed(2)} depth=${this.depth} prices: ${hot}`;
  }
}
