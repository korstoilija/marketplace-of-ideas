#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("claude v2.0.0");
  process.exit(0);
}

if (args.includes("-p")) {
  const idx = args.indexOf("-p");
  const prompt = args[idx + 1] || "";
  if (prompt.includes("THROW_CLAUD")) {
    process.stderr.write("connection refused");
    process.exit(1);
  }
  console.log("```javascript\nFinal = { ok: true };\nprint('claude says hi');\n```");
  process.exit(0);
}

process.exit(1);
