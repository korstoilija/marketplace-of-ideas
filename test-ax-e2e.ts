import { Store } from "./src/store/index.js";
import { RlmAgent, type AgentRun } from "./src/engine/rlm-agent.js";
import { runSession, type SessionConfig } from "./src/engine/harness.js";

const API_KEY = process.env["DEEPSEEK_API_KEY"] ?? "";
if (!API_KEY) {
  console.error("DEEPSEEK_API_KEY not set.");
  process.exit(0);
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  MARKETPLACE — Ax-powered RLM Loop");
  console.log("═══════════════════════════════════════════════════\n");

  const session: SessionConfig = {
    topic: "AI Alignment and Capabilities",
    agents: [
      {
        agentId: "deepseek-skeptic",
        provider: "deepseek",
        persona: "skeptical analyst who demands strong evidence before accepting claims",
      },
      {
        agentId: "deepseek-generalist",
        provider: "deepseek",
        persona: "balanced evaluator who weighs both sides carefully",
      },
    ],
    harness: {
      maxIterationsPerAgent: 8,
      nominationThreshold: 0.85,
    },
  };

  console.log(`Session: ${session.topic}`);
  console.log(`Agents: ${session.agents.length} (${session.agents.map(a => a.agentId).join(", ")})`);
  console.log();

  const result = await runSession(session);

  console.log("─── Agent Results ───");
  for (const run of result.agentRuns) {
    console.log(`  ${run.agentId}: ${run.iterations.length} iterations, success=${run.success}${run.error ? `, error=${run.error}` : ""}`);
    if (run.finalValue) {
      console.log(`    Final: ${JSON.stringify(run.finalValue).slice(0, 200)}`);
    }
  }

  console.log(`\n─── Adjudication Queue ───`);
  console.log(`  ${result.adjudicationQueue.length} claims nominated for human review`);

  for (const card of result.adjudicationQueue) {
    console.log(`  [${card.claimId.slice(0, 40)}] price=${card.yesPrice.toFixed(3)} reason=${card.nominationReason.slice(0, 60)}`);
  }

  if (result.adjudicationQueue.length > 0) {
    const card = result.adjudicationQueue[0];
    console.log(`\n  First card: "${card.claimText.slice(0, 80)}..."`);
    console.log(`    Supporting evidence: ${card.supportingEvidence.length} items`);
    console.log(`    Counter evidence: ${card.counterEvidence.length} items`);
    console.log(`    Verdicts: ${card.verdicts.length}`);
    console.log(`    Price: YES=${card.yesPrice.toFixed(3)} NO=${card.noPrice.toFixed(3)}`);
  }

  console.log();
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
