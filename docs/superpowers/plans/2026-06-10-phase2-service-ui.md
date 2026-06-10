# Marketplace Service + Web UI (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work alone on a clean `main` — do not run concurrently with another agent in this working tree.

**Goal:** Turn the Phase 1 engine into a resident process: one `npm start` boots the store, an HTTP+WebSocket server, and a local web app where deliberation sessions are launched, market state streams live, and the human adjudicates claims — plus a recreated MCP server so external agents can participate.

**Architecture:** `src/server/service.ts` wraps the Phase 1 engine (`Store`, `runSession`, `buildProviders`) in a `node:http` server: static files from `public/`, a small JSON API, and a WebSocket that pushes state snapshots. The frontend is dependency-free vanilla JS served as static files (no build step — `tsconfig` only compiles `src/`). All dynamic frontend rendering uses safe DOM construction (`createElement` + `textContent`) — agent-authored strings (claims, evidence, reasoning) are untrusted and must never reach `innerHTML`. Settlement remains exclusively `store.applyAdjudication()`, reachable only through `POST /api/adjudicate` (the human's button) — never from agents or the MCP server. A new stdio MCP server reads/writes the same SQLite store.

**Tech Stack:** Phase 1 engine (TypeScript ESM, better-sqlite3, @ax-llm/ax), `ws` for WebSocket, vanilla HTML/JS/CSS frontend, `@modelcontextprotocol/sdk` (already a dependency) for the MCP server, vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-marketplace-of-ideas-ax-design.md` (Components 2, 3, 7; "resident marketplace" architecture)

**Verified Phase 1 API this plan builds on (do not re-derive — these exist and are tested):**
- `Store` (src/store/store.ts): `ensureAgent`, `getAgent`, `propose`, `getIdea`, `listIdeas`, `getClaim`, `addEvidence`, `listEvidence`, `recordVerdict`, `getMarket`, `placeOrder`, `getPositions`, `nominate`, `pendingNominations`, `skipNomination`, `applyAdjudication`, `listTrainingExamples`, `counters`, `close`, public `db`, public `currentIteration`.
- Engine: `runSession(cfg)` + `scanNominations` (src/engine/harness.ts), `RlmAgent` + types `CodeGenerator`/`LeafEvaluator` (src/engine/agent.ts), `buildProviders`/`makeCodeGenerator`/`makeLeafEvaluator`/`makeLlm`/`AxLLM` (src/engine/codegen.ts).

**File structure (end state):**

```
src/
  store/store.ts            (modified: read-model additions)
  server/cards.ts           (new: adjudication card builder)
  server/service.ts         (new: http + ws + JSON API)
  main.ts                   (new: resident entry point)
  mcp/registry.ts           (new: MCP tool functions over the Store)
  mcp/server.ts             (new: stdio MCP shell)
  index.ts                  (modified: export new modules)
public/
  index.html                (new)
  app.js                    (new)
tests/
  store-readmodel.test.ts   (new)
  cards.test.ts             (new)
  service.test.ts           (new)
  mcp-registry.test.ts      (new)
```

**Deleted this phase:** `src/evaluate/` (orphaned — nothing imports it; preserved in git history).

**Conventions for every task:** Run tests with `npx vitest run <file>`. Typecheck with `npm run typecheck`. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Setup — dependency, orphan removal, bd claim

**Files:**
- Modify: `package.json` (via npm)
- Delete: `src/evaluate/`

- [ ] **Step 1: Claim the bd issue**

```bash
bd update Marketplace-6jx --claim
```

- [ ] **Step 2: Install ws**

```bash
npm install ws
npm install -D @types/ws
```

- [ ] **Step 3: Delete the orphaned evaluator**

```bash
git rm -r src/evaluate
```

Verify nothing referenced it: `grep -rn "evaluate/sub-agent" src/ tests/` must print nothing.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npx vitest run`
Expected: clean, 45 tests pass (44 + live smoke if `DEEPSEEK_API_KEY` is set; 44 with it skipped is also fine).

```bash
git add -A
git commit -m "chore: add ws, remove orphaned evaluator (phase 2 start)"
```

---

### Task 2: Store read-model — listAgents, recentOrders, orderCount, priceHistory

The UI needs reads the engine never needed. `priceHistory` reconstructs the price path by folding orders through the LMSR price function — no schema change.

**Files:**
- Modify: `src/store/store.ts`
- Create: `tests/store-readmodel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/store-readmodel.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";

describe("store read-model", () => {
  let store: Store;
  let claimId: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    claimId = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" }).claimIds[0];
  });

  it("listAgents returns all agents with wallets", () => {
    const agents = store.listAgents();
    expect(agents.map(a => a.agentId).sort()).toEqual(["alice", "bob"]);
    expect(agents[0].balance).toBe(1000);
  });

  it("recentOrders returns newest first", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 5 });
    const orders = store.recentOrders(10);
    expect(orders).toHaveLength(2);
    expect(orders[0].agentId).toBe("bob"); // newest first
    expect(orders[0].side).toBe("no");
    expect(orders[0].cost).toBeGreaterThan(0);
  });

  it("orderCount counts per claim", () => {
    expect(store.orderCount(claimId)).toBe(0);
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    expect(store.orderCount(claimId)).toBe(1);
  });

  it("priceHistory folds orders into a price path starting at 0.5", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 50 });
    store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 20 });
    const h = store.priceHistory(claimId);
    expect(h).toHaveLength(3); // start + 2 orders
    expect(h[0].yesPrice).toBeCloseTo(0.5);
    expect(h[1].yesPrice).toBeGreaterThan(0.5);  // yes buy moved it up
    expect(h[2].yesPrice).toBeLessThan(h[1].yesPrice); // no buy moved it down
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store-readmodel.test.ts`
Expected: FAIL — `listAgents` does not exist.

- [ ] **Step 3: Add the methods to the Store class**

Add inside `class Store` in `src/store/store.ts`, immediately BEFORE the `close(): void { this.db.close(); }` line:

```typescript
  listAgents(): AgentRow[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY agent_id").all() as Array<
      { agent_id: string; balance: number; reputation: number; correct: number; total: number }>;
    return rows.map(r => ({ agentId: r.agent_id, balance: r.balance, reputation: r.reputation, correct: r.correct, total: r.total }));
  }

  recentOrders(limit = 20): Array<{ claimId: string; agentId: string; side: Side; shares: number; cost: number; createdAt: number }> {
    const rows = this.db.prepare(
      "SELECT claim_id, agent_id, side, shares, cost, created_at FROM orders ORDER BY id DESC LIMIT ?",
    ).all(limit) as Array<{ claim_id: string; agent_id: string; side: Side; shares: number; cost: number; created_at: number }>;
    return rows.map(r => ({ claimId: r.claim_id, agentId: r.agent_id, side: r.side, shares: r.shares, cost: r.cost, createdAt: r.created_at }));
  }

  orderCount(claimId: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM orders WHERE claim_id = ?").get(claimId) as { n: number }).n;
  }

  /** Price path: fold orders through LMSR. First point is the 0.5 starting price. */
  priceHistory(claimId: string): Array<{ at: number; yesPrice: number }> {
    const m = this.getMarket(claimId);
    if (!m) return [];
    const rows = this.db.prepare(
      "SELECT side, shares, created_at FROM orders WHERE claim_id = ? ORDER BY id",
    ).all(claimId) as Array<{ side: Side; shares: number; created_at: number }>;
    let qYes = 0, qNo = 0;
    const path = [{ at: 0, yesPrice: 0.5 }];
    for (const r of rows) {
      if (r.side === "yes") qYes += r.shares; else qNo += r.shares;
      path.push({ at: r.created_at, yesPrice: lmsrPrice(qYes, qNo, m.b).yes });
    }
    return path;
  }
```

(`lmsrPrice` is already imported at the top of store.ts.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store-readmodel.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts tests/store-readmodel.test.ts
git commit -m "feat: store read-model for UI (agents, orders, price history)"
```

---

### Task 3: Adjudication cards

The card is the unit of human judgment: claim, price, stance-split evidence, verdicts, nomination reason — compressed for a ~30-second ruling. Ordering: contested first (closest to 0.5 with volume), then confirmations.

**Files:**
- Create: `src/server/cards.ts`
- Create: `tests/cards.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/cards.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { buildAdjudicationCards } from "../src/server/cards.js";

describe("buildAdjudicationCards", () => {
  let store: Store;
  let contested: string, confirmed: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("a");
    const r = store.propose({ title: "T", summary: "s", body: "", claims: ["c1", "c2"], author: "a" });
    [contested, confirmed] = r.claimIds;

    // contested: price near 0.5, traded both ways
    store.placeOrder({ claimId: contested, agentId: "a", side: "yes", shares: 30 });
    store.placeOrder({ claimId: contested, agentId: "a", side: "no", shares: 28 });
    // confirmed: price pushed high
    store.placeOrder({ claimId: confirmed, agentId: "a", side: "yes", shares: 250 });

    store.addEvidence({ claimId: contested, excerpt: "pro", stance: "supporting", submittedBy: "a" });
    store.addEvidence({ claimId: contested, excerpt: "con", stance: "counter", submittedBy: "a" });
    store.recordVerdict({ claimId: contested, agentId: "a", confidence: 0.6, reasoning: "leans true" });

    store.nominate(contested, "stalled");
    store.nominate(confirmed, "threshold");
  });

  it("builds one card per pending nomination with stance-split evidence", () => {
    const cards = buildAdjudicationCards(store);
    expect(cards).toHaveLength(2);
    const c = cards.find(x => x.claimId === contested)!;
    expect(c.claimText).toBe("c1");
    expect(c.supporting).toEqual(["pro"]);
    expect(c.counter).toEqual(["con"]);
    expect(c.verdicts[0].confidence).toBe(0.6);
    expect(c.reason).toBe("stalled");
    expect(c.orders).toBe(2);
  });

  it("orders contested before confirmed", () => {
    const cards = buildAdjudicationCards(store);
    expect(cards[0].claimId).toBe(contested);
    expect(cards[1].claimId).toBe(confirmed);
  });

  it("ruled claims drop out of the queue", () => {
    store.applyAdjudication(confirmed, true);
    const cards = buildAdjudicationCards(store);
    expect(cards).toHaveLength(1);
    expect(cards[0].claimId).toBe(contested);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cards.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/server/cards.ts**

```typescript
import type { Store } from "../store/store.js";

export interface AdjudicationCard {
  claimId: string;
  claimText: string;
  ideaTitle: string;
  yesPrice: number;
  orders: number;
  supporting: string[];
  counter: string[];
  verdicts: Array<{ agentId: string; confidence: number; reasoning: string }>;
  reason: string;
}

export function buildAdjudicationCards(store: Store): AdjudicationCard[] {
  const cards: AdjudicationCard[] = [];
  for (const nom of store.pendingNominations()) {
    const claim = store.getClaim(nom.claimId);
    const market = store.getMarket(nom.claimId);
    if (!claim || !market || market.resolution) continue;
    const ev = store.listEvidence(nom.claimId);
    const verdicts = (store.db.prepare(
      "SELECT agent_id, confidence, reasoning FROM verdicts WHERE claim_id = ? ORDER BY id DESC LIMIT 5",
    ).all(nom.claimId) as Array<{ agent_id: string; confidence: number; reasoning: string }>)
      .map(v => ({ agentId: v.agent_id, confidence: v.confidence, reasoning: v.reasoning.slice(0, 300) }));

    cards.push({
      claimId: nom.claimId,
      claimText: claim.text,
      ideaTitle: store.getIdea(claim.ideaId)?.title ?? "",
      yesPrice: +market.yesPrice.toFixed(4),
      orders: store.orderCount(nom.claimId),
      supporting: ev.filter(e => e.stance === "supporting").map(e => e.excerpt),
      counter: ev.filter(e => e.stance === "counter").map(e => e.excerpt),
      verdicts,
      reason: nom.reason,
    });
  }
  // Contested first: distance from 0.5 ascending; ties broken by volume descending.
  cards.sort((a, b) =>
    Math.abs(a.yesPrice - 0.5) - Math.abs(b.yesPrice - 0.5) || b.orders - a.orders,
  );
  return cards;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cards.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/cards.ts tests/cards.test.ts
git commit -m "feat: adjudication cards, contested-first ordering"
```

---

### Task 4: Service core — http server, static files, state + queue API

**Files:**
- Create: `src/server/service.ts`
- Create: `tests/service.test.ts`
- Create: `public/index.html` (placeholder — real UI in Task 8)

- [ ] **Step 1: Create a placeholder public/index.html**

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Marketplace of Ideas</title></head>
<body><h1>Marketplace of Ideas</h1><p>UI lands in Task 8.</p></body></html>
```

- [ ] **Step 2: Write the failing tests**

Create `tests/service.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../src/store/store.js";
import { startService, type Service } from "../src/server/service.js";

let store: Store;
let svc: Service;

beforeEach(async () => {
  store = new Store(":memory:");
  svc = await startService({ store, port: 0 });
});
afterEach(async () => {
  await svc.close();
  store.close();
});

const url = (p: string) => `http://127.0.0.1:${svc.port}${p}`;

describe("service core", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Marketplace of Ideas");
  });

  it("rejects path traversal", async () => {
    const res = await fetch(url("/..%2f..%2fpackage.json"));
    expect(res.status).toBe(404);
  });

  it("GET /api/state returns summary, agents, ideas with prices", async () => {
    store.ensureAgent("alice");
    const { claimIds } = store.propose({ title: "Idea A", summary: "s", body: "", claims: ["c"], author: "alice" });
    store.placeOrder({ claimId: claimIds[0], agentId: "alice", side: "yes", shares: 10 });

    const res = await fetch(url("/api/state"));
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.summary.ideas).toBe(1);
    expect(s.agents[0].agentId).toBe("alice");
    expect(s.ideas[0].title).toBe("Idea A");
    expect(s.ideas[0].claims[0].yesPrice).toBeGreaterThan(0.5);
    expect(s.recentOrders).toHaveLength(1);
  });

  it("GET /api/queue returns adjudication cards", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 250 });
    store.nominate(claimIds[0], "threshold");
    const res = await fetch(url("/api/queue"));
    const q = await res.json();
    expect(q.cards).toHaveLength(1);
    expect(q.cards[0].claimId).toBe(claimIds[0]);
  });

  it("GET /api/history/:claimId returns the price path", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "a" });
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 10 });
    const res = await fetch(url(`/api/history/${claimIds[0]}`));
    const h = await res.json();
    expect(h.path).toHaveLength(2);
    expect(h.path[0].yesPrice).toBeCloseTo(0.5);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Create src/server/service.ts**

```typescript
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { Store } from "../store/store.js";
import { buildAdjudicationCards } from "./cards.js";
import { runSession, type SessionResult } from "../engine/harness.js";
import type { CodeGenerator, LeafEvaluator } from "../engine/agent.js";
import { buildProviders, makeCodeGenerator, makeLeafEvaluator, makeLlm } from "../engine/codegen.js";

const PUBLIC_DIR = join(import.meta.dirname, "..", "..", "public");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface TraderSetup { agentId: string; persona: string; codegen: CodeGenerator }
export interface TraderFactory {
  (count: number): { traders: TraderSetup[]; leafEvaluator: LeafEvaluator; llm: (p: string) => Promise<string> };
}

export interface ServiceConfig {
  store: Store;
  port: number;
  traderFactory?: TraderFactory;
  broadcastMs?: number;
}

export interface Service {
  port: number;
  server: Server;
  close(): Promise<void>;
}

const PERSONAS = [
  "ruthless skeptic; you demand evidence and bet against hype",
  "enthusiastic generalist; you hunt for upside others miss",
  "careful empiricist; you only trust verifiable specifics",
  "contrarian; you probe whatever the market already believes",
  "synthesizer; you connect claims across ideas",
];

function defaultTraderFactory(count: number): ReturnType<TraderFactory> {
  const providers = buildProviders();
  if (providers.length === 0) throw new Error("no provider API keys set");
  const traders: TraderSetup[] = Array.from({ length: count }, (_, i) => {
    const p = providers[i % providers.length];
    return {
      agentId: `${p.name}-${PERSONAS[i % PERSONAS.length].split(";")[0].replace(/\s+/g, "-")}`,
      persona: PERSONAS[i % PERSONAS.length],
      codegen: makeCodeGenerator(p.llm),
    };
  });
  return { traders, leafEvaluator: makeLeafEvaluator(providers[0].llm), llm: makeLlm(providers[0].llm) };
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

interface SessionState { running: boolean; error: string | null; last: SessionResult | null }

function snapshot(store: Store, session: SessionState) {
  return {
    summary: store.counters(),
    agents: store.listAgents(),
    ideas: store.listIdeas().map(i => ({
      id: i.id,
      title: i.title,
      claims: i.claimIds.map(cid => {
        const m = store.getMarket(cid);
        return {
          id: cid,
          text: store.getClaim(cid)?.text ?? "",
          yesPrice: m ? +m.yesPrice.toFixed(4) : 0.5,
          resolution: m?.resolution ?? null,
          orders: store.orderCount(cid),
        };
      }),
    })),
    queue: buildAdjudicationCards(store),
    recentOrders: store.recentOrders(15),
    session: { running: session.running, error: session.error },
  };
}

export async function startService(cfg: ServiceConfig): Promise<Service> {
  const { store } = cfg;
  const traderFactory = cfg.traderFactory ?? defaultTraderFactory;
  const session: SessionState = { running: false, error: null, last: null };

  const server = createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const method = req.method ?? "GET";

    try {
      if (u === "/api/state" && method === "GET") return json(res, snapshot(store, session));
      if (u === "/api/queue" && method === "GET") return json(res, { cards: buildAdjudicationCards(store) });

      const hist = u.match(/^\/api\/history\/(.+)$/);
      if (hist && method === "GET") return json(res, { path: store.priceHistory(hist[1]) });

      if (u === "/api/adjudicate" && method === "POST") {
        const body = await readBody(req);
        const claimId = String(body["claimId"] ?? "");
        const ruling = String(body["ruling"] ?? "");
        if (!store.getClaim(claimId)) return json(res, { error: `unknown claim: ${claimId}` }, 400);
        if (ruling === "skip") {
          store.skipNomination(claimId);
          return json(res, { ok: true, skipped: claimId });
        }
        if (ruling !== "true" && ruling !== "false") return json(res, { error: "ruling must be true|false|skip" }, 400);
        store.applyAdjudication(claimId, ruling === "true");
        broadcast();
        return json(res, { ok: true, claimId, outcome: ruling });
      }

      if (u === "/api/session" && method === "POST") {
        if (session.running) return json(res, { error: "a session is already running" }, 409);
        const body = await readBody(req);
        const topic = String(body["topic"] ?? "").trim();
        if (!topic) return json(res, { error: "topic required" }, 400);
        const count = Math.min(5, Math.max(1, Number(body["traders"] ?? 3)));
        const maxIterations = Math.min(20, Math.max(1, Number(body["maxIterations"] ?? 8)));

        let setup: ReturnType<TraderFactory>;
        try { setup = traderFactory(count); }
        catch (err) { return json(res, { error: String(err instanceof Error ? err.message : err) }, 400); }

        session.running = true;
        session.error = null;
        void runSession({
          store,
          topic,
          traders: setup.traders,
          leafEvaluator: setup.leafEvaluator,
          llm: setup.llm,
          maxIterations,
          maxDepth: 1,
          maxSubAgentCalls: 3,
          sandboxTimeoutMs: 30_000,
          stallIterations: 10,
        }).then(result => {
          session.last = result;
          session.error = result.failures.map(f => `${f.agentId}: ${f.error}`).join("; ") || null;
        }).catch(err => {
          session.error = String(err instanceof Error ? err.message : err);
        }).finally(() => {
          session.running = false;
          broadcast();
        });

        return json(res, { started: true, traders: setup.traders.map(t => t.agentId) });
      }

      if (u === "/api/session" && method === "GET") {
        return json(res, {
          running: session.running,
          error: session.error,
          lastRuns: session.last?.runs.map(r => ({ agentId: r.agentId, iterations: r.iterations.length, final: r.final })) ?? [],
        });
      }

      // Static files. Default "/" -> index.html. Reject anything that escapes PUBLIC_DIR.
      if (method === "GET") {
        const rel = u === "/" ? "index.html" : u.slice(1);
        const full = normalize(join(PUBLIC_DIR, rel));
        if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(404); return void res.end("not found"); }
        try {
          const data = await readFile(full);
          res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream" });
          return void res.end(data);
        } catch {
          res.writeHead(404); return void res.end("not found");
        }
      }

      res.writeHead(404); res.end("not found");
    } catch (err) {
      json(res, { error: String(err instanceof Error ? err.message : err) }, 500);
    }
  }

  // WebSocket: push snapshots while clients are connected and state changes.
  const wss = new WebSocketServer({ server, path: "/ws" });
  let lastSent = "";
  function broadcast(): void {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify(snapshot(store, session));
    if (payload === lastSent) return;
    lastSent = payload;
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(payload);
  }
  wss.on("connection", ws => {
    ws.send(JSON.stringify(snapshot(store, session)));
  });
  const ticker = setInterval(broadcast, cfg.broadcastMs ?? 1000);

  await new Promise<void>(resolve => server.listen(cfg.port, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;

  return {
    port,
    server,
    close: () => new Promise<void>((resolve) => {
      clearInterval(ticker);
      wss.close();
      for (const c of wss.clients) c.terminate();
      server.close(() => resolve());
    }),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/service.test.ts && npm run typecheck`
Expected: all PASS. If `import.meta.dirname` errors under vitest, replace it with `new URL("../../public", import.meta.url).pathname` — keep whichever compiles AND passes.

- [ ] **Step 6: Commit**

```bash
git add src/server/service.ts tests/service.test.ts public/index.html
git commit -m "feat: resident service with state/queue/history API and static hosting"
```

---

### Task 5: Adjudication + session endpoints — behavior tests

The endpoints exist (Task 4); this task proves the two flows that matter: a ruling ripples (payout, reputation, queue, training example), and a session launched over HTTP runs scripted traders end-to-end.

**Files:**
- Modify: `tests/service.test.ts` (append)

- [ ] **Step 1: Append the behavior tests**

Append to `tests/service.test.ts`:

```typescript
describe("adjudication flow over HTTP", () => {
  it("a ruling pays out, updates reputation, clears the queue, emits a training example", async () => {
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    const { claimIds } = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" });
    const cid = claimIds[0];
    store.addEvidence({ claimId: cid, excerpt: "pro", stance: "supporting", submittedBy: "alice" });
    store.placeOrder({ claimId: cid, agentId: "alice", side: "yes", shares: 40 });
    store.placeOrder({ claimId: cid, agentId: "bob", side: "no", shares: 30 });
    store.nominate(cid, "threshold");
    const aliceBefore = store.getAgent("alice")!.balance;

    const res = await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: cid, ruling: "true" }),
    });
    expect(res.status).toBe(200);

    expect(store.getAgent("alice")!.balance).toBeCloseTo(aliceBefore + 40);
    expect(store.getAgent("alice")!.reputation).toBe(1);
    expect(store.getAgent("bob")!.reputation).toBe(0);
    expect(store.pendingNominations()).toHaveLength(0);
    expect(store.listTrainingExamples()).toHaveLength(1);

    const dup = await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: cid, ruling: "false" }),
    });
    expect(dup.status).toBe(500); // already resolved -> store throws -> 500 with error body
  });

  it("skip clears the nomination without resolving", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "T2", summary: "s", body: "", claims: ["c"], author: "a" });
    store.nominate(claimIds[0], "stalled");
    const res = await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: claimIds[0], ruling: "skip" }),
    });
    expect(res.status).toBe(200);
    expect(store.pendingNominations()).toHaveLength(0);
    expect(store.getMarket(claimIds[0])!.resolution).toBeNull();
  });
});

describe("session over HTTP with scripted traders", () => {
  it("launches, runs to completion, and populates the store", async () => {
    await svc.close();
    const scripted = (title: string) => {
      let done = false;
      return async () => {
        if (done) return `Final = { ok: true };`;
        done = true;
        return `
          const { claimIds } = ideas.propose({ title: "${title}", summary: "s", body: "", claims: ["claim"] });
          market.buyYes(claimIds[0], 30);
          print("traded");
        `;
      };
    };
    svc = await startService({
      store, port: 0,
      traderFactory: (count) => ({
        traders: Array.from({ length: count }, (_, i) => ({
          agentId: `scripted-${i}`, persona: "test", codegen: scripted(`Scripted Idea ${i}`),
        })),
        leafEvaluator: async () => ({ confidence: 0.5, reasoning: "test" }),
        llm: async () => "ok",
      }),
    });

    const start = await fetch(url("/api/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "test topic", traders: 2, maxIterations: 4 }),
    });
    expect(start.status).toBe(200);
    expect((await start.json()).traders).toHaveLength(2);

    // poll until the session ends
    for (let i = 0; i < 100; i++) {
      const s = await (await fetch(url("/api/session"))).json();
      if (!s.running) break;
      await new Promise(r => setTimeout(r, 50));
    }
    const s = await (await fetch(url("/api/session"))).json();
    expect(s.running).toBe(false);
    expect(s.lastRuns).toHaveLength(2);
    expect(store.counters().ideas).toBe(2);

    const second = await fetch(url("/api/session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: "" }),
    });
    expect(second.status).toBe(400); // topic required
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/service.test.ts`
Expected: all PASS (the endpoints already exist; these tests pin their behavior). If the double-adjudication test gets a different status than 500, check that `route()` catches the store throw and returns 500 — fix the service, not the test.

- [ ] **Step 3: Commit**

```bash
git add tests/service.test.ts
git commit -m "test: adjudication ripple and scripted session over HTTP"
```

---

### Task 6: WebSocket snapshots

**Files:**
- Modify: `tests/service.test.ts` (append)

- [ ] **Step 1: Append the test**

Append to `tests/service.test.ts` (add `import WebSocket from "ws";` to the imports at the top of the file):

```typescript
describe("websocket", () => {
  it("sends a snapshot on connect and pushes after adjudication", async () => {
    store.ensureAgent("a");
    const { claimIds } = store.propose({ title: "WS", summary: "s", body: "", claims: ["c"], author: "a" });
    store.placeOrder({ claimId: claimIds[0], agentId: "a", side: "yes", shares: 250 });
    store.nominate(claimIds[0], "threshold");

    const ws = new WebSocket(`ws://127.0.0.1:${svc.port}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (d: Buffer) => messages.push(JSON.parse(d.toString())));
    await new Promise(r => ws.once("open", r));
    await new Promise(r => setTimeout(r, 100));

    expect(messages).toHaveLength(1); // connect snapshot
    expect((messages[0]["queue"] as unknown[]).length).toBe(1);

    await fetch(url("/api/adjudicate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimId: claimIds[0], ruling: "true" }),
    });
    await new Promise(r => setTimeout(r, 200));

    expect(messages.length).toBeGreaterThanOrEqual(2); // pushed update
    const last = messages[messages.length - 1];
    expect((last["queue"] as unknown[]).length).toBe(0);
    ws.close();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/service.test.ts`
Expected: all PASS (broadcast already wired in Task 4).

- [ ] **Step 3: Commit**

```bash
git add tests/service.test.ts
git commit -m "test: websocket snapshot on connect and push on adjudication"
```

---

### Task 7: Entry point — npm start boots the resident marketplace

**Files:**
- Create: `src/main.ts`
- Modify: `package.json` (scripts), `src/index.ts` (exports)

- [ ] **Step 1: Create src/main.ts**

```typescript
import { Store } from "./store/store.js";
import { startService } from "./server/service.js";

const PORT = Number(process.env["MP_PORT"] ?? 4280);
const DB = process.env["MP_DB"] ?? "data/marketplace.sqlite";

const store = new Store(DB);
const svc = await startService({ store, port: PORT });

console.error(`Marketplace of Ideas — resident at http://127.0.0.1:${svc.port}`);
console.error(`DB: ${DB}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void svc.close().then(() => { store.close(); process.exit(0); });
  });
}
```

- [ ] **Step 2: Wire scripts and exports**

In `package.json`, change `"start"` to:

```json
"start": "node dist/main.js",
```

In `src/index.ts`, append:

```typescript
export * from "./server/cards.js";
export * from "./server/service.js";
```

- [ ] **Step 3: Build and boot-smoke it**

Run: `npm run typecheck && npm run build && (node dist/main.js & SVPID=$!; sleep 1; curl -s http://127.0.0.1:4280/api/state | head -c 200; echo; kill $SVPID)`
Expected: JSON starting with `{"summary":{"ideas":...`. The created `data/` dir is gitignored.

- [ ] **Step 4: Run everything and commit**

Run: `npx vitest run`
Expected: all PASS.

```bash
git add src/main.ts src/index.ts package.json
git commit -m "feat: npm start boots the resident marketplace service"
```

---

### Task 8: The web UI

One HTML file, one JS file, no build step. Layout: header stats → session launcher → adjudication queue (the product's heart) → ideas/markets with price bars and sparklines → agents and activity feed. WebSocket with polling fallback.

**SECURITY RULE for this task:** every dynamic string in the page — claim text, evidence, reasoning, agent ids, topics — is authored by LLM agents and therefore untrusted. All rendering goes through the `el()` helper (`createElement` + `textContent`). `innerHTML` must not appear anywhere in `app.js`; clearing a container uses `replaceChildren()`.

**Files:**
- Rewrite: `public/index.html`
- Create: `public/app.js`

- [ ] **Step 1: Rewrite public/index.html**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marketplace of Ideas</title>
<style>
  :root {
    --bg: #0f1115; --panel: #181b22; --panel2: #1f232c; --text: #e6e6e6;
    --dim: #9aa3b2; --green: #4ade80; --red: #f87171; --amber: #fbbf24;
    --accent: #7dd3fc; --border: #2a2f3a;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f5f6f8; --panel:#ffffff; --panel2:#eef0f4; --text:#1a1d23; --dim:#5b6472; --border:#d8dce4; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { display:flex; gap:24px; align-items:baseline; padding:14px 20px; border-bottom:1px solid var(--border); }
  header h1 { font-size:16px; margin:0; letter-spacing:.02em; }
  header .stat { color:var(--dim); } header .stat b { color:var(--text); }
  #conn { margin-left:auto; font-size:12px; color:var(--dim); }
  main { display:grid; grid-template-columns: 1fr 380px; gap:16px; padding:16px 20px; max-width:1400px; margin:0 auto; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  section { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; margin-bottom:16px; }
  section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:0 0 10px; }
  .card { background:var(--panel2); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px; }
  .card .claim { font-size:15px; margin-bottom:6px; }
  .card .meta { color:var(--dim); font-size:12px; margin-bottom:8px; }
  .ev { font-size:12px; margin:2px 0; padding-left:14px; position:relative; }
  .ev::before { content:"•"; position:absolute; left:2px; }
  .ev.sup::before { color:var(--green); } .ev.cnt::before { color:var(--red); }
  .verdict { font-size:12px; color:var(--dim); font-style:italic; margin-top:6px; }
  .actions { display:flex; gap:8px; margin-top:10px; }
  button { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:6px 14px; cursor:pointer; font-size:13px; }
  button:hover { border-color:var(--accent); }
  button.rule-true { color:var(--green); } button.rule-false { color:var(--red); }
  .pricebar { height:6px; background:var(--panel2); border-radius:3px; overflow:hidden; margin:4px 0; }
  .pricebar i { display:block; height:100%; background:linear-gradient(90deg, var(--red), var(--amber), var(--green)); }
  .claimrow { display:grid; grid-template-columns: 1fr 100px 64px; gap:10px; align-items:center; padding:6px 0; border-top:1px solid var(--border); font-size:13px; }
  .claimrow.resolved { color:var(--dim); }
  .claimrow .p { text-align:right; font-variant-numeric: tabular-nums; }
  .idea-title { font-weight:600; margin:10px 0 4px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td, th { text-align:left; padding:4px 6px; border-top:1px solid var(--border); font-variant-numeric: tabular-nums; }
  th { color:var(--dim); font-weight:500; border-top:none; }
  #feed div { font-size:12px; color:var(--dim); padding:3px 0; border-top:1px solid var(--border); }
  form { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input, select { background:var(--panel2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:7px 10px; font-size:13px; }
  input[type=text] { flex:1; min-width:260px; }
  #sessionStatus { font-size:12px; color:var(--amber); margin-top:8px; min-height:1em; }
  .empty { color:var(--dim); font-size:13px; font-style:italic; }
</style>
</head>
<body>
<header>
  <h1>Marketplace of Ideas</h1>
  <span class="stat">ideas <b id="st-ideas">0</b></span>
  <span class="stat">claims <b id="st-claims">0</b></span>
  <span class="stat">open <b id="st-open">0</b></span>
  <span class="stat">resolved <b id="st-resolved">0</b></span>
  <span id="conn">connecting…</span>
</header>
<main>
  <div id="left">
    <section>
      <h2>Launch deliberation</h2>
      <form id="sessionForm">
        <input type="text" id="topic" placeholder="Topic — e.g. 'Local-first software will beat cloud SaaS for personal tools'" required>
        <select id="traders"><option>2</option><option selected>3</option><option>4</option><option>5</option></select>
        <select id="iters"><option>4</option><option selected>8</option><option>12</option></select>
        <button type="submit" id="launch">Start</button>
      </form>
      <div id="sessionStatus"></div>
    </section>
    <section>
      <h2>Ideas &amp; markets</h2>
      <div id="markets"></div>
    </section>
  </div>
  <div id="right">
    <section>
      <h2>Your adjudication queue</h2>
      <div id="queue"></div>
    </section>
    <section>
      <h2>Agents</h2>
      <table><thead><tr><th>agent</th><th>balance</th><th>rep</th></tr></thead><tbody id="agents"></tbody></table>
    </section>
    <section>
      <h2>Activity</h2>
      <div id="feed"></div>
    </section>
  </div>
</main>
<script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create public/app.js**

All rendering is built with `el()`/`textContent` — no HTML string interpolation anywhere.

```javascript
const $ = (id) => document.getElementById(id);

/** Safe element builder: attributes are set via setAttribute, children that are
 *  strings become text nodes. Untrusted agent content can never become markup. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("data-")) node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

const histCache = new Map();

function renderQueue(queue) {
  const cards = queue.map(c =>
    el("div", { class: "card" },
      el("div", { class: "claim" }, c.claimText),
      el("div", { class: "meta" },
        `${c.ideaTitle} · yes ${(c.yesPrice * 100).toFixed(0)}% · ${c.orders} orders · ${c.reason}`),
      c.supporting.map(e => el("div", { class: "ev sup" }, e)),
      c.counter.map(e => el("div", { class: "ev cnt" }, e)),
      c.verdicts.slice(0, 2).map(v =>
        el("div", { class: "verdict" }, `${v.agentId} ${(v.confidence * 100).toFixed(0)}%: ${v.reasoning}`)),
      el("div", { class: "actions" },
        el("button", { class: "rule-true", "data-claim": c.claimId, "data-ruling": "true" }, "True"),
        el("button", { class: "rule-false", "data-claim": c.claimId, "data-ruling": "false" }, "False"),
        el("button", { "data-claim": c.claimId, "data-ruling": "skip" }, "Skip"),
      ),
    ));
  $("queue").replaceChildren(...(cards.length ? cards : [el("p", { class: "empty" }, "Nothing needs your judgment yet.")]));
}

function sparkSvg(claimId) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "60");
  svg.setAttribute("height", "20");
  svg.setAttribute("viewBox", "0 0 60 20");
  svg.dataset.claim = claimId;
  svg.classList.add("spark");
  return svg;
}

function renderMarkets(ideas) {
  const blocks = ideas.flatMap(idea => [
    el("div", { class: "idea-title" }, idea.title),
    ...idea.claims.map(c => {
      const bar = el("div", { class: "pricebar" }, el("i", { style: `width:${(c.yesPrice * 100).toFixed(1)}%` }));
      const left = el("div", {}, c.text, c.resolution ? ` — ${c.resolution.toUpperCase()}` : "", bar);
      const spark = sparkSvg(c.id);
      const row = el("div", { class: `claimrow${c.resolution ? " resolved" : ""}` },
        left,
        el("div", { class: "p" }, `${(c.yesPrice * 100).toFixed(1)}% · ${c.orders} ord`),
        spark,
      );
      void drawSpark(spark);
      return row;
    }),
  ]);
  $("markets").replaceChildren(...(blocks.length ? blocks : [el("p", { class: "empty" }, "No ideas yet. Launch a session.")]));
}

async function drawSpark(svg) {
  const claim = svg.dataset.claim;
  let path = histCache.get(claim);
  if (!path) {
    try { path = (await (await fetch(`/api/history/${encodeURIComponent(claim)}`)).json()).path; }
    catch { return; }
    histCache.set(claim, path);
    setTimeout(() => histCache.delete(claim), 3000);
  }
  if (!path || path.length < 2) return;
  const pts = path.map((p, i) => `${(i / (path.length - 1)) * 58 + 1},${19 - p.yesPrice * 18}`).join(" ");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", pts);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--accent)");
  line.setAttribute("stroke-width", "1.5");
  svg.replaceChildren(line);
}

function render(s) {
  $("st-ideas").textContent = s.summary.ideas;
  $("st-claims").textContent = s.summary.claims;
  $("st-open").textContent = s.summary.openMarkets;
  $("st-resolved").textContent = s.summary.resolvedMarkets;

  $("launch").disabled = s.session.running;
  $("sessionStatus").textContent = s.session.running
    ? "Session running — agents are writing code and trading…"
    : (s.session.error ? `Last session issues: ${s.session.error}` : "");

  renderQueue(s.queue);
  renderMarkets(s.ideas);

  $("agents").replaceChildren(...s.agents.map(a =>
    el("tr", {},
      el("td", {}, a.agentId),
      el("td", {}, a.balance.toFixed(0)),
      el("td", {}, a.reputation.toFixed(2)),
    )));

  $("feed").replaceChildren(...s.recentOrders.map(o =>
    el("div", {}, `${o.agentId} bought ${o.shares.toFixed(0)} ${o.side.toUpperCase()} on ${o.claimId} (cost ${o.cost.toFixed(1)})`)));
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-claim]");
  if (!btn) return;
  btn.disabled = true;
  await fetch("/api/adjudicate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ claimId: btn.dataset.claim, ruling: btn.dataset.ruling }),
  });
  await refresh();
});

$("sessionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: $("topic").value,
      traders: Number($("traders").value),
      maxIterations: Number($("iters").value),
    }),
  });
  const body = await res.json();
  $("sessionStatus").textContent = res.ok
    ? `Started with: ${body.traders.join(", ")}`
    : `Error: ${body.error}`;
});

async function refresh() {
  try { render(await (await fetch("/api/state")).json()); } catch { /* server gone; ws/poll will retry */ }
}

let pollTimer = null;
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { $("conn").textContent = "live"; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
  ws.onmessage = (ev) => { histCache.clear(); render(JSON.parse(ev.data)); };
  ws.onclose = () => {
    $("conn").textContent = "polling";
    if (!pollTimer) pollTimer = setInterval(refresh, 2000);
    setTimeout(connect, 3000);
  };
}
connect();
refresh();
```

- [ ] **Step 3: Verify no innerHTML, the suite stays green, and the files serve**

Run: `grep -c "innerHTML" public/app.js || echo NONE` — expected: `NONE` (grep finds zero).
Run: `npx vitest run && npm run build && (node dist/main.js & SVPID=$!; sleep 1; curl -s http://127.0.0.1:4280/app.js | head -c 60; echo; kill $SVPID)`
Expected: tests PASS; the first bytes of app.js are served.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: web UI — adjudication queue, live markets, session launcher (safe DOM rendering)"
```

---

### Task 9: MCP server — external agents' window

Tool functions are pure functions over the Store (`src/mcp/registry.ts`, fully unit-testable); `src/mcp/server.ts` is a thin stdio shell. **No adjudication tool exists** — external agents trade and propose; only the human settles, via the web UI.

**Files:**
- Create: `src/mcp/registry.ts`
- Create: `src/mcp/server.ts`
- Create: `tests/mcp-registry.test.ts`
- Modify: `package.json` (add registry script)

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp-registry.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mcp-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/mcp/registry.ts**

```typescript
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
```

- [ ] **Step 4: Create src/mcp/server.ts**

```typescript
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
```

- [ ] **Step 5: Add the registry script**

In `package.json` scripts, add:

```json
"registry": "node dist/mcp/server.js",
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/mcp-registry.test.ts && npm run typecheck`
Expected: all PASS. If the MCP SDK's `server.tool(...)` signature has drifted (it changes between SDK versions), check `node_modules/@modelcontextprotocol/sdk` typings and adapt `server.ts` only — `registry.ts` and its tests must not change.

- [ ] **Step 7: Commit**

```bash
git add src/mcp tests/mcp-registry.test.ts package.json
git commit -m "feat: recreate MCP idea-registry over the shared store (no settlement tools)"
```

---

### Task 10: Close-out

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: everything green.

- [ ] **Step 2: Manual boot check**

Run `npm start` in the background, then:
`curl -s http://127.0.0.1:4280/api/state && curl -s http://127.0.0.1:4280/ | head -c 200` — both return content. Stop the process.

- [ ] **Step 3: Update bd**

```bash
bd close Marketplace-6jx
```

(Leave Marketplace-lom — Phase 3 GEPA — open.)

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: phase 2 service + web UI complete"
```

Then follow CLAUDE.md session completion. Note: if no git remote exists yet, report that `git push` is blocked on creating one rather than skipping silently.

---

## Self-Review (completed at plan-writing time)

- **Spec coverage:** resident process + same-process HTTP/WS server (T4, T6), adjudication surface with stance-split cards — visible, pending, only real after the human acts (T3, T8), settlement reachable only via POST /api/adjudicate → `applyAdjudication` (T4, T5; MCP explicitly has no settlement tool, pinned by test in T9), session launching from the UI (T4, T5, T8), live WebSocket push with polling fallback (T4, T6, T8), price trajectories (T2 priceHistory, sparklines in T8), agents/balances/activity feed (T2, T8), MCP recreated over the shared store (T9), orphaned evaluator deleted (T1), bd lifecycle (T1, T10). Deferred per spec: GEPA (Phase 3, Marketplace-lom), full graph canvas (list-grouped market view here; canvas is UI polish for later).
- **Type consistency:** `Service`/`startService`/`TraderFactory` defined T4, consumed T5–T8; store read-model methods defined T2, used by cards (T3), service (T4), registry (T9); `AdjudicationCard` defined T3, consumed by T4 snapshot and T8 rendering. `runSession`'s `SessionConfig` fields match the Phase 1 harness exactly (verified against committed source before writing).
- **Placeholder scan:** complete code in every step; no TBDs; every task self-contained and ends green. The two external-API drift risks (vitest `import.meta.dirname`, MCP SDK `server.tool` signature) have explicit, bounded fallback instructions.
- **Security:** agent-authored strings are untrusted; the UI renders exclusively via `el()`/`textContent`/`replaceChildren` with a grep-gate in T8 Step 3 (`innerHTML` must not appear in app.js); static file serving rejects path traversal (pinned by test in T4).
- **Literal-executor hardening:** no forward references, insertion points anchored ("before `close()`"), exact commands with expected output, behavior tests pin endpoint semantics so a mangled step fails immediately.
