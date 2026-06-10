import { JsRepl, type ReplResult } from "./repl.js";
import { RLM_SYSTEM_PROMPT, buildMetadata } from "./prompts.js";
import type { Idea, Claim, Evidence, Verdict, ClaimMarket, AgentState, Distillate } from "../types/deliberation.js";

interface RlmConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  maxIterations: number;
  verbose: boolean;
}

const DEFAULT_CONFIG: RlmConfig = {
  apiKey: process.env["DEEPSEEK_API_KEY"] ?? "",
  apiBase: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  maxIterations: 12,
  verbose: true,
};

async function callLLM(messages: Array<{ role: string; content: string }>, config: RlmConfig): Promise<string> {
  const res = await fetch(`${config.apiBase}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages, temperature: 0.2, max_tokens: 1200 }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LLM error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content ?? "";
}

function extractCode(response: string): string {
  const jsBlock = response.match(/```(?:javascript|js)\n?([\s\S]*?)```/);
  if (jsBlock) return jsBlock[1].trim();
  const noMarkers = response.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```$/i, "");
  return noMarkers.trim();
}

export interface RlmIteration {
  iteration: number;
  code: string;
  result: ReplResult;
}

export interface RlmRun {
  iterations: RlmIteration[];
  finalValue: unknown;
  success: boolean;
  error: string | null;
}

export async function runRlm(config: Partial<RlmConfig> = {}): Promise<RlmRun> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.apiKey) {
    return { iterations: [], finalValue: null, success: false, error: "No API key configured" };
  }

  const state: {
    ideas: Map<string, Idea>;
    claimsMap: Map<string, Claim>;
    evidenceMap: Map<string, Evidence[]>;
    verdictsMap: Map<string, Verdict[]>;
    markets: Map<string, ClaimMarket>;
    agents: Map<string, AgentState>;
    distillates: Distillate[];
  } = {
    ideas: new Map(),
    claimsMap: new Map(),
    evidenceMap: new Map(),
    verdictsMap: new Map(),
    markets: new Map(),
    agents: new Map(),
    distillates: [],
  };

  const repl = new JsRepl(state);
  const history: string[] = [];

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: RLM_SYSTEM_PROMPT },
  ];

  const iterations: RlmIteration[] = [];

  if (cfg.verbose) console.error("RLM loop starting (JS REPL, DeepSeek root agent)\n");

  for (let i = 0; i < cfg.maxIterations; i++) {
    const s = {
      ideas: state.ideas.size,
      claims: state.claimsMap.size,
      active_markets: Array.from(state.markets.values()).filter(m => !m.resolution).length,
      settled_markets: Array.from(state.markets.values()).filter(m => m.resolution).length,
      agents: Array.from(state.agents.values()).map(a => ({ id: a.agentId, rep: +a.reputation.toFixed(2), bal: +a.tokenBalance.toFixed(0) })),
      distillates: state.distillates.length,
    };

    const metadata = buildMetadata(s as unknown as Record<string, unknown>, history);
    messages.push({ role: "user", content: metadata });

    if (cfg.verbose) {
      console.error(`\n─── Iteration ${i + 1}/${cfg.maxIterations} ───`);
      console.error(`State: ${s.ideas} ideas, ${s.claims} claims, ${s.active_markets} active, ${s.settled_markets} settled`);
    }

    let code: string;
    try {
      const response = await callLLM(messages, cfg);
      code = extractCode(response);
    } catch (err) {
      return { iterations, finalValue: null, success: false, error: `LLM call failed: ${String(err)}` };
    }

    if (cfg.verbose) {
      console.error(`\nLLM code (${code.split("\n").length} lines):`);
      console.error("```js");
      console.error(code.slice(0, 700));
      if (code.length > 700) console.error(`... [${code.length - 700} more chars]`);
      console.error("```");
    }

    const result = await repl.execute(code);

    messages.push({ role: "assistant", content: code });
    history.push(code);
    history.push(result.stdoutTruncated);

    iterations.push({ iteration: i, code, result });

    if (cfg.verbose) {
      console.error(`\nOUTPUT (${result.stdout.length} chars):`);
      console.error(result.stdoutTruncated.slice(0, 500));
      if (result.timedOut) console.error("  ⚠ TIMEOUT");
      if (result.hasFinal) console.error("  ✓ Final set");
    }

    if (result.hasFinal) {
      const finalVal = repl.getFinal();
      if (cfg.verbose) console.error("\n✓ RLM loop complete. Final set.");
      return { iterations, finalValue: finalVal, success: true, error: null };
    }
  }

  return { iterations, finalValue: null, success: false, error: `Max iterations (${cfg.maxIterations}) reached` };
}
