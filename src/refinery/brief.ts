import type { Store } from "../store/store.js";
import type { AxLLM } from "../engine/codegen.js";
import { ax } from "@ax-llm/ax";
import { embed, cosine } from "../diversity/embed.js";
import { buildZ, hillDiversity, marginalDiversity } from "../diversity/hill.js";

const briefSig = ax(
  "idea_title:string, claims_json:string, market_data:string, vault_context:string -> body:string \"markdown brief with strong form, evidence, counterarguments, open questions\"",
);

export interface Brief {
  ideaId: string;
  title: string;
  body: string;
  estimatedValue: number;  // V̂: market-derived value estimate
  tokensSpent: number;
}

/** Draft a brief for one idea from its deliberation record. */
export async function synthesizeBrief(
  store: Store, ideaId: string, llm: AxLLM, budget: { spend: (path: string, tokens: number) => void },
): Promise<Brief | null> {
  const idea = store.getIdea(ideaId);
  if (!idea) return null;

  const claims = idea.claimIds.map(cid => {
    const c = store.getClaim(cid);
    const m = store.getMarket(cid);
    return c ? { text: c.text, price: m?.yesPrice ?? 0.5, resolution: m?.resolution } : null;
  }).filter((c): c is NonNullable<typeof c> => c !== null);

  if (claims.length === 0) return null;

  // Build vault context from Z-relevant entries
  const vaultRows = store.db.prepare("SELECT id, title, body FROM vault_entries LIMIT 50").all() as Array<{ id: string; title: string; body: string }>;
  const ideaStr = `${idea.title} ${idea.summary}`;
  const relevant = vaultRows.filter(v => cosine(embed(ideaStr), embed(v.title + " " + v.body.slice(0, 500))) > 0.3).slice(0, 3);
  const vaultContext = relevant.map(v => `## ${v.title}\n${v.body.slice(0, 500)}`).join("\n\n");

  budget.spend("brief", 500);
  const claimsJson = JSON.stringify(claims.slice(0, 5));
  const marketData = claims.map(c => `${c.text}: price=${c.price.toFixed(2)}${c.resolution ? " resolved " + c.resolution : ""}`).join("\n");

  const res = await briefSig.forward(llm, { idea_title: idea.title, claims_json: claimsJson, market_data: marketData, vault_context: vaultContext });

  const estimatedValue = claims.reduce((s, c) => s + Math.abs(c.price - 0.5) * 2, 0) / Math.max(1, claims.length);

  return {
    ideaId, title: idea.title,
    body: String(res.body ?? idea.summary).slice(0, 5000),
    estimatedValue,
    tokensSpent: 500 + store.tokensSpent() * 0.01,
  };
}

/** Select up to N briefs maximizing J(p) = Σ V̂ + λ·log D_q^Z.
 *  Greedy selection (fine at this scale). */
export function selectBriefSet(briefs: Brief[], N = 3, lambda = 0.3, q = 2): Brief[] {
  if (briefs.length <= N) return briefs;

  const selected: Brief[] = [];
  const remaining = [...briefs];

  while (selected.length < N && remaining.length > 0) {
    let bestIdx = 0, bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const texts = [...selected, candidate].map(b => b.title);
      // Build Z from titles, uniform abundance
      const Z = buildZ(texts, (a, b) => cosine(embed(a), embed(b)));
      const p = texts.map(() => 1 / texts.length);
      const d = hillDiversity(p, Z, q);
      const sumV = selected.reduce((s, b) => s + b.estimatedValue, 0) + candidate.estimatedValue;
      const score = sumV + lambda * Math.log(Math.max(0.001, d));
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}
