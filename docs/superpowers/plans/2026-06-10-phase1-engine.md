# Marketplace Engine (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Headless deliberation engine: recursive code-writing `RlmAgent`s on `@ax-llm/ax` trade in LMSR markets over a SQLite store, with human-only adjudication applied via an engine API.

**Architecture:** One SQLite store (`better-sqlite3`) is the shared environment. Each `RlmAgent` runs a loop: an Ax `writeCode` signature emits JavaScript, a `node:vm` sandbox executes it against store-backed marketplace tools, truncated stdout feeds the next iteration. `subAgent()` recursion spawns capability-identical children (shared wallet) until a depth cap, where calls degrade to a structured `evaluateClaim` signature. A deterministic harness runs N agents concurrently, enforces budgets, and nominates claims for human adjudication — it never settles. `applyAdjudication()` (called by the human via Phase 2 UI; here via API/tests) pays out, updates reputation, and emits GEPA training examples.

**Tech Stack:** TypeScript (ESM, NodeNext), `@ax-llm/ax`, `better-sqlite3`, `node:vm`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-06-10-marketplace-of-ideas-ax-design.md`

**Verified Ax API (June 2026, axllm.dev):** `ai({ name: 'deepseek', apiKey })` creates a provider; `ax('a:string -> b:string')` creates a generator; `await gen.forward(llm, { a })` runs it; `AxGEPA({ studentAI }).compile(generator, examples, metric, opts)` optimizes (Phase 3). Use `type AxLLM = ReturnType<typeof ai>` rather than importing provider types — more stable across versions.

**File structure (end state):**

```
src/
  types/deliberation.ts     (existing — untouched this phase)
  market/lmsr.ts            (rewritten: pure math, correct payouts)
  store/db.ts               (new: connection + schema)
  store/store.ts            (new: all state operations; the ONLY writer)
  engine/sandbox.ts         (new: vm sandbox with injected marketplace API)
  engine/codegen.ts         (new: Ax signatures + code extraction + providers)
  engine/agent.ts           (new: RlmAgent recursive loop)
  engine/harness.ts         (new: runSession, budgets, nomination scan)
  index.ts                  (rewritten: exports new modules)
  evaluate/sub-agent.ts     (legacy — kept ONLY because mcp/ imports it; both go in Phase 2)
  mcp/idea-registry/server.ts (legacy — rewired in Phase 2)
tests/
  lmsr.test.ts
  store.test.ts
  adjudication.test.ts
  sandbox.test.ts
  agent.test.ts
  harness.test.ts
  live-smoke.test.ts        (skipped unless DEEPSEEK_API_KEY set)
```

**Deleted this phase:** `src/server/`, `src/rlm/`, `src/tools/`, root `test-*.ts` (all preserved in git commit `fc7479f`).

**Conventions for every task:** Run tests with `npx vitest run <file>`. Typecheck with `npm run typecheck`. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Tooling — dependencies, vitest, scripts

**Files:**
- Modify: `package.json`
- Create: `tests/toolchain.test.ts`

- [ ] **Step 1: Install dependencies**

```bash
npm install @ax-llm/ax better-sqlite3
npm install -D vitest @types/better-sqlite3
```

- [ ] **Step 2: Add scripts to package.json**

In `package.json`, replace the `"scripts"` block with:

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "registry": "node dist/mcp/idea-registry/server.js",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "clean": "rm -rf dist"
}
```

- [ ] **Step 3: Write a toolchain smoke test**

Create `tests/toolchain.test.ts`:

```typescript
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
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/toolchain.test.ts`
Expected: 2 tests PASS. If the `ax(...)` construction throws, read the error — the signature string syntax may have drifted; check `node_modules/@ax-llm/ax/README.md` and adjust (this is the one external API we depend on).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tests/toolchain.test.ts
git commit -m "chore: add ax, better-sqlite3, vitest toolchain"
```

---

### Task 2: Delete legacy code

The old HTTP API, RLM loop/REPL, Python tools, and hand-scripted root tests are superseded by this plan. They are preserved in git history (`fc7479f`). `src/evaluate/sub-agent.ts` and `src/mcp/` stay until Phase 2 (the MCP server imports the evaluator).

**Files:**
- Delete: `src/server/`, `src/rlm/`, `src/tools/`, `test-divergence.ts`, `test-full-pipeline.ts`, `test-market.ts`, `test-real-e2e.ts`, `test-rlm-loop.ts`, `test-self-improve.ts`, `ax.yaml`
- Modify: `src/index.ts`

- [ ] **Step 1: Delete the files**

```bash
git rm -r src/server src/rlm src/tools
git rm test-divergence.ts test-full-pipeline.ts test-market.ts test-real-e2e.ts test-rlm-loop.ts test-self-improve.ts ax.yaml
```

(`ax.yaml` configured a different tool entirely — the `project-ax/ax` runner, not `@ax-llm/ax`.)

- [ ] **Step 2: Trim src/index.ts**

Replace the entire contents of `src/index.ts` with:

```typescript
export * from "./types/deliberation.js";
export * from "./market/lmsr.js";
```

(New modules get re-exported as later tasks create them.)

- [ ] **Step 3: Verify typecheck and tests still pass**

Run: `npm run typecheck && npx vitest run`
Expected: clean typecheck (the remaining legacy `src/evaluate/` and `src/mcp/` compile on their own), toolchain tests PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove superseded HTTP API, RLM prototype, Python tools"
```

---

### Task 3: LMSR rewrite — correct economics

Rewrite `src/market/lmsr.ts` as pure math over share quantities. The old version had two economic bugs: order `amount` was deducted from balance but treated as share count (cost ≠ amount), and winners were paid losers' stakes *plus* shares. Correct LMSR: cost of a trade is `C(q_after) − C(q_before)` where `C(qy,qn) = b·ln(e^(qy/b) + e^(qn/b))`; each winning share redeems for exactly 1 token at resolution; the market maker's max subsidy is `b·ln 2`.

**Files:**
- Rewrite: `src/market/lmsr.ts`
- Create: `tests/lmsr.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lmsr.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { lmsrPrice, lmsrCost, buyCost } from "../src/market/lmsr.js";

describe("lmsrPrice", () => {
  it("is 0.5/0.5 at equal quantities", () => {
    const p = lmsrPrice(0, 0, 100);
    expect(p.yes).toBeCloseTo(0.5);
    expect(p.no).toBeCloseTo(0.5);
  });

  it("yes price rises with yes quantity and stays in (0,1)", () => {
    const p1 = lmsrPrice(50, 0, 100);
    const p2 = lmsrPrice(200, 0, 100);
    expect(p1.yes).toBeGreaterThan(0.5);
    expect(p2.yes).toBeGreaterThan(p1.yes);
    expect(p2.yes).toBeLessThan(1);
    expect(p1.yes + p1.no).toBeCloseTo(1);
  });
});

describe("buyCost", () => {
  it("costs more than shares*startPrice and less than shares*endPrice (convexity)", () => {
    const b = 100;
    const startPrice = lmsrPrice(0, 0, b).yes;
    const cost = buyCost(0, 0, b, "yes", 50);
    const endPrice = lmsrPrice(50, 0, b).yes;
    expect(cost).toBeGreaterThan(50 * startPrice);
    expect(cost).toBeLessThan(50 * endPrice);
  });

  it("buying 'no' raises the cost basis symmetrically", () => {
    const yesCost = buyCost(0, 0, 100, "yes", 30);
    const noCost = buyCost(0, 0, 100, "no", 30);
    expect(yesCost).toBeCloseTo(noCost);
  });

  it("market maker loss is bounded by b*ln2: payout - collected <= b*ln2", () => {
    const b = 100;
    // One trader buys 500 YES shares in steps; YES resolves true.
    let qYes = 0;
    let collected = 0;
    for (let i = 0; i < 10; i++) {
      collected += buyCost(qYes, 0, b, "yes", 50);
      qYes += 50;
    }
    const payout = qYes * 1; // each winning share redeems for 1
    expect(payout - collected).toBeLessThanOrEqual(b * Math.log(2) + 1e-9);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/lmsr.test.ts`
Expected: FAIL — `buyCost` is not exported.

- [ ] **Step 3: Rewrite src/market/lmsr.ts**

Replace the entire contents of `src/market/lmsr.ts` with:

```typescript
export type Side = "yes" | "no";

/** LMSR cost function C(qYes, qNo) = b * ln(e^(qYes/b) + e^(qNo/b)). */
export function lmsrCost(qYes: number, qNo: number, b: number): number {
  // Subtract max exponent for numerical stability at large q.
  const m = Math.max(qYes, qNo) / b;
  return b * (m + Math.log(Math.exp(qYes / b - m) + Math.exp(qNo / b - m)));
}

export function lmsrPrice(qYes: number, qNo: number, b: number): { yes: number; no: number } {
  const m = Math.max(qYes, qNo) / b;
  const ey = Math.exp(qYes / b - m);
  const en = Math.exp(qNo / b - m);
  return { yes: ey / (ey + en), no: en / (ey + en) };
}

/** Token cost to buy `shares` on `side` given current quantities. Always positive. */
export function buyCost(qYes: number, qNo: number, b: number, side: Side, shares: number): number {
  if (shares <= 0) throw new Error("shares must be positive");
  const after = side === "yes"
    ? lmsrCost(qYes + shares, qNo, b)
    : lmsrCost(qYes, qNo + shares, b);
  return after - lmsrCost(qYes, qNo, b);
}
```

(Payout and reputation logic move to the store in Task 5 — each winning share redeems for exactly 1 token; that is the whole resolution rule. `createMarket`/`buyShares`/`resolveMarket`/`computeRentScore` are deleted; rent scoring returns in a later milestone per spec.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/lmsr.test.ts && npm run typecheck`
Expected: all PASS, clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/market/lmsr.ts tests/lmsr.test.ts
git commit -m "feat: rewrite LMSR as pure math with correct cost/payout economics"
```

---

### Task 4: Store — schema, agents, ideas, claims, evidence

The store is the single writer to SQLite and the agents' shared environment. This task creates the schema and the proposal/evidence half; Task 5 adds markets/orders; Task 6 adds nomination/adjudication.

**Files:**
- Create: `src/store/db.ts`
- Create: `src/store/store.ts`
- Create: `tests/store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";

describe("Store: agents, ideas, evidence", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("ensureAgent creates with defaults and is idempotent", () => {
    const a = store.ensureAgent("trader-1");
    expect(a.balance).toBe(1000);
    expect(a.reputation).toBe(0.5);
    store.adjustBalance("trader-1", -100);
    expect(store.ensureAgent("trader-1").balance).toBe(900);
  });

  it("propose creates idea + claims + markets with CONSISTENT ids", () => {
    const r = store.propose({
      title: "Remote Work Is Net Positive",
      summary: "s", body: "b",
      claims: ["productivity rises", "collaboration suffers"],
      author: "trader-1",
    });
    expect(r.claimIds).toHaveLength(2);
    const idea = store.getIdea(r.ideaId)!;
    // THE bug fix: idea.claimIds must equal the ids claims/markets are keyed by.
    expect(idea.claimIds).toEqual(r.claimIds);
    for (const cid of r.claimIds) {
      expect(store.getClaim(cid)).toBeTruthy();
      expect(store.getMarket(cid)).toBeTruthy();
    }
  });

  it("propose disambiguates duplicate titles", () => {
    const a = store.propose({ title: "Same", summary: "s", body: "", claims: ["c"], author: "x" });
    const b = store.propose({ title: "Same", summary: "s", body: "", claims: ["c"], author: "x" });
    expect(a.ideaId).not.toBe(b.ideaId);
  });

  it("evidence has a stance and lists per claim", () => {
    const r = store.propose({ title: "T", summary: "s", body: "", claims: ["c1"], author: "x" });
    store.addEvidence({ claimId: r.claimIds[0], excerpt: "for it", stance: "supporting", submittedBy: "x" });
    store.addEvidence({ claimId: r.claimIds[0], excerpt: "against it", stance: "counter", submittedBy: "x" });
    const ev = store.listEvidence(r.claimIds[0]);
    expect(ev.map(e => e.stance).sort()).toEqual(["counter", "supporting"]);
  });

  it("counters() reports state sizes", () => {
    store.propose({ title: "T", summary: "s", body: "", claims: ["c1", "c2"], author: "x" });
    const c = store.counters();
    expect(c.ideas).toBe(1);
    expect(c.claims).toBe(2);
    expect(c.openMarkets).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/store/db.ts**

```typescript
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS agents (
    agent_id TEXT PRIMARY KEY,
    balance REAL NOT NULL,
    reputation REAL NOT NULL,
    correct INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    body TEXT NOT NULL,
    parent_id TEXT,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed'
  )`,
  `CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    idea_id TEXT NOT NULL REFERENCES ideas(id),
    ord INTEGER NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL REFERENCES claims(id),
    excerpt TEXT NOT NULL,
    stance TEXT NOT NULL CHECK (stance IN ('supporting','counter')),
    source_url TEXT,
    relevance REAL NOT NULL DEFAULT 0.5,
    submitted_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS markets (
    claim_id TEXT PRIMARY KEY REFERENCES claims(id),
    q_yes REAL NOT NULL DEFAULT 0,
    q_no REAL NOT NULL DEFAULT 0,
    b REAL NOT NULL,
    resolution TEXT CHECK (resolution IN ('true','false')),
    resolved_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS positions (
    claim_id TEXT NOT NULL REFERENCES claims(id),
    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
    side TEXT NOT NULL CHECK (side IN ('yes','no')),
    shares REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (claim_id, agent_id, side)
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    side TEXT NOT NULL,
    shares REAL NOT NULL,
    cost REAL NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    reasoning TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS nominations (
    claim_id TEXT PRIMARY KEY REFERENCES claims(id),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ruled','skipped')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS adjudications (
    claim_id TEXT PRIMARY KEY REFERENCES claims(id),
    outcome INTEGER NOT NULL,
    ruled_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS training_examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    supporting_json TEXT NOT NULL,
    counter_json TEXT NOT NULL,
    outcome INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const ddl of TABLES) db.prepare(ddl).run();
  return db;
}
```

- [ ] **Step 4: Create src/store/store.ts (first half)**

```typescript
import { openDb, type Db } from "./db.js";
import { lmsrPrice, buyCost, type Side } from "../market/lmsr.js";

export interface AgentRow { agentId: string; balance: number; reputation: number; correct: number; total: number }
export interface IdeaRow { id: string; title: string; summary: string; body: string; parentId: string | null; author: string; claimIds: string[] }
export interface ClaimRow { id: string; ideaId: string; text: string }
export interface EvidenceRow { id: number; claimId: string; excerpt: string; stance: "supporting" | "counter"; sourceUrl: string | null; relevance: number; submittedBy: string }
export interface MarketRow { claimId: string; qYes: number; qNo: number; b: number; yesPrice: number; resolution: "true" | "false" | null }

export interface ProposeInput {
  title: string; summary: string; body: string;
  claims: string[]; author: string; parentId?: string; b?: number;
}

const DEFAULT_BALANCE = 1000;
const DEFAULT_B = 100;

export class Store {
  readonly db: Db;
  /** Global session iteration counter, stamped onto orders for stall detection. */
  currentIteration = 0;

  constructor(path: string) {
    this.db = openDb(path);
  }

  // ── agents ──
  ensureAgent(agentId: string, balance = DEFAULT_BALANCE): AgentRow {
    this.db.prepare(
      "INSERT INTO agents (agent_id, balance, reputation) VALUES (?, ?, 0.5) ON CONFLICT(agent_id) DO NOTHING",
    ).run(agentId, balance);
    return this.getAgent(agentId)!;
  }

  getAgent(agentId: string): AgentRow | null {
    const r = this.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as
      { agent_id: string; balance: number; reputation: number; correct: number; total: number } | undefined;
    return r ? { agentId: r.agent_id, balance: r.balance, reputation: r.reputation, correct: r.correct, total: r.total } : null;
  }

  adjustBalance(agentId: string, delta: number): void {
    this.db.prepare("UPDATE agents SET balance = balance + ? WHERE agent_id = ?").run(delta, agentId);
  }

  // ── ideas / claims ──
  propose(input: ProposeInput): { ideaId: string; claimIds: string[] } {
    if (input.claims.length === 0) throw new Error("propose: at least one claim required");
    const base = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "idea";
    let ideaId = base;
    for (let n = 2; this.getIdea(ideaId); n++) ideaId = `${base}-${n}`;

    const claimIds = input.claims.map((_, i) => `${ideaId}-claim-${i + 1}`);
    const b = input.b ?? DEFAULT_B;

    const tx = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO ideas (id, title, summary, body, parent_id, author, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(ideaId, input.title, input.summary, input.body, input.parentId ?? null, input.author, Date.now());
      const insClaim = this.db.prepare("INSERT INTO claims (id, idea_id, ord, text) VALUES (?, ?, ?, ?)");
      const insMarket = this.db.prepare("INSERT INTO markets (claim_id, b) VALUES (?, ?)");
      input.claims.forEach((text, i) => {
        insClaim.run(claimIds[i], ideaId, i, text);
        insMarket.run(claimIds[i], b);
      });
    });
    tx();
    return { ideaId, claimIds };
  }

  getIdea(id: string): IdeaRow | null {
    const r = this.db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as
      { id: string; title: string; summary: string; body: string; parent_id: string | null; author: string } | undefined;
    if (!r) return null;
    const claimIds = (this.db.prepare("SELECT id FROM claims WHERE idea_id = ? ORDER BY ord").all(id) as { id: string }[]).map(c => c.id);
    return { id: r.id, title: r.title, summary: r.summary, body: r.body, parentId: r.parent_id, author: r.author, claimIds };
  }

  listIdeas(): Array<{ id: string; title: string; claimIds: string[] }> {
    const rows = this.db.prepare("SELECT id, title FROM ideas ORDER BY created_at").all() as { id: string; title: string }[];
    return rows.map(r => ({ ...r, claimIds: this.getIdea(r.id)!.claimIds }));
  }

  getClaim(id: string): ClaimRow | null {
    const r = this.db.prepare("SELECT id, idea_id, text FROM claims WHERE id = ?").get(id) as
      { id: string; idea_id: string; text: string } | undefined;
    return r ? { id: r.id, ideaId: r.idea_id, text: r.text } : null;
  }

  // ── evidence ──
  addEvidence(e: { claimId: string; excerpt: string; stance: "supporting" | "counter"; submittedBy: string; sourceUrl?: string; relevance?: number }): number {
    if (!this.getClaim(e.claimId)) throw new Error(`addEvidence: unknown claim ${e.claimId}`);
    const r = this.db.prepare(
      "INSERT INTO evidence (claim_id, excerpt, stance, source_url, relevance, submitted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(e.claimId, e.excerpt, e.stance, e.sourceUrl ?? null, e.relevance ?? 0.5, e.submittedBy, Date.now());
    return Number(r.lastInsertRowid);
  }

  listEvidence(claimId: string): EvidenceRow[] {
    const rows = this.db.prepare("SELECT * FROM evidence WHERE claim_id = ? ORDER BY id").all(claimId) as Array<
      { id: number; claim_id: string; excerpt: string; stance: "supporting" | "counter"; source_url: string | null; relevance: number; submitted_by: string }>;
    return rows.map(r => ({ id: r.id, claimId: r.claim_id, excerpt: r.excerpt, stance: r.stance, sourceUrl: r.source_url, relevance: r.relevance, submittedBy: r.submitted_by }));
  }

  // ── verdicts ──
  recordVerdict(v: { claimId: string; agentId: string; confidence: number; reasoning: string }): void {
    this.db.prepare(
      "INSERT INTO verdicts (claim_id, agent_id, confidence, reasoning, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(v.claimId, v.agentId, v.confidence, v.reasoning, Date.now());
  }

  // ── markets (read; trading added in Task 5) ──
  getMarket(claimId: string): MarketRow | null {
    const r = this.db.prepare("SELECT * FROM markets WHERE claim_id = ?").get(claimId) as
      { claim_id: string; q_yes: number; q_no: number; b: number; resolution: "true" | "false" | null } | undefined;
    if (!r) return null;
    const resolved = r.resolution !== null;
    const yesPrice = resolved ? (r.resolution === "true" ? 1 : 0) : lmsrPrice(r.q_yes, r.q_no, r.b).yes;
    return { claimId: r.claim_id, qYes: r.q_yes, qNo: r.q_no, b: r.b, yesPrice, resolution: r.resolution };
  }

  counters(): { ideas: number; claims: number; openMarkets: number; resolvedMarkets: number; pendingNominations: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      ideas: one("SELECT COUNT(*) n FROM ideas"),
      claims: one("SELECT COUNT(*) n FROM claims"),
      openMarkets: one("SELECT COUNT(*) n FROM markets WHERE resolution IS NULL"),
      resolvedMarkets: one("SELECT COUNT(*) n FROM markets WHERE resolution IS NOT NULL"),
      pendingNominations: one("SELECT COUNT(*) n FROM nominations WHERE status = 'pending'"),
    };
  }

  close(): void { this.db.close(); }
}
```

(`buyCost` and `Side` imports are used by Task 5's methods — TS will flag them as unused until Task 5 lands; proceed to Task 5 before chasing that warning.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store tests/store.test.ts
git commit -m "feat: SQLite store with consistent claim ids, stanced evidence"
```

---

### Task 5: Store — trading (placeOrder, positions, prices)

**Files:**
- Modify: `src/store/store.ts` (add methods to the class)
- Modify: `tests/store.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests** (append to `tests/store.test.ts`)

```typescript
describe("Store: trading", () => {
  let store: Store;
  let claimId: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    claimId = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" }).claimIds[0];
  });

  it("placeOrder deducts LMSR cost (not share count) and moves price", () => {
    const before = store.getAgent("alice")!.balance;
    const r = store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 50 });
    expect(r.cost).toBeGreaterThan(0);
    expect(r.cost).not.toBeCloseTo(50); // cost ≠ shares — the old bug
    expect(store.getAgent("alice")!.balance).toBeCloseTo(before - r.cost);
    expect(store.getMarket(claimId)!.yesPrice).toBeGreaterThan(0.5);
  });

  it("rejects orders the agent cannot afford", () => {
    expect(() => store.placeOrder({ claimId, agentId: "bob", side: "yes", shares: 1_000_000 }))
      .toThrow(/insufficient/i);
  });

  // Unskip after Task 6 adds nominate/applyAdjudication.
  it.skip("rejects orders on resolved markets", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    store.nominate(claimId, "test");
    store.applyAdjudication(claimId, true);
    expect(() => store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 5 }))
      .toThrow(/resolved/i);
  });

  it("accumulates positions per agent and side", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 10 });
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 15 });
    const pos = store.getPositions("alice");
    expect(pos).toEqual([{ claimId, side: "yes", shares: 25 }]);
  });
});
```

- [ ] **Step 2: Run tests to verify the new block fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `placeOrder` does not exist.

- [ ] **Step 3: Add trading methods to the Store class**

Add inside `class Store` in `src/store/store.ts`:

```typescript
  placeOrder(o: { claimId: string; agentId: string; side: Side; shares: number }): { cost: number; yesPrice: number } {
    if (o.shares <= 0) throw new Error("placeOrder: shares must be positive");
    const m = this.getMarket(o.claimId);
    if (!m) throw new Error(`placeOrder: no market for ${o.claimId}`);
    if (m.resolution) throw new Error(`placeOrder: market ${o.claimId} already resolved`);
    const agent = this.getAgent(o.agentId);
    if (!agent) throw new Error(`placeOrder: unknown agent ${o.agentId}`);

    const cost = buyCost(m.qYes, m.qNo, m.b, o.side, o.shares);
    if (cost > agent.balance) throw new Error(`placeOrder: insufficient balance (${agent.balance.toFixed(1)} < ${cost.toFixed(1)})`);

    const tx = this.db.transaction(() => {
      this.adjustBalance(o.agentId, -cost);
      const col = o.side === "yes" ? "q_yes" : "q_no";
      this.db.prepare(`UPDATE markets SET ${col} = ${col} + ? WHERE claim_id = ?`).run(o.shares, o.claimId);
      this.db.prepare(
        `INSERT INTO positions (claim_id, agent_id, side, shares) VALUES (?, ?, ?, ?)
         ON CONFLICT(claim_id, agent_id, side) DO UPDATE SET shares = shares + excluded.shares`,
      ).run(o.claimId, o.agentId, o.side, o.shares);
      this.db.prepare(
        "INSERT INTO orders (claim_id, agent_id, side, shares, cost, iteration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(o.claimId, o.agentId, o.side, o.shares, cost, this.currentIteration, Date.now());
    });
    tx();
    return { cost, yesPrice: this.getMarket(o.claimId)!.yesPrice };
  }

  getPositions(agentId: string): Array<{ claimId: string; side: Side; shares: number }> {
    const rows = this.db.prepare(
      "SELECT claim_id, side, shares FROM positions WHERE agent_id = ? AND shares > 0 ORDER BY claim_id",
    ).all(agentId) as Array<{ claim_id: string; side: Side; shares: number }>;
    return rows.map(r => ({ claimId: r.claim_id, side: r.side, shares: r.shares }));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (with the one `it.skip` pending Task 6).

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts tests/store.test.ts
git commit -m "feat: LMSR trading through the store with positions and balance checks"
```

---

### Task 6: Store — nomination and human adjudication

Settlement is human-only. `nominate()` queues a claim; `applyAdjudication()` is the single function the human's ruling flows through: resolve market, redeem winning shares at 1 token each, update reputation (stance = the side the agent holds more shares of), record the adjudication, emit a GEPA training example.

**Files:**
- Modify: `src/store/store.ts`
- Create: `tests/adjudication.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/adjudication.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";

describe("nomination + adjudication", () => {
  let store: Store;
  let claimId: string;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("alice");
    store.ensureAgent("bob");
    claimId = store.propose({ title: "T", summary: "s", body: "", claims: ["c"], author: "alice" }).claimIds[0];
    store.addEvidence({ claimId, excerpt: "pro", stance: "supporting", submittedBy: "alice" });
    store.addEvidence({ claimId, excerpt: "con", stance: "counter", submittedBy: "bob" });
  });

  it("nominate queues once, idempotently", () => {
    store.nominate(claimId, "threshold");
    store.nominate(claimId, "threshold");
    expect(store.pendingNominations()).toHaveLength(1);
  });

  it("adjudication pays winners 1 token per share, updates reputation, emits training example", () => {
    store.placeOrder({ claimId, agentId: "alice", side: "yes", shares: 40 });
    store.placeOrder({ claimId, agentId: "bob", side: "no", shares: 30 });
    const aliceBefore = store.getAgent("alice")!.balance;
    const bobBefore = store.getAgent("bob")!.balance;

    store.nominate(claimId, "threshold");
    store.applyAdjudication(claimId, true);

    expect(store.getAgent("alice")!.balance).toBeCloseTo(aliceBefore + 40); // 40 shares × 1
    expect(store.getAgent("bob")!.balance).toBeCloseTo(bobBefore);          // losers get nothing back
    expect(store.getAgent("alice")!.reputation).toBe(1);  // 1/1 correct
    expect(store.getAgent("bob")!.reputation).toBe(0);    // 0/1
    expect(store.getMarket(claimId)!.resolution).toBe("true");
    expect(store.getMarket(claimId)!.yesPrice).toBe(1);

    const ex = store.listTrainingExamples();
    expect(ex).toHaveLength(1);
    expect(ex[0].outcome).toBe(true);
    expect(ex[0].supporting).toEqual(["pro"]);
    expect(ex[0].counter).toEqual(["con"]);

    expect(store.pendingNominations()).toHaveLength(0);
  });

  it("skip leaves the market open and emits no training data", () => {
    store.nominate(claimId, "threshold");
    store.skipNomination(claimId);
    expect(store.getMarket(claimId)!.resolution).toBeNull();
    expect(store.listTrainingExamples()).toHaveLength(0);
    expect(store.pendingNominations()).toHaveLength(0);
  });

  it("adjudicating twice throws", () => {
    store.nominate(claimId, "x");
    store.applyAdjudication(claimId, true);
    expect(() => store.applyAdjudication(claimId, false)).toThrow(/resolved/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adjudication.test.ts`
Expected: FAIL — `nominate` does not exist.

- [ ] **Step 3: Add nomination/adjudication methods to the Store class**

Add inside `class Store` in `src/store/store.ts`:

```typescript
  nominate(claimId: string, reason: string): void {
    if (!this.getClaim(claimId)) throw new Error(`nominate: unknown claim ${claimId}`);
    this.db.prepare(
      "INSERT INTO nominations (claim_id, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(claim_id) DO NOTHING",
    ).run(claimId, reason, Date.now());
  }

  pendingNominations(): Array<{ claimId: string; reason: string }> {
    const rows = this.db.prepare(
      "SELECT claim_id, reason FROM nominations WHERE status = 'pending' ORDER BY created_at",
    ).all() as Array<{ claim_id: string; reason: string }>;
    return rows.map(r => ({ claimId: r.claim_id, reason: r.reason }));
  }

  skipNomination(claimId: string): void {
    this.db.prepare("UPDATE nominations SET status = 'skipped' WHERE claim_id = ?").run(claimId);
  }

  /** The ONLY settlement path. Called with the human's ruling. */
  applyAdjudication(claimId: string, outcome: boolean): void {
    const m = this.getMarket(claimId);
    if (!m) throw new Error(`applyAdjudication: no market for ${claimId}`);
    if (m.resolution) throw new Error(`applyAdjudication: ${claimId} already resolved`);
    const claim = this.getClaim(claimId)!;

    const positions = this.db.prepare(
      "SELECT agent_id, side, shares FROM positions WHERE claim_id = ? AND shares > 0",
    ).all(claimId) as Array<{ agent_id: string; side: "yes" | "no"; shares: number }>;

    const winningSide = outcome ? "yes" : "no";

    // Stance per agent = side it holds more shares of.
    const byAgent = new Map<string, { yes: number; no: number }>();
    for (const p of positions) {
      const e = byAgent.get(p.agent_id) ?? { yes: 0, no: 0 };
      e[p.side] += p.shares;
      byAgent.set(p.agent_id, e);
    }

    const tx = this.db.transaction(() => {
      for (const p of positions) {
        if (p.side === winningSide) this.adjustBalance(p.agent_id, p.shares); // redeem 1:1
      }
      for (const [agentId, pos] of byAgent) {
        if (pos.yes === pos.no) continue; // no stance, no reputation change
        const stanceCorrect = (pos.yes > pos.no) === outcome;
        this.db.prepare(
          "UPDATE agents SET total = total + 1, correct = correct + ?, reputation = CAST(correct + ? AS REAL) / (total + 1) WHERE agent_id = ?",
        ).run(stanceCorrect ? 1 : 0, stanceCorrect ? 1 : 0, agentId);
      }
      this.db.prepare("UPDATE markets SET resolution = ?, resolved_at = ? WHERE claim_id = ?")
        .run(outcome ? "true" : "false", Date.now(), claimId);
      this.db.prepare("INSERT INTO adjudications (claim_id, outcome, ruled_at) VALUES (?, ?, ?)")
        .run(claimId, outcome ? 1 : 0, Date.now());
      this.db.prepare("UPDATE nominations SET status = 'ruled' WHERE claim_id = ?").run(claimId);

      const ev = this.listEvidence(claimId);
      this.db.prepare(
        "INSERT INTO training_examples (claim_id, claim_text, supporting_json, counter_json, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        claimId, claim.text,
        JSON.stringify(ev.filter(e => e.stance === "supporting").map(e => e.excerpt)),
        JSON.stringify(ev.filter(e => e.stance === "counter").map(e => e.excerpt)),
        outcome ? 1 : 0, Date.now(),
      );
    });
    tx();
  }

  listTrainingExamples(): Array<{ claimId: string; claimText: string; supporting: string[]; counter: string[]; outcome: boolean }> {
    const rows = this.db.prepare("SELECT * FROM training_examples ORDER BY id").all() as Array<
      { claim_id: string; claim_text: string; supporting_json: string; counter_json: string; outcome: number }>;
    return rows.map(r => ({
      claimId: r.claim_id, claimText: r.claim_text,
      supporting: JSON.parse(r.supporting_json) as string[],
      counter: JSON.parse(r.counter_json) as string[],
      outcome: r.outcome === 1,
    }));
  }
```

- [ ] **Step 4: Unskip the Task 5 resolved-market test, run everything**

Remove the `.skip` from the "rejects orders on resolved markets" test in `tests/store.test.ts`.
Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts tests/adjudication.test.ts tests/store.test.ts
git commit -m "feat: nomination queue and human-only adjudication with 1:1 share redemption"
```

---

### Task 7: Sandbox — vm execution with injected marketplace API

The agent's whole world. `node:vm` context exposing only the marketplace API bound to (store, agentId) plus async hooks for `subAgent`/`llm`. No `require`, `process`, `fs`, network. Code runs in an async IIFE; the timeout is enforced both by the vm option (sync busy-loops) and a host-side `Promise.race` (code stuck awaiting a hook).

**Files:**
- Create: `src/engine/sandbox.ts`
- Create: `tests/sandbox.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/sandbox.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store/store.js";
import { Sandbox } from "../src/engine/sandbox.js";

function makeSandbox(store: Store, timeoutMs = 2000) {
  return new Sandbox({
    store,
    agentId: "trader-1",
    subAgent: async (prompt: string) => ({ echo: prompt }),
    llm: async (prompt: string) => `llm:${prompt}`,
    timeoutMs,
  });
}

describe("Sandbox", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
    store.ensureAgent("trader-1");
  });

  it("executes code against the real store", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`
      const { claimIds } = ideas.propose({ title: "Test Idea", summary: "s", body: "b", claims: ["c1"] });
      evidence.submit(claimIds[0], "some proof", "supporting");
      market.buyYes(claimIds[0], 20);
      print("price:", market.price(claimIds[0]).toFixed(2));
    `);
    expect(r.error).toBeNull();
    expect(r.stdout).toMatch(/price: 0\.5/); // 20 shares at b=100 → ~0.55
    expect(store.counters().ideas).toBe(1);
    expect(store.getPositions("trader-1")).toHaveLength(1);
  });

  it("has NO escape hatches", async () => {
    const sb = makeSandbox(store);
    for (const code of ["require('fs')", "process.exit(1)", "globalThis.process.exit(1)"]) {
      const r = await sb.execute(code);
      expect(r.error).toMatch(/not defined|Cannot read|undefined/);
    }
  });

  it("returns thrown errors as text, does not crash", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`market.buyYes("no-such-claim", 5)`);
    expect(r.error).toMatch(/no market/i);
  });

  it("supports await of subAgent and llm hooks", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`
      const v = await subAgent("evaluate this");
      const t = await llm("quick question");
      print(JSON.stringify(v), t);
    `);
    expect(r.stdout).toContain('{"echo":"evaluate this"}');
    expect(r.stdout).toContain("llm:quick question");
  });

  it("captures Final and reports hasFinal", async () => {
    const sb = makeSandbox(store);
    const r1 = await sb.execute(`print("working")`);
    expect(r1.hasFinal).toBe(false);
    const r2 = await sb.execute(`Final = { summary: "done" }`);
    expect(r2.hasFinal).toBe(true);
    expect(sb.getFinal()).toEqual({ summary: "done" });
  });

  it("times out runaway code", async () => {
    const sb = makeSandbox(store, 300);
    const r = await sb.execute(`while(true){}`);
    expect(r.timedOut).toBe(true);
  }, 10_000);

  it("state() reports counters and own wallet, never the corpus", async () => {
    const sb = makeSandbox(store);
    const r = await sb.execute(`print(JSON.stringify(state()))`);
    expect(r.stdout).toContain('"balance":1000');
    expect(r.stdout).toContain('"ideas":0');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/engine/sandbox.ts**

```typescript
import { createContext, runInContext, type Context } from "node:vm";
import type { Store } from "../store/store.js";

const TRUNCATE_STDOUT = 1000;

export interface SandboxConfig {
  store: Store;
  agentId: string;
  subAgent: (prompt: string) => Promise<unknown>;
  llm: (prompt: string) => Promise<string>;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stdoutTruncated: string;
  error: string | null;
  timedOut: boolean;
  hasFinal: boolean;
}

export class Sandbox {
  private context: Context;
  private box: Record<string, unknown>;
  private captured = "";
  private timeoutMs: number;

  constructor(cfg: SandboxConfig) {
    const { store, agentId } = cfg;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;

    const print = (...args: unknown[]) => {
      this.captured += args
        .map(a => (typeof a === "object" && a !== null ? JSON.stringify(a).slice(0, 400) : String(a)))
        .join(" ") + "\n";
    };

    this.box = {
      // Safe globals only. NO require/process/fs/fetch.
      JSON, Math, Array, Object, String, Number, Boolean, Map, Set, Promise,
      parseFloat, parseInt, isNaN,
      print,
      console: { log: print },

      ideas: {
        propose: (input: { title: string; summary: string; body: string; claims: string[]; parentId?: string }) =>
          store.propose({ ...input, author: agentId }),
        list: () => store.listIdeas(),
        get: (id: string) => store.getIdea(id),
      },
      market: {
        buyYes: (claimId: string, shares: number) => store.placeOrder({ claimId, agentId, side: "yes", shares }),
        buyNo: (claimId: string, shares: number) => store.placeOrder({ claimId, agentId, side: "no", shares }),
        price: (claimId: string) => {
          const m = store.getMarket(claimId);
          if (!m) throw new Error(`no market for ${claimId}`);
          return m.yesPrice;
        },
        positions: () => store.getPositions(agentId),
      },
      evidence: {
        submit: (claimId: string, excerpt: string, stance: "supporting" | "counter", relevance?: number) =>
          store.addEvidence({ claimId, excerpt, stance, relevance, submittedBy: agentId }),
        list: (claimId: string) =>
          store.listEvidence(claimId).map(e => ({ excerpt: e.excerpt, stance: e.stance, relevance: e.relevance })),
      },
      state: () => {
        const me = store.getAgent(agentId);
        return { ...store.counters(), balance: me?.balance ?? 0, reputation: me?.reputation ?? 0.5 };
      },
      subAgent: (prompt: string) => cfg.subAgent(String(prompt)),
      llm: (prompt: string) => cfg.llm(String(prompt)),
      Final: undefined as unknown,
    };

    this.context = createContext(this.box, { codeGeneration: { strings: false, wasm: false } });
  }

  async execute(code: string): Promise<ExecResult> {
    this.captured = "";
    let error: string | null = null;
    let timedOut = false;

    const wrapped = `(async () => {\n${code}\n})()`;

    try {
      const run = runInContext(wrapped, this.context, { timeout: this.timeoutMs }) as Promise<unknown>;
      await Promise.race([
        run,
        new Promise((_, reject) => setTimeout(() => reject(new Error("__SANDBOX_TIMEOUT__")), this.timeoutMs)),
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("__SANDBOX_TIMEOUT__") || msg.includes("timed out")) {
        timedOut = true;
        error = `[TIMEOUT after ${this.timeoutMs / 1000}s]`;
      } else {
        error = msg;
      }
    }

    const stdout = this.captured + (error ? `\n[ERROR: ${error}]` : "");
    const hasFinal = this.box["Final"] !== undefined && this.box["Final"] !== null;
    const stdoutTruncated = stdout.length > TRUNCATE_STDOUT
      ? stdout.slice(0, TRUNCATE_STDOUT) + `\n... [${stdout.length} total chars]`
      : stdout;

    return { stdout, stdoutTruncated, error, timedOut, hasFinal };
  }

  getFinal(): unknown {
    return this.box["Final"];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sandbox.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/sandbox.ts tests/sandbox.test.ts
git commit -m "feat: vm sandbox exposing store-backed marketplace API to agent code"
```

---

### Task 8: Codegen — Ax signatures, providers, code extraction

**Files:**
- Create: `src/engine/codegen.ts`
- Create: `tests/codegen.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/codegen.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/codegen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/engine/codegen.ts**

```typescript
import { ai, ax } from "@ax-llm/ax";
import type { CodeGenerator, LeafEvaluator } from "./agent.js";

export type AxLLM = ReturnType<typeof ai>;

export interface Provider { name: string; llm: AxLLM }

/** AxAI instance per provider with an env key set. DeepSeek first: it is the cheap default. */
export function buildProviders(env: Record<string, string | undefined> = process.env): Provider[] {
  const defs: Array<{ name: string; key: string }> = [
    { name: "deepseek", key: "DEEPSEEK_API_KEY" },
    { name: "mistral", key: "MISTRAL_API_KEY" },
    { name: "anthropic", key: "ANTHROPIC_API_KEY" },
    { name: "openai", key: "OPENAI_API_KEY" },
  ];
  return defs
    .filter(d => env[d.key])
    .map(d => ({ name: d.name, llm: ai({ name: d.name as Parameters<typeof ai>[0]["name"], apiKey: env[d.key]! }) }));
}

export const SANDBOX_API_DOC = `You write JavaScript executed in a sandbox. Available API (top-level await works):
- ideas.propose({title, summary, body, claims: [string]}) -> {ideaId, claimIds}  // propose an idea; each claim gets a market
- ideas.list() -> [{id, title, claimIds}]
- ideas.get(id) -> {id, title, summary, body, claimIds}
- market.buyYes(claimId, shares) -> {cost, yesPrice}  // stake tokens that claim is TRUE; cost is deducted from your balance
- market.buyNo(claimId, shares) -> {cost, yesPrice}   // stake that it is FALSE
- market.price(claimId) -> number                      // current YES price in (0,1); THE signal
- market.positions() -> your holdings
- evidence.submit(claimId, excerpt, stance, relevance?) // stance: "supporting" | "counter"
- evidence.list(claimId) -> [{excerpt, stance, relevance}]
- state() -> {ideas, claims, openMarkets, resolvedMarkets, balance, reputation}  // YOUR wallet
- await subAgent(prompt) -> verdict                    // delegate a sub-question; returns structured result
- await llm(prompt) -> string                          // one-shot LM call
- print(...) // captured; the ONLY way to pass observations to your own next iteration
- Final = {...} // set when your work is done; ends your loop

RULES:
1. Output ONLY runnable JavaScript. No markdown prose.
2. Never dump large data; print short observations.
3. You cannot settle markets. A human adjudicates. Your job: make prices informative.
4. Stake proportional to your confidence. Being early and right is what pays.`;

export const writeCodeSig = ax(
  "task:string, persona:string, stateMetadata:string, historyText:string -> code:string \"runnable JavaScript for the sandbox\"",
);

export const evaluateClaimSig = ax(
  "claimText:string, supportingEvidence:string, counterEvidence:string -> confidence:number \"probability 0-1 that the claim is true\", reasoning:string",
);

/** LLM output -> runnable code: prefer the first fenced block, else strip stray fences. */
export function extractCode(response: string): string {
  const fenced = response.match(/```(?:javascript|js)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  return response.replace(/^```(?:javascript|js)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

export function makeCodeGenerator(llm: AxLLM): CodeGenerator {
  return async (inputs) => {
    const res = await writeCodeSig.forward(llm, {
      task: `${inputs.task}\n\n${SANDBOX_API_DOC}`,
      persona: inputs.persona,
      stateMetadata: inputs.stateMetadata,
      historyText: inputs.historyText || "(first iteration)",
    });
    return extractCode(String(res.code ?? ""));
  };
}

export function makeLeafEvaluator(llm: AxLLM): LeafEvaluator {
  return async (prompt) => {
    const res = await evaluateClaimSig.forward(llm, {
      claimText: prompt,
      supportingEvidence: "(see claim text)",
      counterEvidence: "(see claim text)",
    });
    const confidence = Math.max(0, Math.min(1, Number(res.confidence ?? 0.5)));
    return { confidence, reasoning: String(res.reasoning ?? "") };
  };
}

export function makeLlm(llm: AxLLM): (prompt: string) => Promise<string> {
  const sig = ax("prompt:string -> response:string");
  return async (prompt) => String((await sig.forward(llm, { prompt })).response ?? "");
}
```

(Note: this file imports types from `./agent.js`, created in Task 9. If executing strictly in order, expect the typecheck to pass only after Task 9 — or create Task 9's `agent.ts` type stubs first. Recommended execution order if this bothers you: run Task 9 Steps 1–3 before this task's typecheck.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/codegen.test.ts`
Expected: all PASS. If `ai({ name: "deepseek", ... })` rejects the provider name at the type level, check the accepted names in the `@ax-llm/ax` typings and adjust the `defs` list — provider naming is the most drift-prone part of the Ax API.

- [ ] **Step 5: Commit**

```bash
git add src/engine/codegen.ts tests/codegen.test.ts
git commit -m "feat: Ax signatures, provider factory, code extraction"
```

---

### Task 9: RlmAgent — the recursive loop

One class, no root/sub distinction. Takes a `CodeGenerator` function (production: `makeCodeGenerator`; tests: scripted) so the loop is testable without network. `subAgent()` spawns a child `RlmAgent` with the same wallet at `depth+1`; at `maxDepth` it calls the `LeafEvaluator` instead.

**Files:**
- Create: `src/engine/agent.ts`
- Create: `tests/agent.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/agent.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Store } from "../src/store/store.js";
import { RlmAgent, type CodeGenerator, type LeafEvaluator } from "../src/engine/agent.js";

const noopLeaf: LeafEvaluator = async () => ({ confidence: 0.5, reasoning: "none" });
const noopLlm = async (p: string) => `re:${p}`;

function scripted(blocks: string[]): CodeGenerator {
  let i = 0;
  return async () => blocks[Math.min(i++, blocks.length - 1)];
}

function baseConfig(store: Store, codegen: CodeGenerator) {
  return {
    agentId: "t1", persona: "skeptic", task: "deliberate",
    store, codegen, leafEvaluator: noopLeaf, llm: noopLlm,
    maxIterations: 10, maxDepth: 2, maxSubAgentCalls: 4, sandboxTimeoutMs: 2000,
  };
}

describe("RlmAgent", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  it("runs code each iteration and stops when Final is set", async () => {
    const agent = new RlmAgent(baseConfig(store, scripted([
      `ideas.propose({ title: "A", summary: "s", body: "", claims: ["c"] }); print("proposed");`,
      `Final = { summary: "done" };`,
    ])));
    const run = await agent.run();
    expect(run.final).toEqual({ summary: "done" });
    expect(run.iterations).toHaveLength(2);
    expect(store.counters().ideas).toBe(1);
  });

  it("stops at maxIterations without Final", async () => {
    const agent = new RlmAgent({ ...baseConfig(store, scripted([`print("loop");`])), maxIterations: 3 });
    const run = await agent.run();
    expect(run.final).toBeNull();
    expect(run.iterations).toHaveLength(3);
  });

  it("feeds errors back as history so the agent can self-correct", async () => {
    const codegen = vi.fn<CodeGenerator>()
      .mockResolvedValueOnce(`market.buyYes("missing", 5)`)
      .mockResolvedValueOnce(`Final = { recovered: true }`);
    const agent = new RlmAgent(baseConfig(store, codegen));
    await agent.run();
    const secondCallInputs = codegen.mock.calls[1][0];
    expect(secondCallInputs.historyText).toMatch(/ERROR.*no market/i);
  });

  it("subAgent at maxDepth degrades to leaf evaluation, sharing the wallet", async () => {
    store.ensureAgent("t1");
    const leaf = vi.fn<LeafEvaluator>().mockResolvedValue({ confidence: 0.9, reasoning: "leaf" });
    const agent = new RlmAgent({
      ...baseConfig(store, scripted([
        `const v = await subAgent("is this claim true?"); print("conf:" + v.confidence); Final = v;`,
      ])),
      leafEvaluator: leaf,
      maxDepth: 0, // depth 0 IS the cap -> leaf immediately
    });
    const run = await agent.run();
    expect(leaf).toHaveBeenCalledOnce();
    expect(run.final).toEqual({ confidence: 0.9, reasoning: "leaf" });
    // shared wallet: only one agent row exists
    const n = (store.db.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("subAgent below maxDepth spawns a full child agent", async () => {
    const codegen: CodeGenerator = async (inputs) =>
      inputs.task === "child question"
        ? `Final = { fromChild: true };`
        : `const v = await subAgent("child question"); Final = { child: v };`;
    const agent = new RlmAgent({ ...baseConfig(store, codegen), maxDepth: 1 });
    const run = await agent.run();
    expect(run.final).toEqual({ child: { fromChild: true } });
  });

  it("enforces maxSubAgentCalls per iteration", async () => {
    const agent = new RlmAgent({
      ...baseConfig(store, scripted([
        `for (let i = 0; i < 5; i++) await subAgent("q" + i); Final = {done: true};`,
      ])),
      maxDepth: 0, maxSubAgentCalls: 3, maxIterations: 2,
    });
    const run = await agent.run();
    expect(run.iterations[0].result.stdout).toMatch(/sub-agent budget/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/engine/agent.ts**

```typescript
import { Sandbox, type ExecResult } from "./sandbox.js";
import type { Store } from "../store/store.js";

export interface CodeGenInputs { task: string; persona: string; stateMetadata: string; historyText: string }
export type CodeGenerator = (inputs: CodeGenInputs) => Promise<string>;
export type LeafEvaluator = (prompt: string) => Promise<{ confidence: number; reasoning: string }>;

export interface AgentConfig {
  agentId: string;
  persona: string;
  task: string;
  store: Store;
  codegen: CodeGenerator;
  leafEvaluator: LeafEvaluator;
  llm: (prompt: string) => Promise<string>;
  maxIterations: number;
  maxDepth: number;
  maxSubAgentCalls: number;
  sandboxTimeoutMs: number;
  depth?: number;
  onIteration?: (agentId: string, iteration: number) => void;
}

export interface AgentRun {
  agentId: string;
  final: unknown;
  iterations: Array<{ code: string; result: ExecResult }>;
}

const HISTORY_ENTRY_CHARS = 300;
const HISTORY_ENTRIES = 8;

export class RlmAgent {
  private cfg: AgentConfig;
  private depth: number;

  constructor(cfg: AgentConfig) {
    this.cfg = cfg;
    this.depth = cfg.depth ?? 0;
  }

  async run(): Promise<AgentRun> {
    const { store, agentId } = this.cfg;
    store.ensureAgent(agentId);

    let subCallsThisIteration = 0;

    const subAgent = async (prompt: string): Promise<unknown> => {
      if (subCallsThisIteration >= this.cfg.maxSubAgentCalls) {
        throw new Error(`sub-agent budget exhausted (max ${this.cfg.maxSubAgentCalls} per iteration)`);
      }
      subCallsThisIteration++;
      if (this.depth >= this.cfg.maxDepth) {
        // Leaf: plain structured evaluation, the RLM base case.
        return this.cfg.leafEvaluator(prompt);
      }
      const child = new RlmAgent({
        ...this.cfg,
        task: prompt,
        depth: this.depth + 1,
        // Same agentId: a sub-agent is the parent's delegate, sharing its wallet.
      });
      const childRun = await child.run();
      return childRun.final;
    };

    const sandbox = new Sandbox({
      store,
      agentId,
      subAgent,
      llm: this.cfg.llm,
      timeoutMs: this.cfg.sandboxTimeoutMs,
    });

    const history: string[] = [];
    const iterations: Array<{ code: string; result: ExecResult }> = [];

    for (let i = 0; i < this.cfg.maxIterations; i++) {
      subCallsThisIteration = 0;
      const code = await this.cfg.codegen({
        task: this.cfg.task,
        persona: this.cfg.persona,
        stateMetadata: this.buildMetadata(),
        historyText: history.slice(-HISTORY_ENTRIES).join("\n"),
      });

      const result = await sandbox.execute(code);
      iterations.push({ code, result });
      history.push(`[code ${i}] ${code.slice(0, HISTORY_ENTRY_CHARS)}`);
      history.push(`[out ${i}] ${result.stdoutTruncated.slice(0, HISTORY_ENTRY_CHARS)}`);
      this.cfg.onIteration?.(agentId, i);

      if (result.hasFinal) {
        return { agentId, final: sandbox.getFinal(), iterations };
      }
    }
    return { agentId, final: null, iterations };
  }

  /** Constant-size view of the world: counters + own wallet + a few hot prices. NEVER the corpus. */
  private buildMetadata(): string {
    const { store, agentId } = this.cfg;
    const c = store.counters();
    const me = store.getAgent(agentId);
    const hot = store.listIdeas().slice(-3)
      .flatMap(i => i.claimIds.slice(0, 2))
      .map(cid => `${cid}=${store.getMarket(cid)?.yesPrice.toFixed(2) ?? "?"}`)
      .join(" ");
    return `ideas=${c.ideas} claims=${c.claims} open=${c.openMarkets} resolved=${c.resolvedMarkets} ` +
      `balance=${me?.balance.toFixed(0)} reputation=${me?.reputation.toFixed(2)} depth=${this.depth} prices: ${hot}`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent.test.ts && npm run typecheck`
Expected: all PASS (typecheck now also covers Task 8's import of these types).

- [ ] **Step 5: Commit**

```bash
git add src/engine/agent.ts tests/agent.test.ts
git commit -m "feat: recursive RlmAgent loop with shared-wallet subAgent and budget caps"
```

---

### Task 10: Harness — runSession, nomination scan, budgets

**Files:**
- Create: `src/engine/harness.ts`
- Create: `tests/harness.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/harness.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/store.js";
import { runSession, scanNominations } from "../src/engine/harness.js";
import type { CodeGenerator } from "../src/engine/agent.js";

const noopLeaf = async () => ({ confidence: 0.5, reasoning: "n" });
const noopLlm = async () => "ok";

describe("scanNominations", () => {
  it("nominates threshold-crossers and stalled markets, never untouched ones", () => {
    const store = new Store(":memory:");
    store.ensureAgent("a");
    const [hot, stale, calm] = store.propose({
      title: "T", summary: "s", body: "", claims: ["c1", "c2", "c3"], author: "a",
    }).claimIds;

    store.currentIteration = 0;
    store.placeOrder({ claimId: hot, agentId: "a", side: "yes", shares: 250 }); // price > 0.85
    store.placeOrder({ claimId: stale, agentId: "a", side: "yes", shares: 10 }); // mild, then silence
    // calm: no orders at all -> never nominated
    void calm;

    store.currentIteration = 20; // stale has had no orders for >= 10 iterations
    scanNominations(store, { stallIterations: 10 });

    const pending = store.pendingNominations().map(n => n.claimId).sort();
    expect(pending).toEqual([hot, stale].sort());
  });
});

describe("runSession", () => {
  it("runs N agents against one store and returns their runs", async () => {
    const store = new Store(":memory:");
    const mkGen = (title: string): CodeGenerator => {
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
    const result = await runSession({
      store,
      topic: "test topic",
      traders: [
        { agentId: "alpha", persona: "skeptic", codegen: mkGen("Idea Alpha") },
        { agentId: "beta", persona: "optimist", codegen: mkGen("Idea Beta") },
      ],
      leafEvaluator: noopLeaf,
      llm: noopLlm,
      maxIterations: 5, maxDepth: 1, maxSubAgentCalls: 3, sandboxTimeoutMs: 2000,
      stallIterations: 10,
    });
    expect(result.runs).toHaveLength(2);
    expect(result.runs.every(r => r.final !== null)).toBe(true);
    expect(store.counters().ideas).toBe(2);
    expect(store.getPositions("alpha")).toHaveLength(1);
    expect(store.getPositions("beta")).toHaveLength(1);
  });

  it("an agent whose codegen throws does not sink the session", async () => {
    const store = new Store(":memory:");
    const bad: CodeGenerator = async () => { throw new Error("provider down"); };
    const good: CodeGenerator = async () => `Final = { ok: true };`;
    const result = await runSession({
      store, topic: "t",
      traders: [
        { agentId: "bad", persona: "p", codegen: bad },
        { agentId: "good", persona: "p", codegen: good },
      ],
      leafEvaluator: noopLeaf, llm: noopLlm,
      maxIterations: 3, maxDepth: 1, maxSubAgentCalls: 3, sandboxTimeoutMs: 2000,
      stallIterations: 10,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].agentId).toBe("bad");
    expect(result.failures[0].error).toMatch(/provider down/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/harness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create src/engine/harness.ts**

```typescript
import { RlmAgent, type AgentRun, type CodeGenerator, type LeafEvaluator } from "./agent.js";
import type { Store } from "../store/store.js";

export interface TraderConfig { agentId: string; persona: string; codegen: CodeGenerator }

export interface SessionConfig {
  store: Store;
  topic: string;
  traders: TraderConfig[];
  leafEvaluator: LeafEvaluator;
  llm: (prompt: string) => Promise<string>;
  maxIterations: number;
  maxDepth: number;
  maxSubAgentCalls: number;
  sandboxTimeoutMs: number;
  stallIterations: number;
}

export interface SessionResult {
  runs: AgentRun[];
  failures: Array<{ agentId: string; error: string }>;
}

const PRICE_HI = 0.85;
const PRICE_LO = 0.15;

/** Nominate claims for human adjudication. NEVER settles anything. */
export function scanNominations(store: Store, opts: { stallIterations: number }): void {
  const rows = store.db.prepare(`
    SELECT m.claim_id AS claimId,
           (SELECT MAX(o.iteration) FROM orders o WHERE o.claim_id = m.claim_id) AS lastIteration,
           (SELECT COUNT(*) FROM orders o WHERE o.claim_id = m.claim_id) AS orderCount
    FROM markets m
    WHERE m.resolution IS NULL
  `).all() as Array<{ claimId: string; lastIteration: number | null; orderCount: number }>;

  for (const r of rows) {
    if (r.orderCount === 0) continue; // untouched markets are not adjudication-worthy
    const price = store.getMarket(r.claimId)!.yesPrice;
    if (price >= PRICE_HI || price <= PRICE_LO) {
      store.nominate(r.claimId, "threshold");
    } else if (r.lastIteration !== null && store.currentIteration - r.lastIteration >= opts.stallIterations) {
      store.nominate(r.claimId, "stalled");
    }
  }
}

export async function runSession(cfg: SessionConfig): Promise<SessionResult> {
  const { store } = cfg;
  store.currentIteration = 0;

  const onIteration = () => {
    store.currentIteration += 1;
    scanNominations(store, { stallIterations: cfg.stallIterations });
  };

  const settled = await Promise.allSettled(
    cfg.traders.map(t =>
      new RlmAgent({
        agentId: t.agentId,
        persona: t.persona,
        task: cfg.topic,
        store,
        codegen: t.codegen,
        leafEvaluator: cfg.leafEvaluator,
        llm: cfg.llm,
        maxIterations: cfg.maxIterations,
        maxDepth: cfg.maxDepth,
        maxSubAgentCalls: cfg.maxSubAgentCalls,
        sandboxTimeoutMs: cfg.sandboxTimeoutMs,
        onIteration,
      }).run(),
    ),
  );

  const runs: AgentRun[] = [];
  const failures: Array<{ agentId: string; error: string }> = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") runs.push(s.value);
    else failures.push({ agentId: cfg.traders[i].agentId, error: String(s.reason) });
  });

  scanNominations(store, { stallIterations: cfg.stallIterations });
  return { runs, failures };
}
```

- [ ] **Step 4: Update src/index.ts exports**

Replace the contents of `src/index.ts` with:

```typescript
export * from "./types/deliberation.js";
export * from "./market/lmsr.js";
export * from "./store/store.js";
export * from "./engine/sandbox.js";
export * from "./engine/agent.js";
export * from "./engine/harness.js";
export * from "./engine/codegen.js";
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/harness.ts tests/harness.test.ts src/index.ts
git commit -m "feat: session harness with concurrent traders and nomination scan"
```

---

### Task 11: Live smoke test

Prove the whole engine works against a live LLM. Self-skips without a key.

**Files:**
- Create: `tests/live-smoke.test.ts`

- [ ] **Step 1: Write the live smoke test**

Create `tests/live-smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { Store } from "../src/store/store.js";
import { runSession } from "../src/engine/harness.js";
import { buildProviders, makeCodeGenerator, makeLeafEvaluator, makeLlm } from "../src/engine/codegen.js";

const KEY = process.env.DEEPSEEK_API_KEY;

describe.skipIf(!KEY)("live smoke: one tiny session on DeepSeek", () => {
  it("agents propose, trade, and the store fills up", async () => {
    const providers = buildProviders();
    const llm = providers[0].llm;
    const store = new Store(":memory:");

    const result = await runSession({
      store,
      topic: "Deliberate: 'TypeScript is a better choice than Python for new agent frameworks in 2026.' " +
        "Propose 1 idea with 2 claims, submit one piece of evidence per claim, then place market orders sized by your confidence, then set Final.",
      traders: [
        { agentId: "live-skeptic", persona: "ruthless skeptic; you demand evidence", codegen: makeCodeGenerator(llm) },
        { agentId: "live-optimist", persona: "enthusiastic generalist; you look for upside", codegen: makeCodeGenerator(llm) },
      ],
      leafEvaluator: makeLeafEvaluator(llm),
      llm: makeLlm(llm),
      maxIterations: 6, maxDepth: 1, maxSubAgentCalls: 3, sandboxTimeoutMs: 30_000,
      stallIterations: 10,
    });

    // The engine must produce real state even if agents are imperfect.
    expect(result.runs.length + result.failures.length).toBe(2);
    expect(store.counters().ideas).toBeGreaterThanOrEqual(1);
    const orders = store.db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number };
    expect(orders.n).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
```

- [ ] **Step 2: Run unit tests (always) and the live test (if key available)**

Run: `npx vitest run && npm run typecheck`
Expected: unit tests PASS; live test SKIPPED without `DEEPSEEK_API_KEY`.
With the key: `npx vitest run tests/live-smoke.test.ts` — expected PASS in under 5 minutes. If agents emit malformed code the run still passes the engine assertions as long as state was produced; persistent emptiness means the `SANDBOX_API_DOC` prompt needs tuning — iterate on the doc string, not the engine.

- [ ] **Step 3: Commit**

```bash
git add tests/live-smoke.test.ts
git commit -m "test: key-gated live smoke session on DeepSeek"
```

---

### Task 12: Phase close-out

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: everything green.

- [ ] **Step 2: File bd issues for Phase 2 and 3**

```bash
bd create "Phase 2: resident service + web UI (adjudication surface, WebSocket state, MCP rewire)" -d "Per docs/superpowers/specs/2026-06-10-marketplace-of-ideas-ax-design.md. Also delete src/evaluate/sub-agent.ts when MCP is rewired."
bd create "Phase 3: GEPA pass on evaluateClaim from human adjudications" -d "AxGEPA({studentAI}).compile(generator, examples, metric). Examples from store.listTrainingExamples(); metric = Brier-style calibration against human outcome. Report before/after."
```

- [ ] **Step 3: Final commit and session-close protocol**

```bash
git add -A
git commit -m "chore: phase 1 engine complete"
```

Then follow CLAUDE.md session completion. Note: no git remote exists yet — flag to the user that `git push` requires creating one.

---

## Self-Review (completed at plan-writing time)

- **Spec coverage:** store/schema (T4–6), LMSR fixes incl. both economic bugs (T3, T5), claim-ID bug (T4 test), sandbox safety (T7), Ax layer (T8, T11), recursive agent + shared wallet + leaf degradation (T9), multi-trader sessions + budgets + nomination incl. stall rule (T10), human-only adjudication + training examples (T6), live smoke (T11), legacy deletion incl. keeping evaluate/mcp pair for Phase 2 (T2). Web UI, MCP rewire, GEPA run: later phases by design, bd issues filed (T12).
- **Type consistency:** `Side` from lmsr.ts used in store; `CodeGenerator`/`LeafEvaluator` defined in agent.ts, consumed by codegen.ts and harness; `ExecResult` from sandbox.ts used in agent.ts. `store.db` is intentionally public (readonly) for harness SQL and tests. Task 8↔9 circular-order note is flagged inline.
- **Placeholder scan:** every code step contains complete code; no TBDs. One deliberate `it.skip` in Task 5, explicitly unskipped in Task 6 Step 4.
