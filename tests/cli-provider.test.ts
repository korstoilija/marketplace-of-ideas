import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { makeCliCodeGenerator, detectCli } from "../src/engine/cli-provider.js";
import { extractCode } from "../src/engine/codegen.js";

const FAKE_CLAUDE = resolve(import.meta.dirname, "fixtures/fake-claude.cjs");
const FAKE_CODEX = resolve(import.meta.dirname, "fixtures/fake-codex.cjs");

const testInputs = {
  task: "test task",
  persona: "tester",
  stateMetadata: "state: empty",
  historyText: "",
};

describe("makeCliCodeGenerator", () => {
  it("claude shape: generates runnable code from fake binary", async () => {
    const gen = makeCliCodeGenerator("claude", { binary: FAKE_CLAUDE, timeoutMs: 5000 });
    const code = await gen(testInputs);
    expect(code).toContain("Final");
    expect(code).toContain("ok");
  });

  it("codex shape: generates code via -o output file", async () => {
    const gen = makeCliCodeGenerator("codex", { binary: FAKE_CODEX, timeoutMs: 5000 });
    const code = await gen(testInputs);
    expect(code).toContain("Final");
    expect(code).toContain("42");
  });

  it("claude failure survives with print error line", async () => {
    const gen = makeCliCodeGenerator("claude", { binary: FAKE_CLAUDE, timeoutMs: 5000 });
    const code = await gen({ ...testInputs, task: "THROW_CLAUD" });
    expect(code).toContain("cli-provider error (claude)");
  });

  it("codex failure survives with print error line", async () => {
    const gen = makeCliCodeGenerator("codex", { binary: FAKE_CODEX, timeoutMs: 5000 });
    const code = await gen({ ...testInputs, task: "THROW_CODX" });
    expect(code).toContain("cli-provider error (codex)");
  });

  it("extractCode strips markdown fences", () => {
    const raw = "```javascript\nFinal = 1;\n```";
    expect(extractCode(raw)).toBe("Final = 1;");
  });

  it("extractCode passes plain code through", () => {
    const raw = "Final = 1;";
    expect(extractCode(raw)).toBe("Final = 1;");
  });

  it("detectCli works with fake binary", async () => {
    const ok = await detectCli(FAKE_CLAUDE, 5000);
    expect(ok).toBe(true);
  });

  it("detectCli returns false for nonexistent binary", async () => {
    const ok = await detectCli("/nonexistent/binary_xyz", 2000);
    expect(ok).toBe(false);
  });
});
