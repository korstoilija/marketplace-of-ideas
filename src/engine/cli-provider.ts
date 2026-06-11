import { execFile } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CodeGenerator, CodeGenInputs } from "./agent.js";
import { SANDBOX_API_DOC, extractCode } from "./codegen.js";

const CLI_TIMEOUT_MS = 60_000;

function execFilePromise(file: string, args: string[], timeoutMs = CLI_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: string) => { stdout += d; });
    child.stderr?.on("data", (d: string) => { stderr += d; });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `exit ${code}`));
    });
    child.on("error", reject);
  });
}

function buildPrompt(inputs: CodeGenInputs): string {
  return `${inputs.task}\n\n${SANDBOX_API_DOC}\n\nPersona: ${inputs.persona}\nState: ${inputs.stateMetadata}\nHistory: ${inputs.historyText || "(first iteration)"}\n\nWrite ONLY runnable JavaScript.`;
}

export function makeCliCodeGenerator(kind: "claude" | "codex", opts?: { binary?: string; timeoutMs?: number }): CodeGenerator {
  const binary = opts?.binary ?? kind;
  const timeoutMs = opts?.timeoutMs ?? CLI_TIMEOUT_MS;

  if (kind === "claude") {
    return async (inputs) => {
      try {
        const prompt = buildPrompt(inputs);
        const output = await execFilePromise(binary, ["-p", prompt, "--max-turns", "1"], timeoutMs);
        return extractCode(output);
      } catch (err) {
        return `print("cli-provider error (claude): ${String(err instanceof Error ? err.message : err)}");`;
      }
    };
  }

  if (kind === "codex") {
    return async (inputs) => {
      const tmpFile = join(tmpdir(), `codex-out-${randomUUID()}.txt`);
      try {
        const prompt = buildPrompt(inputs);
        await writeFile(tmpFile, "", "utf-8");
        await execFilePromise(binary, ["exec", "-o", tmpFile, "--", prompt], timeoutMs);
        const output = await readFile(tmpFile, "utf-8");
        try { await unlink(tmpFile); } catch { /* best effort */ }
        return extractCode(output);
      } catch (err) {
        try { await unlink(tmpFile); } catch { /* best effort */ }
        return `print("cli-provider error (codex): ${String(err instanceof Error ? err.message : err)}");`;
      }
    };
  }

  throw new Error(`unknown CLI kind: ${kind}`);
}

export function detectCli(binary: string, timeoutMs = 10_000): Promise<boolean> {
  return execFilePromise(binary, ["--version"], timeoutMs).then(() => true).catch(() => false);
}
