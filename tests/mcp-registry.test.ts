import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { buildRegistry } from "../src/mcp/registry.js";

describe("mcp registry", () => {
  let store: Store;
  let reg: ReturnType<typeof buildRegistry>;
  beforeEach(() => {
    store = new Store(":memory:");
    reg = buildRegistry(store);
  });

  it("propose_idea creates idea + markets under the caller's agent id", () => {
    const r = reg.proposeIdea({ agentId: "ext-1", title: "External Idea", summary: "s", body: "", claims: ["c1"] });
    expect(r.claimIds).toHaveLength(1);
    expect(store.getIdea(r.ideaId)!.author).toBe("ext-1");
    expect(store.getAgent("ext-1")).toBeTruthy(); // wallet auto-created
  });

  it("place_order trades with the external wallet", () => {
    const { claimIds } = reg.proposeIdea({ agentId: "ext-1", title: "T", summary: "s", body: "", claims: ["c"] });
    const r = reg.placeOrder({ agentId: "ext-1", claimId: claimIds[0], side: "yes", shares: 10 });
    expect(r.cost).toBeGreaterThan(0);
    expect(store.getAgent("ext-1")!.balance).toBeLessThan(1000);
  });

  it("get_state and list_nominations read the world", () => {
    const { claimIds } = reg.proposeIdea({ agentId: "x", title: "T", summary: "s", body: "", claims: ["c"] });
    store.placeOrder({ claimId: claimIds[0], agentId: "x", side: "yes", shares: 250 });
    store.nominate(claimIds[0], "threshold");
    expect(reg.getState().ideas).toBe(1);
    expect(reg.listNominations()).toHaveLength(1);
  });

  it("registry exposes NO settlement capability", () => {
    const keys = Object.keys(reg);
    expect(keys.join(" ")).not.toMatch(/settle|adjudicat|resolve/i);
  });
});
