import type { Store } from "../store/store.js";
import type { Side } from "../market/lmsr.js";

/** MCP tool implementations: pure functions over the Store. NO settlement here, ever. */
export function buildRegistry(store: Store) {
  return {
    getState: () => ({ ...store.counters(), agents: store.listAgents() }),

    listIdeas: () => store.listIdeas(),

    getIdea: (id: string) => {
      const idea = store.getIdea(id);
      if (!idea) throw new Error(`unknown idea: ${id}`);
      return {
        ...idea,
        claims: idea.claimIds.map(cid => ({
          id: cid,
          text: store.getClaim(cid)?.text ?? "",
          yesPrice: store.getMarket(cid)?.yesPrice ?? 0.5,
          resolution: store.getMarket(cid)?.resolution ?? null,
        })),
      };
    },

    getMarket: (claimId: string) => {
      const m = store.getMarket(claimId);
      if (!m) throw new Error(`unknown market: ${claimId}`);
      return { ...m, history: store.priceHistory(claimId) };
    },

    proposeIdea: (p: { agentId: string; title: string; summary: string; body: string; claims: string[]; parentId?: string }) => {
      store.ensureAgent(p.agentId);
      return store.propose({ ...p, author: p.agentId });
    },

    submitEvidence: (p: { agentId: string; claimId: string; excerpt: string; stance: "supporting" | "counter"; relevance?: number }) => {
      store.ensureAgent(p.agentId);
      return { evidenceId: store.addEvidence({ ...p, submittedBy: p.agentId }) };
    },

    placeOrder: (p: { agentId: string; claimId: string; side: Side; shares: number }) => {
      store.ensureAgent(p.agentId);
      return store.placeOrder(p);
    },

    listNominations: () => store.pendingNominations(),
  };
}
