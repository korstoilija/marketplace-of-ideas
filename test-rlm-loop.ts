import { runRlm, type RlmRun } from "./src/rlm/loop.js";

const API_KEY = process.env["DEEPSEEK_API_KEY"] ?? "";
if (!API_KEY) {
  console.error("DEEPSEEK_API_KEY not set. Exiting.");
  process.exit(0);
}

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  RLM LOOP — LLM writes JavaScript → VM executes");
  console.log("  No HTTP bridge. Tools injected directly.");
  console.log("═══════════════════════════════════════════════════\n");

  console.log("The LLM (DeepSeek) will:");
  console.log("  1. Check state → propose ideas with claims + evidence");
  console.log("  2. evaluate() each claim (real DeepSeek API calls)");
  console.log("  3. placeOrder() based on confidence → price discovery");
  console.log("  4. settleAbove() auto-resolve confident markets");
  console.log("  5. findDivergence() hunt Fisher gradient claims");
  console.log("  6. distill() → set Final\n");

  const result: RlmRun = await runRlm({
    apiKey: API_KEY,
    maxIterations: 10,
    verbose: true,
  });

  console.log("\n═══════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════\n");

  console.log(`Iterations: ${result.iterations.length}`);
  console.log(`Success: ${result.success}`);
  if (result.error) console.log(`Error: ${result.error}`);
  if (result.finalValue) {
    console.log(`Final: ${JSON.stringify(result.finalValue, null, 2).slice(0, 500)}`);
  }

  for (const it of result.iterations) {
    const lines = it.code.split("\n").length;
    console.log(`  [${it.iteration}] ${lines} lines → ${it.result.stdout.length} chars${it.result.hasFinal ? " ← FINAL" : ""}${it.result.timedOut ? " (TIMEOUT)" : ""}`);
  }

  console.log();
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
