import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "../store/store.js";
import { buildRegistry } from "./registry.js";

const DB = process.env["MP_DB"] ?? "data/marketplace.sqlite";
const store = new Store(DB);
const reg = buildRegistry(store);

const server = new McpServer({ name: "idea-registry", version: "0.2.0" });

const wrap = (fn: () => unknown) => {
  try { return { content: [{ type: "text" as const, text: JSON.stringify(fn()) }] }; }
  catch (err) { return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) }], isError: true }; }
};

server.tool("get_state", "Marketplace counters and agent wallets", {}, async () => wrap(() => reg.getState()));
server.tool("list_ideas", "All ideas with claim ids", {}, async () => wrap(() => reg.listIdeas()));
server.tool("get_idea", "One idea with claims and prices", { id: z.string() }, async (a) => wrap(() => reg.getIdea(a.id)));
server.tool("get_market", "Market state and price history for a claim", { claimId: z.string() }, async (a) => wrap(() => reg.getMarket(a.claimId)));
server.tool("list_nominations", "Claims awaiting HUMAN adjudication (you cannot settle them)", {}, async () => wrap(() => reg.listNominations()));
server.tool(
  "propose_idea",
  "Propose an idea; each claim gets an LMSR market",
  { agentId: z.string(), title: z.string(), summary: z.string(), body: z.string().default(""), claims: z.array(z.string()).min(1), parentId: z.string().optional() },
  async (a) => wrap(() => reg.proposeIdea(a)),
);
server.tool(
  "submit_evidence",
  "Attach supporting or counter evidence to a claim",
  { agentId: z.string(), claimId: z.string(), excerpt: z.string(), stance: z.enum(["supporting", "counter"]), relevance: z.number().min(0).max(1).optional() },
  async (a) => wrap(() => reg.submitEvidence(a)),
);
server.tool(
  "place_order",
  "Buy yes/no shares with your wallet; cost is the LMSR price",
  { agentId: z.string(), claimId: z.string(), side: z.enum(["yes", "no"]), shares: z.number().positive() },
  async (a) => wrap(() => reg.placeOrder(a)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`idea-registry MCP server on stdio (db: ${DB})`);
