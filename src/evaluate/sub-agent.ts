import { type Verdict } from "../types/deliberation.js";

export type ProviderId = "deepseek" | "anthropic" | "openai" | "mistral" | "openrouter";

export interface ProviderConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  deepseek: {
    apiBase: "https://api.deepseek.com/v1",
    apiKey: process.env["DEEPSEEK_API_KEY"] ?? "",
    model: "deepseek-chat",
  },
  anthropic: {
    apiBase: "https://api.anthropic.com/v1",
    apiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
    model: "claude-sonnet-4-20250514",
  },
  openai: {
    apiBase: "https://api.openai.com/v1",
    apiKey: process.env["OPENAI_API_KEY"] ?? "",
    model: "gpt-4o-mini",
  },
  mistral: {
    apiBase: "https://api.mistral.ai/v1",
    apiKey: process.env["MISTRAL_API_KEY"] ?? "",
    model: "mistral-large-latest",
  },
  openrouter: {
    apiBase: "https://openrouter.ai/api/v1",
    apiKey: process.env["OPENROUTER_API_KEY"] ?? "",
    model: "openai/gpt-4o",
  },
};

const SUB_AGENT_SYSTEM_PROMPT = `You are a sub-agent in a marketplace of ideas. Your sole job: evaluate ONE claim and return a VERDICT.

STRICT RULES:
1. You see ONLY this claim and its evidence. You do NOT know what other sub-agents think.
2. Base your confidence (0-1) on evidence quality, not hunches.
3. Strong evidence FOR the claim → confidence 0.8-0.95
4. Strong evidence AGAINST → confidence 0.05-0.2  
5. Balanced/mixed evidence → confidence 0.4-0.6
6. NO evidence → confidence 0.5 exactly (you genuinely don't know)
7. Be decisive. Don't hedge. If evidence points one way, say so.
8. Your reasoning MUST cite specific evidence items.

Respond with ONLY this JSON (no markdown, no backticks):
{
  "confidence": 0.73,
  "reasoning": "The three studies cited show a clear causal link, though sample sizes are small which tempers confidence slightly.",
  "strengths": ["multiple independent studies", "peer-reviewed"],
  "weaknesses": ["small sample sizes", "correlational not experimental"]
}`;

function buildClaimPrompt(claimText: string, evidence: { supporting: string[]; counter: string[] }): string {
  let prompt = `CLAIM TO EVALUATE:\n"${claimText}"\n\n`;

  const sup = evidence.supporting;
  const cnt = evidence.counter;

  if (sup.length > 0) {
    prompt += `SUPPORTING EVIDENCE (${sup.length} items):\n`;
    sup.forEach((e, i) => { prompt += `  [S${i + 1}] ${e}\n`; });
    prompt += "\n";
  } else {
    prompt += "SUPPORTING EVIDENCE: (none)\n\n";
  }

  if (cnt.length > 0) {
    prompt += `COUNTER EVIDENCE (${cnt.length} items):\n`;
    cnt.forEach((e, i) => { prompt += `  [C${i + 1}] ${e}\n`; });
    prompt += "\n";
  } else {
    prompt += "COUNTER EVIDENCE: (none)\n\n";
  }

  prompt += "Return ONLY the JSON verdict.";
  return prompt;
}

export interface EvaluateResult {
  verdict: Verdict;
  provider: ProviderId;
  model: string;
  raw: string;
  cost: number;
}

async function callProvider(
  provider: ProviderId,
  claimText: string,
  evidence: { supporting: string[]; counter: string[] },
): Promise<{ content: string }> {
  const cfg = PROVIDERS[provider];
  if (!cfg.apiKey) {
    throw new Error(`No API key for provider: ${provider}`);
  }

  const userPrompt = buildClaimPrompt(claimText, evidence);

  const isAnthropic = provider === "anthropic";
  const isMistral = provider === "mistral";

  let headers: Record<string, string>;
  let body: Record<string, unknown>;

  if (isAnthropic) {
    headers = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = {
      model: cfg.model,
      max_tokens: 500,
      temperature: 0.1,
      system: SUB_AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    };
  } else {
    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.apiKey}`,
    };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "marketplace-of-ideas";
      headers["X-Title"] = "Marketplace of Ideas";
    }
    body = {
      model: cfg.model,
      messages: [
        { role: "system", content: SUB_AGENT_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" },
    };
  }

  const endpoint = isAnthropic
    ? `${cfg.apiBase}/messages`
    : isMistral
      ? `${cfg.apiBase}/chat/completions`
      : `${cfg.apiBase}/chat/completions`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${provider} API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as Record<string, unknown>;

  if (isAnthropic) {
    const content = (data as { content: Array<{ type: string; text: string }> }).content;
    return { content: content.find(c => c.type === "text")?.text ?? "" };
  }

  const choices = data.choices as Array<{ message: { content: string } }>;
  return { content: choices[0]?.message?.content ?? "" };
}

function parseVerdictJson(raw: string, provider: ProviderId, claimId: string): { verdict: Verdict; parsed: Record<string, unknown> } {
  let parsed: { confidence?: number; reasoning?: string; strengths?: string[]; weaknesses?: string[] };

  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(`[${provider}] Could not parse verdict from: ${raw.slice(0, 200)}`);
    }
    parsed = JSON.parse(match[0]);
  }

  const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5));
  const reasoning = parsed.reasoning ?? "No reasoning provided";

  const verdict: Verdict = {
    claimId,
    agentId: `sub-${provider}`,
    confidence: Math.round(confidence * 1000) / 1000,
    reasoning,
    evidenceReviewed: [],
    timestamp: Date.now(),
  };

  return { verdict, parsed };
}

export async function evaluateClaim(
  claimId: string,
  claimText: string,
  evidence: { supporting: string[]; counter: string[] },
  provider: ProviderId = "deepseek",
): Promise<EvaluateResult> {
  const cfg = PROVIDERS[provider];
  const { content } = await callProvider(provider, claimText, evidence);
  const { verdict, parsed } = parseVerdictJson(content, provider, claimId);

  return {
    verdict,
    provider,
    model: cfg.model,
    raw: content,
    cost: content.length * 0.000001,
  };
}

export async function evaluateClaimMulti(
  claimId: string,
  claimText: string,
  evidence: { supporting: string[]; counter: string[] },
  providers: ProviderId[] = [],
): Promise<EvaluateResult[]> {
  const available = providers.length > 0
    ? providers
    : (Object.keys(PROVIDERS) as ProviderId[]).filter(p => PROVIDERS[p].apiKey);

  if (available.length === 0) {
    throw new Error("No providers available. Set at least one API key.");
  }

  const results = await Promise.allSettled(
    available.map(provider =>
      evaluateClaim(claimId, claimText, evidence, provider),
    ),
  );

  return results
    .filter((r): r is PromiseFulfilledResult<EvaluateResult> => r.status === "fulfilled")
    .map(r => r.value);
}

export function aggregateVerdicts(results: EvaluateResult[]): {
  verdict: Verdict;
  consensus: number;
  divergence: number;
  sources: ProviderId[];
} {
  if (results.length === 0) {
    return {
      verdict: { claimId: "", agentId: "aggregate", confidence: 0.5, reasoning: "No evaluations", evidenceReviewed: [], timestamp: Date.now() },
      consensus: 0,
      divergence: 0,
      sources: [],
    };
  }

  const confidences = results.map(r => r.verdict.confidence);
  const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const variance = confidences.reduce((sum, c) => sum + (c - mean) ** 2, 0) / confidences.length;
  const divergence = Math.sqrt(variance);
  const consensus = 1 - divergence;

  const sources = results.map(r => r.provider);
  const reasoningLines = results.map(r => `[${r.provider}/${r.model}] c=${r.verdict.confidence.toFixed(2)}: ${r.verdict.reasoning.slice(0, 100)}`);

  const verdict: Verdict = {
    claimId: results[0].verdict.claimId,
    agentId: `aggregate-${sources.join("+")}`,
    confidence: Math.round(mean * 1000) / 1000,
    reasoning: `Aggregated from ${results.length} evaluators (${sources.join(", ")}). Mean confidence: ${mean.toFixed(2)}, consensus: ${consensus.toFixed(2)}, divergence: ${divergence.toFixed(2)}.\n${reasoningLines.join("\n")}`,
    evidenceReviewed: [],
    timestamp: Date.now(),
  };

  return { verdict, consensus: Math.round(consensus * 1000) / 1000, divergence: Math.round(divergence * 1000) / 1000, sources };
}
