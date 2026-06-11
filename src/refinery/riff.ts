import { ax } from "@ax-llm/ax";
import type { Store } from "../store/store.js";
import type { AxLLM } from "../engine/codegen.js";

const riffSig = ax(
  "text:string, context:string -> rulings_json:string \"JSON array of {claimId, confidence, reason, quote}\", claims_json:string \"JSON array of {text, evidence}\", taste_text:string \"free-text taste observation\"",
);

export interface Interpretation {
  id?: number;
  kind: "ruling" | "new_claim" | "taste";
  claimId?: string;
  confidence?: number;
  reason?: string;
  quote?: string;
  text?: string;
  status: "pending" | "confirmed" | "rejected";
}

export async function compileRiff(
  store: Store,
  riffText: string,
  llm: AxLLM,
): Promise<Interpretation[]> {
  const results: Interpretation[] = [];

  // Build context: open claims + current briefs
  const ideas = store.listIdeas().slice(0, 20);
  const contextItems: string[] = [];
  for (const idea of ideas) {
    for (const cid of idea.claimIds.slice(0, 2)) {
      const claim = store.getClaim(cid);
      const market = store.getMarket(cid);
      if (claim) contextItems.push(`claim:${cid} text:${claim.text} price:${market?.yesPrice.toFixed(2) ?? "?"}`);
    }
  }
  const context = contextItems.join("\n").slice(0, 3000);

  try {
    const res = await riffSig.forward(llm, { text: riffText.slice(0, 2000), context });

    // Parse rulings
    const rulingsJson = String(res.rulings_json ?? "[]");
    let rulings: Array<{ claimId: string; confidence: number; reason: string; quote?: string }> = [];
    try { rulings = JSON.parse(rulingsJson); } catch { /* ignore parse errors */ }

    for (const r of rulings) {
      if (!r.claimId) continue;
      const conf = Math.max(0, Math.min(1, Number(r.confidence ?? 0.5)));
      const reason = String(r.reason ?? "").slice(0, 500);
      const quote = String(r.quote ?? "").slice(0, 300);

      const row = store.db.prepare("INSERT INTO interpretations (claim_id, kind, confidence, reason, quote, status, created_at) VALUES (?,?,?,?,?,?,?)").run(r.claimId, "ruling", conf, reason, quote, "pending", Date.now());
      results.push({ id: Number(row.lastInsertRowid), kind: "ruling", claimId: r.claimId, confidence: conf, reason, quote, status: "pending" });
    }

    // Parse new claims
    const claimsJson = String(res.claims_json ?? "[]");
    let newClaims: Array<{ text: string; evidence?: string }> = [];
    try { newClaims = JSON.parse(claimsJson); } catch { /* ignore parse errors */ }

    for (const c of newClaims) {
      const text = String(c.text ?? "").slice(0, 500);
      if (!text) continue;
      const row = store.db.prepare("INSERT INTO interpretations (kind, reason, quote, status, created_at) VALUES (?,?,?,?,?)").run("new_claim", text, String(c.evidence ?? "").slice(0, 500), "pending", Date.now());
      results.push({ id: Number(row.lastInsertRowid), kind: "new_claim", text, reason: String(c.evidence ?? ""), status: "pending" });
    }

    // Taste statement
    const tasteText = String(res.taste_text ?? "").slice(0, 500);
    if (tasteText) {
      store.db.prepare("INSERT INTO taste_statements (text, created_at) VALUES (?,?)").run(tasteText, Date.now());
      const row = store.db.prepare("INSERT INTO interpretations (kind, reason, status, created_at) VALUES (?,?,?,?)").run("taste", tasteText, "pending", Date.now());
      results.push({ id: Number(row.lastInsertRowid), kind: "taste", text: tasteText, status: "pending" });
    }
  } catch {
    // Riff failed — that's a valid outcome (empty interpretations)
  }

  return results;
}

/** Confirm ghost interpretations in batch. Calls applyAdjudication where applicable. */
export function confirmInterpretations(
  store: Store,
  confirmed: Array<{ id: number; accepted: boolean; confidenceOverride?: number }>,
): Array<{ id: number; ok: boolean }> {
  const results: Array<{ id: number; ok: boolean }> = [];
  for (const c of confirmed) {
    const row = store.db.prepare("SELECT claim_id, kind, confidence, reason FROM interpretations WHERE id=? AND status='pending'").get(c.id) as { claim_id: string | null; kind: string; confidence: number; reason: string } | undefined;
    if (!row) { results.push({ id: c.id, ok: false }); continue; }

    if (!c.accepted) {
      store.db.prepare("UPDATE interpretations SET status='rejected' WHERE id=?").run(c.id);
      results.push({ id: c.id, ok: true });
      continue;
    }

    store.db.prepare("UPDATE interpretations SET status='confirmed' WHERE id=?").run(c.id);

    // Rulings: apply graded adjudication
    if (row.kind === "ruling" && row.claim_id) {
      const confidence = c.confidenceOverride ?? row.confidence;
      try {
        store.applyAdjudication(row.claim_id, confidence > 0.5);
        // Update adjudication with graded confidence + reason + source
        store.db.prepare("UPDATE adjudications SET confidence=?, reason=?, source='riff' WHERE claim_id=?").run(confidence, row.reason, row.claim_id);
      } catch { /* already resolved */ }
    }

    // New claims: propose as ideas
    if (row.kind === "new_claim" && row.reason) {
      try {
        const claimText = row.reason; // reason field stores the claim text for new_claim kind
        store.propose({ title: claimText.slice(0, 80), summary: "", body: "", claims: [claimText], author: "riff" });
      } catch { /* duplicate or invalid */ }
    }

    results.push({ id: c.id, ok: true });
  }
  return results;
}
