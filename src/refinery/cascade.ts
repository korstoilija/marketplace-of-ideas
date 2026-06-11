import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Store } from "../store/store.js";
import { embed, cosine } from "../diversity/embed.js";
import type { AxLLM } from "../engine/codegen.js";
import { BudgetGuard } from "../engine/budget.js";
import { ax } from "@ax-llm/ax";

const tier1Sig = ax(
  "text:string -> claims_json:string \"JSON array of {text, confidence}\", coherence_score:number",
);

export interface CascadeResult {
  tier1Count: number;
  escalatedCount: number;
  killedByZ: number;
  killedByCoherence: number;
  runId: string;
}

/** Tier 0: scan sources for changes. Reuses existing store methods. */
export function scanSources(store: Store): Array<{ id: number; path: string; text: string }> {
  const items: Array<{ id: number; path: string; text: string }> = [];
  for (const src of store.listSources()) {
    try {
      const stat = statSync(src.path);
      const mtime = stat.mtimeMs;
      const content = readFileSync(src.path, "utf8").slice(0, 50_000);
      const hash = createHash("sha256").update(content).digest("hex");
      if (hash !== src.lastHash || mtime !== (src.lastMtime || 0)) {
        store.updateSourceScan(src.id, hash, mtime);
        items.push({ id: src.id, path: src.path, text: content });
      }
    } catch { /* file gone, skip */ }
  }
  return items;
}

/** Tier 1: decompose text into candidate claims with Z-gate and coherence gate. */
export async function tier1Decompose(
  store: Store,
  items: Array<{ id: number; path: string; text: string }>,
  llm: AxLLM,
  budget: BudgetGuard,
  opts: { zThreshold?: number; coherenceThreshold?: number; runId?: string } = {},
): Promise<{ escalated: Array<{ id: number; claimsJson: string; confidence: number }>; killedByZ: number; killedByCoherence: number; tier1Count: number }> {
  const zThreshold = opts.zThreshold ?? 0.85;
  const coherenceThreshold = opts.coherenceThreshold ?? 0.3;
  const runId = opts.runId ?? `refine-${Date.now()}`;

  let killedByZ = 0, killedByCoherence = 0, tier1Count = 0;
  const escalated: Array<{ id: number; claimsJson: string; confidence: number }> = [];

  // Get existing vault + open idea texts for Z-gate
  const vaultItems = (store.db.prepare("SELECT body FROM vault_entries LIMIT 100").all() as Array<{ body: string }>).map(r => r.body.slice(0, 500));
  const openIdeas = store.listIdeas().slice(0, 50);
  const existingTexts = [...vaultItems, ...openIdeas.map(i => i.title)];

  for (const item of items) {
    if (!budget.canSpend(10)) break;
    budget.spend("tier1", 10);

    // Z-gate: check max similarity against existing vault + open ideas
    if (existingTexts.length > 0) {
      let maxSim = 0;
      const itemVec = embed(item.text.slice(0, 500));
      for (const existing of existingTexts) {
        const sim = cosine(itemVec, embed(existing.slice(0, 500)));
        if (sim > maxSim) maxSim = sim;
      }
      if (maxSim > zThreshold) {
        killedByZ++;
        store.insertTier1Item({ sourceId: item.id, text: item.text.slice(0, 2000), claimsJson: "[]", maxSimilarity: maxSim, escalated: false, runId });
        continue;
      }
    }

    // Tier 1 LLM decomposition
    tier1Count++;
    let claimsJson = "[]", coherenceScore = 0.5, confidence = 0.5;
    try {
      const res = await tier1Sig.forward(llm, { text: item.text.slice(0, 3000) });
      claimsJson = String(res.claims_json ?? "[]");
      coherenceScore = Math.max(0, Math.min(1, Number(res.coherence_score ?? 0.5)));

      // Compute average confidence from claims
      let parsed: Array<{ confidence?: number }> = [];
      try { parsed = JSON.parse(claimsJson); } catch { /* ignore parse errors */ }
      const confs = parsed.filter(c => typeof c.confidence === "number").map(c => c.confidence as number);
      confidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0.5;
    } catch { /* decompose failed */ }

    // Coherence gate (the β term in the spec)
    const passesCoherence = coherenceScore >= coherenceThreshold;
    if (!passesCoherence) killedByCoherence++;

    // Escalation score = uncertainty × stakes
    // uncertainty: distance from 0.5, stakes: 1 - similarity to existing ideas (novel = higher stakes)
    const uncertainty = Math.abs(confidence - 0.5);
    const novelty = killedByZ === 0 ? 1 - zThreshold : 0;
    const escalationScore = uncertainty * 0.6 + novelty * 0.4;

    const shouldEscalate = passesCoherence && escalationScore > 0.15;

    store.insertTier1Item({
      sourceId: item.id, text: item.text.slice(0, 2000), claimsJson,
      confidence, coherenceScore, escalated: shouldEscalate, runId,
    });

    if (shouldEscalate) {
      escalated.push({ id: item.id, claimsJson, confidence });
    }
  }

  return { escalated, killedByZ, killedByCoherence, tier1Count };
}
