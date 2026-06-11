#!/usr/bin/env node
import { createInterface } from "node:readline";
import WebSocket from "ws";

const API = `http://127.0.0.1:${process.env["MP_PORT"] ?? 4280}`;

let state: Record<string, unknown> = {};
let mode: "dashboard" | "session" | "adjudicate" | "help" = "dashboard";
let selectedIdx = 0;

function api(path: string, opts?: RequestInit) {
  return fetch(`${API}${path}`, opts).then(r => r.json()).catch(() => ({}));
}

function clear() { process.stdout.write("\x1b[2J\x1b[H"); }

function bold(s: string) { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string) { return `\x1b[2m${s}\x1b[0m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[0m`; }
function amber(s: string) { return `\x1b[33m${s}\x1b[0m`; }
function cyan(s: string) { return `\x1b[36m${s}\x1b[0m`; }

function renderDashboard() {
  if (!state.summary) return;
  const s = state as Record<string, unknown>;
  const sum = s.summary as Record<string, number>;
  const agents = (s.agents as Array<Record<string,unknown>>) || [];
  const ideas = (s.ideas as Array<Record<string,unknown>>) || [];
  const pending = (s.pendingIdeas as Array<Record<string,unknown>>) || [];
  const queue = (s.queue as Array<Record<string,unknown>>) || [];
  const orders = (s.recentOrders as Array<Record<string,unknown>>) || [];
  const logs = (s.allLogs as Array<Record<string,unknown>>) || [];
  const sess = s.session as Record<string,unknown> || {};
  const opts = s.optimize as Record<string,unknown> || {};
  const metrics = s.metrics as Record<string,unknown> || {};
  const criteria = (s.judgeCriteria as Array<Record<string,unknown>>) || [];

  console.log(bold("═══ MARKETPLACE OF IDEAS ═══") + "  " + dim("q=quit h=help s=session a=adjudicate r=refresh"));
  console.log("");
  console.log(`${bold("State:")} ideas=${sum.ideas} claims=${sum.claims} open=${sum.openMarkets} resolved=${sum.resolvedMarkets} agents=${agents.length}`);
  console.log(`${bold("Session:")} ${sess.running ? amber("RUNNING") : green("idle")}${sess.error ? red(" error: "+sess.error) : ""}`);
  console.log(`${bold("GEPA:")} ${opts.running ? amber("optimizing") : green("idle")} examples=${s.trainingExamples??0}/${s.minExamples??30}`);
  console.log("");

  // Agents
  if (agents.length > 0) {
    console.log(bold("Agents:"));
    for (const a of agents) {
      const status = (a["correct"] as number) > 0 ? green : dim;
      console.log(`  ${a["agentId"]}  bal=${(a["balance"] as number)?.toFixed(0)}  rep=${(a["reputation"] as number)?.toFixed(2)}`);
    }
    console.log("");
  }

  // Pending ideas (ghost lifecycle)
  if (pending.length > 0) {
    console.log(bold(`Pending (${pending.length} need approval):`));
    for (let i = 0; i < Math.min(pending.length, 5); i++) {
      console.log(`  ${i+1}. ${(pending[i]["title"] as string)?.slice(0,60)}`);
    }
    console.log(`  → use "a" to adjudicate/approve pending ideas`);
    console.log("");
  }

  // Active ideas
  const active = ideas.filter(i => (i["status"] as string) !== "rejected").slice(0, 5);
  if (active.length > 0) {
    console.log(bold("Active Ideas:"));
    for (const idea of active) {
      const claims = (idea["claims"] as Array<Record<string,unknown>>) || [];
      const status = idea["status"] === "proposed" ? amber("⏳") : idea["status"] === "accepted" ? green("✓") : dim("·");
      console.log(`  ${status} ${(idea["title"] as string)?.slice(0,50)}`);
      for (const c of claims.slice(0, 2)) {
        const price = (c["yesPrice"] as number) || 0.5;
        const bar = "█".repeat(Math.round(price * 10)) + "░".repeat(10 - Math.round(price * 10));
        console.log(`      ${(c["text"] as string)?.slice(0,40)}  [${bar}] ${price.toFixed(2)}`);
      }
    }
    console.log("");
  }

  // Queue
  if (queue.length > 0) {
    console.log(bold(`Adjudication Queue (${queue.length}):`));
    for (let i = 0; i < Math.min(queue.length, 3); i++) {
      const q = queue[i];
      console.log(`  ${i+1}. ${(q["claimText"] as string)?.slice(0,60)}  price=${(q["yesPrice"] as number)?.toFixed(2)}  orders=${q["orders"]}`);
    }
    console.log("");
  }

  // Judge criteria
  if (criteria.length > 0) {
    console.log(bold("Judge Criteria:"));
    for (const c of criteria) {
      console.log(`  · ${c["criterion"]} (weight: ${c["weight"]})`);
    }
    console.log("");
  }

  // Metrics
  if (metrics["adjudicated"] as number > 0) {
    console.log(bold("Market Quality:"));
    console.log(`  rulings=${metrics["adjudicated"]}  informativeness=${(metrics["informativeness"] as number)?.toFixed(2)}  disagreement=${(metrics["verdictVariance"] as number)?.toFixed(3)}`);
    console.log("");
  }

  // Recent orders
  if (orders.length > 0) {
    console.log(bold(`Recent Orders (${Math.min(orders.length, 5)}):`));
    for (const o of orders.slice(0, 5)) {
      console.log(`  ${o["agentId"]} ${o["side"]} ${(o["shares"] as number)?.toFixed(0)} @ ${(o["cost"] as number)?.toFixed(1)}`);
    }
    console.log("");
  }

  // Agent log (last 3)
  if (logs.length > 0) {
    console.log(bold("Agent Log (last 3):"));
    for (const l of logs.slice(-3)) {
      const marker = l["hasError"] ? red("✗") : l["hasFinal"] ? green("✓") : amber("·");
      console.log(`  ${marker} ${l["agentId"]} #${l["iteration"]}: ${(l["stdout"] as string)?.slice(0,80)}`);
    }
    console.log("");
  }

  // Help
  console.log(dim("─── Keys: [q]uit [s]ession [a]djudicate [r]efresh [j]udge criteria ───"));
}

async function startSession() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const topic = await new Promise<string>(resolve => rl.question("Topic: ", resolve));
  rl.close();
  if (!topic) return;
  const res = await api("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, traders: 2, maxIterations: 6 }),
  });
  console.log(res.started ? `Started: ${res.traders?.join(", ")}` : `Error: ${res.error}`);
}

async function adjudicateLoop() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const queue = (state.queue as Array<Record<string,unknown>>) || [];
  if (queue.length === 0) { console.log("No claims in adjudication queue."); rl.close(); return; }
  for (let i = 0; i < Math.min(queue.length, 10); i++) {
    const q = queue[i];
    console.log(`\n${bold(`[${i+1}/${queue.length}]`)} ${q["claimText"]}`);
    console.log(`  price=${(q["yesPrice"] as number)?.toFixed(2)} orders=${q["orders"]} reason=${q["reason"]}`);
    const ruling = await new Promise<string>(resolve => rl.question("  Rule [t]rue [f]alse [s]kip [q]uit: ", resolve));
    if (ruling === "q") break;
    const r = ruling === "t" ? "true" : ruling === "f" ? "false" : "skip";
    if (r !== "skip") {
      await api("/api/adjudicate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claimId: q["claimId"], ruling: r }),
      });
      console.log(green(`  → Ruled ${r}`));
    }
  }
  rl.close();
}

async function setJudgeCriteria() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Enter criteria (one per line, empty to finish). Format: criterion:weight");
  const criteria: Array<{ criterion: string; weight: number }> = [];
  while (true) {
    const line = await new Promise<string>(resolve => rl.question("> ", resolve));
    if (!line) break;
    const [criterion, weightStr] = line.split(":");
    criteria.push({ criterion: criterion.trim(), weight: Number(weightStr) || 1 });
  }
  rl.close();
  await api("/api/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ criteria }),
  });
  console.log(green(`Set ${criteria.length} criteria.`));
}

async function main() {
  // Connect WebSocket for live updates
  const ws = new WebSocket(`ws://127.0.0.1:${process.env["MP_PORT"] ?? 4280}/ws`);
  ws.on("message", (data: Buffer) => {
    try { state = JSON.parse(data.toString()); }
    catch { /* partial */ }
    if (mode === "dashboard") { clear(); renderDashboard(); }
  });
  ws.on("close", () => {
    console.log(red("\nConnection lost. Restart the server."));
    process.exit(1);
  });

  // Initial state
  try { state = await api("/api/state"); } catch { /* server not up */ }
  clear();
  renderDashboard();

  // Keyboard input
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", async (key: Buffer) => {
    const k = key.toString();
    if (k === "q" || k === "\x03") { console.log("\n"); process.exit(0); }
    if (k === "r") { try { state = await api("/api/state"); } catch {} clear(); renderDashboard(); }
    if (k === "s") { await startSession(); await new Promise(r => setTimeout(r, 500)); clear(); renderDashboard(); }
    if (k === "a") { await adjudicateLoop(); await new Promise(r => setTimeout(r, 500)); clear(); renderDashboard(); }
    if (k === "j") { await setJudgeCriteria(); await new Promise(r => setTimeout(r, 500)); clear(); renderDashboard(); }
    if (k === "h") {
      console.log(bold("\n═══ HELP ═══"));
      console.log("  s = start session    a = adjudicate queue    j = set judge criteria");
      console.log("  r = refresh          q = quit                h = help");
      console.log("  WebSocket pushes live updates automatically.\n");
    }
  });
}

main().catch(console.error);
