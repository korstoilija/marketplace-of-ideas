import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/store.js";
import { embed, cosine } from "../diversity/embed.js";
import { marginalDiversity } from "../diversity/hill.js";

export interface VaultEntry {
  id: string;
  title: string;
  body: string;
  author: string;
  value: number;
  lineage: string[];
  claims: Array<{ text: string; confidence: number; reason: string }>;
}

/** Accept a brief into the vault. Writes .md file + store rows + pays bounties. */
export function acceptToVault(
  store: Store,
  entry: VaultEntry,
  vaultDir = "vault",
): { ok: boolean; bountyPaid: number } {
  // Write the vault .md file
  const filename = entry.id.replace(/[^a-zA-Z0-9_-]/g, "-") + ".md";
  mkdirSync(vaultDir, { recursive: true });
  const mdPath = join(vaultDir, filename);
  const md = [
    `# ${entry.title}`,
    "",
    entry.body,
    "",
    "## Claims",
    ...entry.claims.map(c => `- **${c.text}** (confidence: ${c.confidence.toFixed(2)}) — ${c.reason}`),
    "",
    `*Accepted: ${new Date().toISOString()} | Value: ${entry.value.toFixed(2)} | Author: ${entry.author}*`,
    entry.lineage.length ? `\n*Lineage: ${entry.lineage.join(" → ")}*` : "",
  ].join("\n");
  writeFileSync(mdPath, md);

  // Store vault entry
  store.db.prepare("INSERT OR REPLACE INTO vault_entries (id, title, body, author, value, lineage_json, accepted_at) VALUES (?,?,?,?,?,?,?)").run(
    entry.id, entry.title, entry.body, entry.author, entry.value, JSON.stringify(entry.lineage), Date.now(),
  );

  // Compute bounty: K × V_human × max(0, Δ_norm)
  const K = 1000; // base bounty
  const V_human = entry.value;
  
  // Get all vault entries for diversity computation
  const allEntries = store.db.prepare("SELECT id, body FROM vault_entries").all() as Array<{ id: string; body: string }>;
  const popTexts = allEntries.filter(e => e.id !== entry.id).map(e => `${e.id}: ${e.body.slice(0, 500)}`);
  
  let deltaDiversity = 0;
  if (popTexts.length > 0) {
    const x = `${entry.id}: ${entry.body.slice(0, 500)}`;
    deltaDiversity = marginalDiversity(x, popTexts, (a, b) => cosine(embed(a), embed(b)), 2);
  } else {
    deltaDiversity = 1.0; // First entry is maximally diverse
  }

  const bounty = K * V_human * Math.max(0, deltaDiversity);

  // Pay bounties along lineage
  if (entry.lineage.length > 0 && deltaDiversity > 0) {
    const split = 1 / entry.lineage.length;
    for (const agentId of entry.lineage) {
      store.db.prepare("INSERT INTO bounties (vault_entry_id, agent_id, amount, delta_diversity, created_at) VALUES (?,?,?,?,?)").run(
        entry.id, agentId, bounty * split, deltaDiversity, Date.now(),
      );
      // Pay into agent wallet
      try {
        store.db.prepare("UPDATE agents SET balance = balance + ? WHERE agent_id = ?").run(bounty * split, agentId);
      } catch { /* agent may not exist */ }
    }
  }

  return { ok: true, bountyPaid: bounty };
}

/** List vault entries for browsing. */
export function listVault(store: Store): Array<{ id: string; title: string; author: string; value: number; acceptedAt: number }> {
  return (store.db.prepare("SELECT id, title, author, value, accepted_at FROM vault_entries ORDER BY accepted_at DESC LIMIT 50").all() as Array<any>).map(r => ({
    id: r.id, title: r.title, author: r.author, value: r.value, acceptedAt: r.accepted_at,
  }));
}

/** Get a single vault entry. */
export function getVaultEntry(store: Store, id: string): VaultEntry | null {
  const r = store.db.prepare("SELECT * FROM vault_entries WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: r.id as string, title: r.title as string, body: r.body as string,
    author: r.author as string, value: r.value as number,
    lineage: JSON.parse(r.lineage_json as string || "[]") as string[],
    claims: [],
  };
}
