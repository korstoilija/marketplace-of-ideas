# Observability + Model Diversity (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Work alone on a clean `main`. Commit per task, not squashed.

**Goal:** Make the marketplace measurable and its traders genuinely diverse: persist full agent transcripts (the code agents write + what it printed), expose calibration metrics that test whether prices predict the human's rulings, and add Claude/Codex subscription CLIs as trader model families alongside DeepSeek.

**Architecture:** Transcripts flow through a new optional `recordIteration` hook on `RlmAgent` (inherited by recursive children), wired by the harness into two new tables (`sessions`, `agent_iterations`). Metrics are a pure function over the store (`computeMetrics`) served at `/api/metrics`. CLI traders are just `CodeGenerator` functions that spawn `claude -p` / `codex exec` via `execFile` (argument arrays, never a shell — prompts contain agent-authored text); they are opt-in via `MP_CLI_TRADERS`. GEPA's student stays the API model; CLI models are traders only.

**Security note (enforced rule for this plan):** all subprocess invocation uses `execFile` with argument arrays. `exec()` (shell-interpreting) is FORBIDDEN anywhere in this codebase — prompts contain agent-authored text and must never touch a shell.

**Tech Stack:** existing Phase 1–3 stack; `node:child_process.execFile`; no new npm dependencies.

**File structure (end state):**

```
src/
  store/db.ts               (modified: sessions + agent_iterations tables)
  store/store.ts            (modified: session/transcript methods)
  engine/agent.ts           (modified: recordIteration hook)
  engine/harness.ts         (modified: session row + recorder wiring)
  engine/cli-provider.ts    (new: CLI-backed CodeGenerator + detection)
  server/metrics.ts         (new: computeMetrics)
  server/service.ts         (modified: residual fix, /api/sessions, /api/metrics, CLI roster)
  index.ts                  (modified: export new modules)
public/
  index.html                (modified: metrics + sessions sections)
  app.js                    (modified: history-refresh fix, metrics/sessions rendering)
tests/
  fixtures/fake-claude.cjs  (new)
  fixtures/fake-codex.cjs   (new)
  transcripts.test.ts       (new)
  metrics.test.ts           (new)
  cli-provider.test.ts      (new)
  service.test.ts           (modified: sync-throw fix, sessions/metrics endpoints)
  cli-live.test.ts          (new, double-gated)
```

**Conventions for every task:** Run tests with `npx vitest run <file>`. Typecheck with `npm run typecheck`. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: bd issue + the two Phase 3 review residuals

**Files:**
- Modify: `src/server/service.ts`, `public/app.js`
- Modify: `tests/service.test.ts` (append)

- [ ] **Step 1: Claim the bd issue**

```bash
bd update Marketplace-2km --claim
```

- [ ] **Step 2: Fix sync-throw residual**

In `src/server/service.ts`, in the POST `/api/optimize` handler, change:
```typescript
const started = optimize.start(gepaRunner());
```
to:
```typescript
const started = optimize.start(Promise.resolve().then(() => gepaRunner()));
```

And make `defaultGepaRunner` async:
```typescript
const defaultGepaRunner = async (): Promise<GepaReport> => {
```

- [ ] **Step 3: Fix history-refresh residual**

In `public/app.js`, add before `function render(s)`:
```javascript
let wasOptimizing = false;
```
And inside `render(s)`, after setting `$("gepaStatus").textContent`:
```javascript
if (wasOptimizing && !s.optimize.running) loadGepaHistory();
wasOptimizing = s.optimize.running;
```

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

```bash
git add src/server/service.ts public/app.js
git commit -m "fix: sync-throw runners flow through AsyncJob; GEPA history refreshes on completion"
```

---

### Task 2: Store — sessions and agent_iterations tables

**Files:**
- Modify: `src/store/db.ts`, `src/store/store.ts`
- Create: `tests/transcripts.test.ts`

- [ ] **Step 1: Add tables to db.ts**

In `src/store/db.ts`, append to `TABLES` array:
```typescript
  `CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS agent_iterations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    agent_id TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    iteration INTEGER NOT NULL,
    code TEXT NOT NULL,
    stdout TEXT NOT NULL,
    timed_out INTEGER NOT NULL DEFAULT 0,
    has_final INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
```

- [ ] **Step 2: Add store methods** (before `close()` in store.ts)

```typescript
  createSession(topic: string, configJson = "{}"): number {
    const r = this.db.prepare("INSERT INTO sessions (topic, config_json, started_at) VALUES (?, ?, ?)").run(topic, configJson, Date.now());
    return Number(r.lastInsertRowid);
  }
  endSession(sessionId: number): void {
    this.db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?").run(Date.now(), sessionId);
  }
  recordAgentIteration(rec: { sessionId: number; agentId: string; depth: number; iteration: number; code: string; stdout: string; timedOut: boolean; hasFinal: boolean }): void {
    this.db.prepare("INSERT INTO agent_iterations (session_id, agent_id, depth, iteration, code, stdout, timed_out, has_final, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(rec.sessionId, rec.agentId, rec.depth, rec.iteration, rec.code.slice(0, 10_000), rec.stdout.slice(0, 5000), rec.timedOut ? 1 : 0, rec.hasFinal ? 1 : 0, Date.now());
  }
  listSessions(): Array<{ id: number; topic: string; startedAt: number; endedAt: number | null; iterations: number; agents: number }> {
    const rows = this.db.prepare(`SELECT s.id, s.topic, s.started_at, s.ended_at, (SELECT COUNT(*) FROM agent_iterations ai WHERE ai.session_id = s.id) AS iterations, (SELECT COUNT(DISTINCT ai.agent_id) FROM agent_iterations ai WHERE ai.session_id = s.id) AS agents FROM sessions s ORDER BY s.id DESC`).all() as Array<{ id: number; topic: string; started_at: number; ended_at: number | null; iterations: number; agents: number }>;
    return rows.map(r => ({ id: r.id, topic: r.topic, startedAt: r.started_at, endedAt: r.ended_at, iterations: r.iterations, agents: r.agents }));
  }
  getSessionIterations(sessionId: number): Array<{ agentId: string; depth: number; iteration: number; code: string; stdout: string; timedOut: boolean; hasFinal: boolean }> {
    const rows = this.db.prepare("SELECT agent_id, depth, iteration, code, stdout, timed_out, has_final FROM agent_iterations WHERE session_id = ? ORDER BY id").all(sessionId) as Array<{ agent_id: string; depth: number; iteration: number; code: string; stdout: string; timed_out: number; has_final: number }>;
    return rows.map(r => ({ agentId: r.agent_id, depth: r.depth, iteration: r.iteration, code: r.code, stdout: r.stdout, timedOut: r.timed_out === 1, hasFinal: r.has_final === 1 }));
  }
```

- [ ] **Step 3: Create tests/transcripts.test.ts**

```typescript
// Standard test file importing Store, testing createSession/endSession/recordAgentIteration/listSessions/getSessionIterations
// Key tests: round-trip, ordering, stdout cap at 5000, iteration counts
```

- [ ] **Step 4: Verify and commit**

```bash
git add src/store tests/transcripts.test.ts
git commit -m "feat: sessions and agent_iterations tables for transcript persistence"
```

---

### Task 3: Engine — recordIteration hook, harness wiring

**Files:**
- Modify: `src/engine/agent.ts`, `src/engine/harness.ts`
- Modify: `tests/transcripts.test.ts` (append)

- [ ] **Step 1: Add hook to AgentConfig**

In `src/engine/agent.ts`, add to `AgentConfig`:
```typescript
  recordIteration?: (rec: { agentId: string; depth: number; iteration: number; code: string; stdout: string; timedOut: boolean; hasFinal: boolean }) => void;
```
In `RlmAgent.run()`, inside the loop after `iterations.push({ code, result });`:
```typescript
      this.cfg.recordIteration?.({ agentId, depth: this.depth, iteration: i, code, stdout: result.stdout, timedOut: result.timedOut, hasFinal: result.hasFinal });
```

- [ ] **Step 2: Wire harness**

In `src/engine/harness.ts`:
- Add `sessionId: number;` to `SessionResult`
- In `runSession`, create session row + recorder closure
- Pass `recordIteration` to each `RlmAgent`
- Call `endSession` before return

- [ ] **Step 3: Append transcript flow test**

```typescript
// Test that runSession persists iterations including recursive children
```

- [ ] **Step 4: Verify and commit**

```bash
git add src/engine tests/transcripts.test.ts
git commit -m "feat: persist agent transcripts via recordIteration hook through recursion"
```

---

### Task 4: Service — /api/sessions endpoints

**Files:**
- Modify: `src/server/service.ts`
- Modify: `tests/service.test.ts` (append)

- [ ] **Step 1: Add routes**

```typescript
      if (u === "/api/sessions" && method === "GET") return json(res, { sessions: store.listSessions() });
      const sess = u.match(/^\/api\/sessions\/(\d+)$/);
      if (sess && method === "GET") {
        const id = Number(sess[1]);
        const meta = store.listSessions().find(s => s.id === id);
        if (!meta) return json(res, { error: `unknown session: ${id}` }, 404);
        return json(res, { session: meta, iterations: store.getSessionIterations(id) });
      }
```

---

### Task 5: Metrics — does the market predict the human?

**Files:**
- Create: `src/server/metrics.ts`
- Create: `tests/metrics.test.ts`
- Modify: `src/server/service.ts` (one route: `/api/metrics`)

Pure function over the store. Pre-ruling price from `priceHistory`, not resolved 1/0.

- [ ] **Step 1: Create src/server/metrics.ts**

```typescript
// computeMetrics(store) → { adjudicated, meanPriceTrue, meanPriceFalse, informativeness, calibration[], verdictVariance, reputationSpread }
// Calibration buckets: [0-0.2), [0.2-0.4), [0.4-0.6), [0.6-0.8), [0.8-1.0]
// Pre-ruling price = last point of priceHistory (not forced 1/0)
// Null for empty stores (not NaN)
```

- [ ] **Step 2: Add route** `GET /api/metrics` → `computeMetrics(store)`

---

### Task 6: UI — metrics panel and session transcript browser

**Files:**
- Modify: `public/index.html`, `public/app.js`

All rendering via `el()`/`textContent`. `innerHTML` banned.

- [ ] Add metrics section and sessions section to HTML
- [ ] Wire `loadMetrics()` and `loadSessions()` in app.js
- [ ] Wire transition detectors for metrics/sessions refresh
- [ ] Session click handler shows transcript (code + stdout per iteration)

---

### Task 7: CLI provider — claude/codex as CodeGenerators

**Files:**
- Create: `src/engine/cli-provider.ts`
- Create: `tests/fixtures/fake-claude.cjs`, `tests/fixtures/fake-codex.cjs`
- Create: `tests/cli-provider.test.ts`

`execFile` with argument arrays. Failures return survivable `print(...)` line.

```typescript
// makeCliCodeGenerator(kind: "claude" | "codex", opts?) → CodeGenerator
// claude: execFile(["claude", "-p", prompt, "--max-turns", "1"])
// codex: execFile(["codex", "exec", ...]) → read reply from -o file
// detectCli(binary): execFile(binary, ["--version"], 10s) → boolean
```

---

### Task 8: Trader roster — opt-in CLI traders + live smoke

**Files:**
- Modify: `src/server/service.ts` (defaultTraderFactory)
- Modify: `src/index.ts`
- Create: `tests/cli-live.test.ts`

CLI traders opt-in via `MP_CLI_TRADERS=claude,codex`. Extends roster: API providers + enabled CLIs.

---

### Task 9: Close-out

- Full verification: `npm run typecheck && npx vitest run && npm run build`
- Boot smoke: `MP_CLI_TRADERS=claude,codex npm start` boots clean
- `bd close Marketplace-2km`
- Final commit
