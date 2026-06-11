import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/store.js";
import { embed, cosine } from "../diversity/embed.js";
import { buildZ, hillDiversity } from "../diversity/hill.js";

export function writeDossier(store: Store, targetPath: string): string | null {
  const sessionId = store.db.prepare("SELECT MAX(id) as id FROM sessions").get() as { id: number } | undefined;
  if (!sessionId?.id) return null;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(targetPath, "enrichments", ts);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "claims"), { recursive: true });

  const ideas = store.db.prepare(
    "SELECT i.id, i.title, i.status FROM ideas i WHERE i.id IN (SELECT DISTINCT c.idea_id FROM claims c JOIN agent_iterations ai ON 1=1 WHERE ai.session_id=?) ORDER BY i.id DESC",
  ).all(sessionId.id) as Array<{ id: string; title: string; status: string }>;

  if (ideas.length === 0) {
    writeFileSync(join(outDir, "DOSSIER.md"), "# Enrichment Dossier\n\nNo findings produced.\n");
    writeRunJson(outDir, sessionId.id, store, 0);
    return outDir;
  }

  // Build findings with evidence
  const findings: Array<{
    id: string; title: string;
    claims: Array<{ text: string; price: number; evidence: Array<{ excerpt: string; stance: string }>; verdicts: Array<{ confidence: number; reasoning: string }> }>;
    totalValue: number;
  }> = [];

  for (const idea of ideas) {
    const cids = store.db.prepare("SELECT id, text FROM claims WHERE idea_id=? LIMIT 5").all(idea.id) as Array<{ id: string; text: string }>;
    const claimData: typeof findings[0]["claims"] = [];
    let totalValue = 0;

    for (const c of cids) {
      const m = store.getMarket(c.id);
      const price = m?.yesPrice ?? 0.5;
      const ev = store.listEvidence(c.id).slice(0, 3);
      const vs = store.db.prepare("SELECT confidence, reasoning FROM verdicts WHERE claim_id=? ORDER BY id DESC LIMIT 2").all(c.id) as Array<{ confidence: number; reasoning: string }>;

      claimData.push({
        text: c.text,
        price,
        evidence: ev.map(e => ({ excerpt: e.excerpt.slice(0, 200), stance: e.stance })),
        verdicts: vs.map(v => ({ confidence: v.confidence, reasoning: v.reasoning.slice(0, 200) })),
      });
      totalValue += Math.abs(price - 0.5);
    }

    findings.push({ id: idea.id, title: idea.title, claims: claimData, totalValue });
  }

  // J(p) diversity selection: pick up to 5 diverse findings
  const selected = selectDiverse(findings, 5);

  // Write per-claim files
  for (const f of findings) {
    for (const c of f.claims) {
      const md = [
        `# ${f.title}`,
        "",
        `**Claim**: ${c.text}`,
        `**Market confidence**: ${(c.price * 100).toFixed(0)}% (price: ${c.price.toFixed(2)})`,
        "",
        "## Evidence",
        ...c.evidence.map(e => `- ${e.excerpt}`),
        "",
        "## Evaluations",
        ...c.verdicts.map(v => `- confidence: ${v.confidence.toFixed(2)} — ${v.reasoning}`),
      ].join("\n");
      writeFileSync(join(outDir, "claims", `${f.id}.md`), md);
    }
  }

  // Write DOSSIER.md
  const dossier = [
    "# Enrichment Dossier",
    `Generated: ${new Date().toISOString()}`,
    `Target: ${targetPath}`,
    `Session: ${sessionId.id}`,
    `Findings: ${findings.length} total, ${selected.length} selected (diversity-ranked)`,
    "",
    ...selected.map((f, i) => {
      const bestClaim = f.claims.sort((a, b) => Math.abs(b.price - 0.5) - Math.abs(a.price - 0.5))[0];
      const provenance = f.claims.flatMap(c => c.evidence).filter(e => e.excerpt.startsWith("target:")).length;
      return [
        `## ${i + 1}. ${f.title}`,
        `*Value: ${f.totalValue.toFixed(2)} | Claims: ${f.claims.length} | Grounded evidence: ${provenance}*`,
        "",
        bestClaim ? `**Key claim**: ${bestClaim.text} (confidence: ${(bestClaim.price * 100).toFixed(0)}%)` : "",
        "",
        ...f.claims.flatMap(c => [
          `### ${c.text.slice(0, 80)}`,
          `- Price: ${c.price.toFixed(2)}`,
          ...c.evidence.slice(0, 2).map(e => `  - [${e.stance.slice(0, 1)}] ${e.excerpt.slice(0, 100)}`),
          ...c.verdicts.slice(0, 1).map(v => `  - Evaluated: ${v.confidence.toFixed(2)} — ${v.reasoning.slice(0, 100)}`),
          "",
        ]),
      ].join("\n");
    }),
  ].join("\n");
  writeFileSync(join(outDir, "DOSSIER.md"), dossier);

  // Write run.json
  writeRunJson(outDir, sessionId.id, store, findings.length);

  return outDir;
}

function selectDiverse<T extends { id: string; title: string; totalValue: number }>(items: T[], N: number): T[] {
  if (items.length <= N) return items;
  const selected: T[] = [items[0]];
  const remaining = items.slice(1);

  while (selected.length < N && remaining.length > 0) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const texts = [...selected, remaining[i]].map(f => f.title);
      const Z = buildZ(texts, (a, b) => cosine(embed(a), embed(b)));
      const p = texts.map(() => 1 / texts.length);
      const d = hillDiversity(p, Z, 2);
      const sumV = selected.reduce((s, f) => s + f.totalValue, 0) + remaining[i].totalValue;
      const score = sumV + 0.3 * Math.log(Math.max(0.001, d));
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

function writeRunJson(outDir: string, sessionId: number, store: Store, findingCount: number) {
  const tokens = store.db.prepare("SELECT COALESCE(SUM(tokens),0) as n FROM budget_ledger").get() as { n: number };
  const iters = store.db.prepare("SELECT COUNT(*) as n FROM agent_iterations WHERE session_id=?").get(sessionId) as { n: number };
  writeFileSync(join(outDir, "run.json"), JSON.stringify({
    sessionId,
    timestamp: new Date().toISOString(),
    findings: findingCount,
    iterations: iters.n,
    tokensSpent: tokens.n,
  }, null, 2));
}
