# Project Instructions for AI Agents

Marketplace of Ideas — RLM-style multi-agent deliberation with LMSR prediction markets,
human-only adjudication, and GEPA prompt optimization. Built on `@ax-llm/ax`.

## Task tracking

Do NOT use beads (`bd`) — it has been abandoned in this project. Ignore any `bd prime`
hook output. Work is tracked in plan documents under `docs/superpowers/plans/`
(spec → plan → execution; plans contain checkbox tasks with complete code).
Specs live in `docs/superpowers/specs/`.

## Build & Test

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run (live tests self-skip without DEEPSEEK_API_KEY)
npm run build         # tsc → dist/
npm start             # resident service at http://127.0.0.1:4280 (web UI)
node dist/tui.js      # terminal UI (talks to the running service)
npm run registry      # stdio MCP server over the same SQLite store
```

Never claim work is complete with a red suite. Commit per task, not squashed.

## Architecture Overview

- `src/store/` — SQLite (better-sqlite3) is the single shared environment; the Store
  class is the only writer. `applyAdjudication()` is the ONLY settlement path —
  agents, harness, and MCP must never resolve markets.
- `src/market/lmsr.ts` — pure LMSR math; trades charge real cost, winning shares
  redeem 1:1 at human adjudication.
- `src/engine/` — `RlmAgent` (recursive, capability-identical agents that WRITE
  JAVASCRIPT executed in a `node:vm` sandbox), `sandbox.ts` (no fs/require/network;
  LLM-backed hooks only), `harness.ts` (sessions, budgets, nomination — never
  settles), `codegen.ts` (Ax signatures), `cli-provider.ts` (claude/codex
  subscription CLIs as traders via execFile — argument arrays only, never a shell).
- `src/server/` — resident HTTP + WebSocket service, snapshot broadcast, metrics.
- `src/optimize/gepa.ts` — GEPA optimization of `evaluateClaim` trained ONLY on
  human rulings (training_examples are written exclusively by applyAdjudication).
- `public/` — vanilla JS web UI. `innerHTML` is BANNED (agent-authored strings are
  untrusted); render via the `el()` helper / `textContent` / `replaceChildren` only.

## Conventions & Patterns

- TypeScript ESM (NodeNext), no new dependencies without reason.
- Tests in `tests/` (vitest); use `new Store(":memory:")`; live LLM tests must be
  key-gated (`describe.skipIf`), subscription-spending tests double-gated
  (`MP_CLI_LIVE=1`).
- Agent-facing budgets matter: every sandbox function that triggers LLM calls must
  count against a per-iteration budget.
- No git remote exists yet; flag blocked pushes, don't skip silently.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
