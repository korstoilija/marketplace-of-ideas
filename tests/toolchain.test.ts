import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { ai, ax } from "@ax-llm/ax";

describe("toolchain", () => {
  it("better-sqlite3 works in-memory", () => {
    const db = new Database(":memory:");
    db.prepare("CREATE TABLE t (x INTEGER)").run();
    db.prepare("INSERT INTO t (x) VALUES (?)").run(42);
    const row = db.prepare("SELECT x FROM t").get() as { x: number };
    expect(row.x).toBe(42);
    db.close();
  });

  it("ax exports are importable and constructible", () => {
    expect(typeof ai).toBe("function");
    const gen = ax("question:string -> answer:string");
    expect(gen).toBeTruthy();
    expect(typeof gen.forward).toBe("function");
  });

  it("ax signature syntax used by later tasks parses: descriptions, number outputs, multi-field", () => {
    const writeCode = ax(
      "task:string, persona:string, stateMetadata:string, historyText:string -> code:string \"runnable JavaScript for the sandbox\"",
    );
    const evaluate = ax(
      "claimText:string, supportingEvidence:string, counterEvidence:string -> confidence:number \"probability 0-1 that the claim is true\", reasoning:string",
    );
    expect(typeof writeCode.forward).toBe("function");
    expect(typeof evaluate.forward).toBe("function");
  });

  it("ai() accepts the deepseek provider name (no network call)", () => {
    const llm = ai({ name: "deepseek", apiKey: "test-key-never-used" });
    expect(llm).toBeTruthy();
  });
});
