import { describe, it, expect } from "vitest";
import { extractCode, buildProviders, SANDBOX_API_DOC } from "../src/engine/codegen.js";

describe("extractCode", () => {
  it("strips js fences", () => {
    expect(extractCode("```js\nprint(1)\n```")).toBe("print(1)");
    expect(extractCode("```javascript\nprint(1)\n```")).toBe("print(1)");
  });
  it("strips bare fences and passes plain code through", () => {
    expect(extractCode("```\nprint(1)\n```")).toBe("print(1)");
    expect(extractCode("print(1)")).toBe("print(1)");
  });
  it("takes the first fenced block when prose surrounds it", () => {
    expect(extractCode("Here you go:\n```js\nprint(1)\n```\nHope that helps!")).toBe("print(1)");
  });
});

describe("buildProviders", () => {
  it("returns only providers whose env keys are set", () => {
    const providers = buildProviders({ DEEPSEEK_API_KEY: "x" });
    expect(providers.map(p => p.name)).toEqual(["deepseek"]);
  });
  it("returns empty for no keys", () => {
    expect(buildProviders({})).toEqual([]);
  });
});

describe("SANDBOX_API_DOC", () => {
  it("documents every sandbox global", () => {
    for (const name of ["ideas.propose", "market.buyYes", "market.buyNo", "market.price", "evidence.submit", "state()", "subAgent(", "llm(", "print(", "Final ="]) {
      expect(SANDBOX_API_DOC).toContain(name);
    }
  });
});
