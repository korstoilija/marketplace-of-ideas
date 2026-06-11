#!/usr/bin/env node
const API = `http://127.0.0.1:${process.env["MP_PORT"] ?? 4280}`;

async function api(path: string, opts?: RequestInit) {
  try {
    const res = await fetch(`${API}${path}`, opts);
    return await res.json();
  } catch (e) {
    console.error("Server not running. Start with: npm start");
    process.exit(1);
  }
}

function out(j: unknown) { console.log(JSON.stringify(j, null, 2)); }

async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  const help = `mp — Marketplace of Ideas CLI

  mp session <topic>           Launch a deliberation session
  mp state                     Show marketplace state
  mp ideas                     List active ideas
  mp approve <idea-id>         Approve a pending idea
  mp dismiss <idea-id>         Dismiss a pending idea
  mp adjudicate <claim-id> <t|f>  Rule on a claim (true/false)
  mp queue                     Show adjudication queue
  mp riff "<text>"             Submit editorial feedback
  mp refine                    Run the cascade pipeline
  mp vault                     List vault entries
  mp vault accept <title> <body>  Accept an idea into the vault
  mp sessions                  List past sessions
  mp metrics                   Show calibration metrics
  mp export                    Export all transcripts as JSONL
  mp self-improve              Run self-improvement analysis`;

  if (!cmd || cmd === "help") { console.log(help); process.exit(0); }

  switch (cmd) {
    case "state": {
      const s = await api("/api/state");
      console.log(`ideas: ${s.summary.ideas}  claims: ${s.summary.claims}  open: ${s.summary.openMarkets}  resolved: ${s.summary.resolvedMarkets}`);
      console.log(`session: ${s.session.running ? "running" : "idle"}${s.session.error ? " (error: "+s.session.error+")" : ""}`);
      console.log(`vault: ${s.vault?.entries?.length||0} entries  rulings: ${s.trainingExamples||0}`);
      if (s.agents?.length) { console.log(`agents:`); s.agents.forEach((a: Record<string,unknown>) => console.log(`  ${a.agentId}  bal=${(a.balance as number)?.toFixed(0)}  rep=${(a.reputation as number)?.toFixed(2)}`)); }
      break;
    }
    case "session": {
      const topic = args.join(" ") || "Evaluate this claim with evidence and trading";
      const r = await api("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, traders: 2, maxIterations: 6 }) });
      console.log(r.started ? `Started. Agents: ${r.traders?.join(", ")}` : `Error: ${r.error}`);
      break;
    }
    case "ideas": {
      const s = await api("/api/state");
      (s.ideas||[]).forEach((i: Record<string,unknown>) => {
        console.log(`${i.status === "proposed" ? "⏳" : i.status === "accepted" ? "✓" : "✗"} ${i.title}`);
        ((i.claims as Array<Record<string,unknown>>)||[]).forEach(c => console.log(`    ${(c.yesPrice as number).toFixed(2)} ${c.text}`));
      });
      break;
    }
    case "approve": {
      const r = await api("/api/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ideaId: args[0] }) });
      console.log(r.ok ? `Approved: ${r.ideaId}` : `Error: ${r.error}`);
      break;
    }
    case "dismiss": {
      const r = await api("/api/dismiss", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ideaId: args[0] }) });
      console.log(r.ok ? `Dismissed: ${r.ideaId}` : `Error: ${r.error}`);
      break;
    }
    case "adjudicate": {
      const r = await api("/api/adjudicate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claimId: args[0], ruling: args[1] }) });
      console.log(r.ok ? `Ruled ${args[1]}` : `Error: ${r.error}`);
      break;
    }
    case "queue": {
      const q = await api("/api/queue");
      (q.cards||[]).forEach((c: Record<string,unknown>, i: number) => console.log(`${i+1}. ${c.claimText}\n   price=${(c.yesPrice as number)?.toFixed(2)} orders=${c.orders} reason=${c.reason}\n   mp adjudicate ${c.claimId} <t|f>`));
      break;
    }
    case "riff": {
      const text = args.join(" ");
      if (!text) { console.log("Usage: mp riff \"your editorial feedback\""); break; }
      const r = await api("/api/riff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      console.log(`${r.interpretations?.length||0} interpretations:`);
      (r.interpretations||[]).forEach((i: Record<string,unknown>) => console.log(`  [${i.kind}] ${i.confidence ? "c="+(i.confidence as number).toFixed(2)+" " : ""}${(i.reason||i.text||"").slice(0,100)}`));
      break;
    }
    case "refine": {
      const r = await api("/api/refine", { method: "POST" });
      console.log(`sources: ${r.sourcesScanned}  tier1: ${r.tier1Count}  escalated: ${r.escalatedCount}  tier2: ${r.tier2Launched}`);
      break;
    }
    case "vault": {
      if (args[0] === "accept") {
        const title = args[1] || "";
        const body = args.slice(2).join(" ") || "";
        if (!title) { console.log("Usage: mp vault accept <title> <body>"); break; }
        const r = await api("/api/vault", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: title.toLowerCase().replace(/[^a-z0-9]+/g,"-"), title, body, author: "cli", value: 0.7, lineage: [], claims: [] }) });
        console.log(r.ok ? `Accepted. Bounty: ${(r.bountyPaid as number)?.toFixed(0)} tokens` : `Error: ${r.error}`);
      } else {
        const v = await api("/api/vault");
        (v.entries||[]).forEach((e: Record<string,unknown>) => console.log(`  ${e.title} (value: ${(e.value as number)?.toFixed(2)})`));
      }
      break;
    }
    case "sessions": {
      const s = await api("/api/sessions");
      (s.sessions||[]).forEach((x: Record<string,unknown>) => console.log(`  #${x.id} ${x.topic?.slice(0,60)} | ${x.agents} agents · ${x.iterations} iters | ${x.endedAt ? "done" : "running"}`));
      break;
    }
    case "metrics": {
      const m = await api("/api/metrics");
      console.log(`rulings: ${m.adjudicated}  informativeness: ${m.informativeness?.toFixed(2)??"?"}  disagreement: ${m.verdictVariance?.toFixed(3)??"?"}`);
      (m.calibration||[]).filter((b: Record<string,unknown>) => b.n > 0).forEach((b: Record<string,unknown>) => console.log(`  ${b.bucket}: n=${b.n} true=${((b.fracTrue as number)*100).toFixed(0)}%`));
      break;
    }
    case "export": {
      const res = await fetch(`${API}/api/export`);
      process.stdout.write(await res.text());
      break;
    }
    case "self-improve": {
      const s = await api("/api/self-improve", { method: "POST" });
      console.log(`Errors: ${s.totalErrors}`);
      (s.claims||[]).forEach((c: Record<string,unknown>) => console.log(`  [${((c.confidence as number)*100).toFixed(0)}%] ${c.text} (${c.errorCount} errs)`));
      break;
    }
    default:
      console.log(`Unknown command: ${cmd}\n${help}`);
  }
}

main().catch(console.error);
