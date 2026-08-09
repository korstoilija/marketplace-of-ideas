#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("codex v1.0.0");
  process.exit(0);
}

if (args.includes("exec")) {
  const oIdx = args.indexOf("-o");
  const outputFile = oIdx >= 0 ? args[oIdx + 1] : null;

  const promptIdx = args.indexOf("--");
  const prompt = promptIdx >= 0 ? args.slice(promptIdx + 1).join(" ") : "";
  if (prompt.includes("THROW_CODX")) {
    process.stderr.write("network error");
    process.exit(1);
  }

  const code = "Final = { answer: 42 };\nprint('codex responds');\n";
  if (outputFile) {
    require("fs").writeFileSync(outputFile, code);
  }
  console.log(code);
  process.exit(0);
}

process.exit(1);
