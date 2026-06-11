import { createInterface } from "node:readline";

const API = `http://127.0.0.1:${process.env["MP_PORT"] ?? 4280}`;

async function api(path: string, opts?: RequestInit) {
  try {
    const r = await fetch(`${API}${path}`, opts);
    return await r.json();
  } catch {
    console.log("Server not running. Start with: npm start");
    return null;
  }
}

function show(state: Record<string, unknown>) {
  if (!state?.summary) return;
  const s = state.summary as Record<string, number>;
  const session = state.session as { running?: boolean } | undefined;
  console.log(`\n${session?.running ? "⚡ RUNNING" : "⏸ idle"} | ideas:${s.ideas} claims:${s.claims} open:${s.openMarkets} resolved:${s.resolvedMarkets} | rulings:${state.trainingExamples ?? 0}/${state.minExamples ?? 30}`);
  
  const pending = (state.pendingIdeas as Array<{ id: string; title: string }>) ?? [];
  if (pending.length) {
    console.log(`\nPENDING (approve/dismiss):`);
    pending.slice(0, 5).forEach(p => console.log(`  ${p.id}  ${p.title.slice(0, 60)}`));
  }

  const queue = (state.queue as Array<Record<string, unknown>>) ?? [];
  if (queue.length) {
    console.log(`\nQUEUE (adjudicate):`);
    queue.slice(0, 5).forEach(q => console.log(`  ${q.claimId}  price:${(q.yesPrice as number)?.toFixed(2)}  ${(q.claimText as string)?.slice(0, 50)}`));
  }

  const ideas = (state.ideas as Array<Record<string, unknown>>) ?? [];
  if (ideas.length) {
    console.log(`\nIDEAS:`);
    ideas.filter(i => (i.status as string) !== "rejected").slice(0, 8).forEach(i => {
      console.log(`  ${i.status === "proposed" ? "⏳" : "✓"} ${(i.title as string)?.slice(0, 60)}`);
      ((i.claims as Array<Record<string, unknown>>) ?? []).forEach(c => console.log(`    ${(c.yesPrice as number)?.toFixed(2)} ${(c.text as string)?.slice(0, 50)}`));
    });
  }

  const orders = (state.recentOrders as Array<Record<string, unknown>>) ?? [];
  if (orders.length) {
    console.log(`\nRECENT TRADES:`);
    orders.slice(0, 3).forEach(o => console.log(`  ${o.agentId} ${o.side} ${(o.shares as number)?.toFixed(0)} @ ${(o.cost as number)?.toFixed(1)}`));
  }
  console.log();
}

const HELP = `
  s <topic>        start session     a <claim-id> t|f   adjudicate
  approve <id>     approve idea      dismiss <id>       dismiss idea
  show             refresh state     q                  quit
  metrics          market quality    criteria <...>     set judge criteria
`;

async function main() {
  console.log("Marketplace REPL. Type 'help' or 's <topic>' to begin.\n");
  
  const state = await api("/api/state");
  if (state) show(state);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();

  rl.on("line", async (line: string) => {
    const args = line.trim().split(/\s+/);
    const cmd = args[0];
    
    try {
      if (cmd === "q" || cmd === "quit" || cmd === "exit") { rl.close(); return; }
      if (cmd === "help") { console.log(HELP); rl.prompt(); return; }
      if (cmd === "show" || cmd === "") {
        const s = await api("/api/state");
        if (s) show(s);
      }
      else if (cmd === "s") {
        const topic = args.slice(1).join(" ") || "evaluate this topic";
        const r = await api("/api/session", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, traders: 2, maxIterations: 8 }),
        });
        console.log(r?.started ? `Started: ${r.traders?.join(", ")}` : `Error: ${r?.error}`);
      }
      else if (cmd === "a") {
        const r = await api("/api/adjudicate", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claimId: args[1], ruling: args[2] }),
        });
        console.log(r?.ok ? `Ruled ${args[2]}` : `Error: ${r?.error}`);
      }
      else if (cmd === "approve") {
        const r = await api("/api/approve", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaId: args[1] }),
        });
        console.log(r?.ok ? `Approved: ${args[1]}` : `Error: ${r?.error}`);
      }
      else if (cmd === "dismiss") {
        const r = await api("/api/dismiss", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ideaId: args[1] }),
        });
        console.log(r?.ok ? `Dismissed: ${args[1]}` : `Error: ${r?.error}`);
      }
      else if (cmd === "enrich" && args[1]) {
        const r = await api("/api/enrich", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: args[1] }),
        });
        console.log(r?.started ? `Enriching ${args[1]}...` : `Error: ${r?.error}`);
      }
      else if (cmd === "metrics") {
        const m = await api("/api/metrics");
        if (m) console.log(`rulings:${m.adjudicated}  informativeness:${m.informativeness?.toFixed(2) ?? "?"}  spread:${m.reputationSpread?.toFixed(2)}`);
      }
      else if (cmd === "criteria") {
        const criteria = args.slice(1).map(c => ({ criterion: c, weight: 1 }));
        await api("/api/judge", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ criteria }),
        });
        console.log(`Set ${criteria.length} criteria.`);
      }
      else {
        console.log(`Unknown: ${cmd}. Try: s <topic>, show, approve <id>, a <claim-id> t|f`);
      }
    } catch (e) {
      console.log(`Error: ${e instanceof Error ? e.message : e}`);
    }
    rl.prompt();
  });

  rl.on("close", () => { console.log("\n"); process.exit(0); });
}

main().catch(console.error);
